import z from 'zod';
import prisma from '../config/database';
import { AppError } from '../utils/AppError';
import { i18n } from '../i18n/en';
import { PaystackService, computePaymentBreakdown } from './paystack';
import { AdminNotificationService } from './adminNotification';
import {
  TransactionStatus,
  TransactionType,
  RefundStatus,
  Receipt,
  Prisma,
} from '@prisma/client';

// ---------- ReqLike ------------------------------------------------------
type ReqLike = {
  user?: { id: number; role: string; email?: string };
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
};

// ---------- Zod ----------------------------------------------------------
export const RequestRefundSchema = z.object({
  originalTransactionId: z.coerce.number().int().positive(),
  requestedAmount: z.coerce.number().positive().finite(),
  reason: z.string().min(5, 'Refund reason must be at least 5 characters').trim().max(2000),
});

export const ApproveRefundSchema = z.object({}).strict().optional();

export const RejectRefundSchema = z.object({
  notes: z.string().min(3, 'Rejection notes are required and must be at least 3 characters').trim().max(2000),
});

export const ListRefundsSchema = z.object({
  page: z.coerce.number().int().min(1).max(100).default(1),
  pageSize: z.coerce.number().int().min(5).max(100).default(25),
  status: z.nativeEnum(RefundStatus).optional(),
  originalTransactionId: z.coerce.number().int().positive().optional(),
  studentId: z.coerce.number().int().positive().optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
});

export type RequestRefundInput = z.infer<typeof RequestRefundSchema>;
export type RejectRefundInput = z.infer<typeof RejectRefundSchema>;
export type ListRefundsQuery = z.infer<typeof ListRefundsSchema>;

// ---------- Helpers -------------------------------------------------------
async function writeAudit(
  req: ReqLike | undefined,
  data: {
    action: string;
    entityType: 'REFUND' | 'TRANSACTION' | 'RECEIPT' | 'INVOICE' | 'GENERAL_LEDGER';
    entityId: string | number;
    oldValue?: any;
    newValue?: any;
    details?: any;
  },
) {
  const userId = (req as any)?.user?.id ?? null;
  const ipRaw = (req as any)?.ip ?? (req as any)?.headers?.['x-forwarded-for'];
  const ipAddress = Array.isArray(ipRaw) ? ipRaw[0] ?? null : (typeof ipRaw === 'string' ? ipRaw.split(',')[0]?.trim() ?? null : null);
  const uaRaw = (req as any)?.headers?.['user-agent'];
  const userAgent = Array.isArray(uaRaw) ? uaRaw[0] ?? null : uaRaw ?? null;
  try {
    await prisma.auditLog.create({
      data: {
        userId,
        action: data.action,
        entityType: data.entityType,
        entityId: String(data.entityId),
        oldValue: data.oldValue != null ? (JSON.stringify(data.oldValue) as any) : null,
        newValue: data.newValue != null ? (JSON.stringify(data.newValue) as any) : null,
        details: data.details != null ? (JSON.stringify(data.details) as any) : null,
        ipAddress: typeof ipAddress === 'string' ? ipAddress : null,
        userAgent: typeof userAgent === 'string' ? userAgent : null,
      },
    });
  } catch {
    /* audit failures must never crash transaction workflows */
  }
}

function generateRefundNumber(now = new Date()): string {
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const rand = String(Math.floor(1000 + Math.random() * 9000));
  return `REF-${yyyy}${mm}${dd}-${rand}`;
}

async function getNextRefundNumber(
  txPrisma: Prisma.TransactionClient,
  now = new Date(),
): Promise<string> {
  for (let attempt = 0; attempt < 25; attempt++) {
    const candidate = generateRefundNumber(now);
    const existing = await txPrisma.refund.findUnique({
      where: { refundNumber: candidate },
      select: { id: true },
    });
    if (!existing) return candidate;
  }
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const rand = String(Math.floor(1000 + Math.random() * 9000));
  return `REF-${yyyy}${mm}${dd}-${rand}`;
}

// ---------- Service -------------------------------------------------------
export class RefundService {
  private static readonly REFUND_POLICY_DISABLED =
    'Refunds are disabled per platform policy. For transaction reversals, please use the Admin Reversal Ledger or contact the university bursary.';

  private static assertRefundsEnabled() {
    throw new AppError(this.REFUND_POLICY_DISABLED, 400);
  }

  static async requestRefund(input: RequestRefundInput, req?: ReqLike) {
    this.assertRefundsEnabled();
    if (!Number.isFinite(input.requestedAmount) || input.requestedAmount <= 0) {
      throw new AppError(i18n.errors.refund.invalidAmount, 400);
    }
    if (!input.reason || !String(input.reason).trim()) {
      throw new AppError(i18n.errors.refund.reasonRequired, 400);
    }

    const origTx = await prisma.transaction.findUnique({
      where: { id: input.originalTransactionId },
      include: {
        invoice: {
          include: { fee: { select: { id: true, name: true, feeCode: true } } },
        },
        receipts: { take: 5, where: { isVoided: false } },
        user: { select: { id: true, firstName: true, lastName: true, matricNumber: true, email: true } },
      },
    });
    if (!origTx) throw new AppError(i18n.errors.payment.transactionNotFound, 404);
    if (origTx.status !== TransactionStatus.SUCCESS) {
      throw new AppError(i18n.errors.refund.transactionNotSuccessful, 400);
    }
    const originalNaira = Number(origTx.amount);
    if (input.requestedAmount > originalNaira + 0.0001) {
      throw new AppError(i18n.errors.refund.amountExceedsOriginal, 400);
    }

    const existingEligible = await prisma.refund.findFirst({
      where: {
        originalTransactionId: input.originalTransactionId,
        status: { in: [RefundStatus.REQUESTED, RefundStatus.APPROVED, RefundStatus.PAID] },
      },
      select: { id: true, status: true },
    });
    if (existingEligible) {
      throw new AppError(i18n.errors.refund.statusNotRequestable, 409);
    }

    const breakdown = computePaymentBreakdown(Number(origTx.amount));

    const created = await prisma.$transaction(async (tx) => {
      const refundNumber = await getNextRefundNumber(tx);
      const txReceipts: any[] = (origTx as any).receipts ?? [];
      const receipt: Receipt | null =
        txReceipts && txReceipts.length > 0 ? (txReceipts[0] as Receipt) : null;
      const notesPayload: Prisma.InputJsonValue = { originalBreakdown: breakdown as any };
      const row = await tx.refund.create({
        data: {
          refundNumber,
          originalTransactionId: input.originalTransactionId,
          originalReceiptId: receipt ? receipt.id : undefined,
          requestedAmount: input.requestedAmount,
          reason: input.reason.trim(),
          status: RefundStatus.REQUESTED,
          requestedById: req?.user?.id ?? null as any,
          notes: notesPayload,
        },
      });
      return { ...row, originalTx: origTx, receipt };
    });

    await writeAudit(req, {
      action: i18n.auditActions.refundRequested,
      entityType: 'REFUND',
      entityId: created.id,
      newValue: {
        refundNumber: created.refundNumber,
        originalTransactionId: input.originalTransactionId,
        requestedAmount: input.requestedAmount,
        reason: input.reason.trim(),
      },
      details: { breakdown },
    });

    try {
      void AdminNotificationService.emitRefundRequested({
        id: created.id,
        refundNumber: created.refundNumber,
        requestedAmount: created.requestedAmount,
        originalTransaction: {
          reference: origTx.reference,
          user: origTx.user
            ? {
                firstName: origTx.user.firstName,
                lastName: origTx.user.lastName,
              }
            : undefined,
        },
      });
    } catch (notifErr) {
      console.warn('[refund:requestRefund] emitRefundRequested failed:', (notifErr as Error)?.message);
    }

    return created;
  }

  static async listRefunds(query: ListRefundsQuery) {
    // Read-only audit trail listing is allowed (returns rows from DB, no refund write actions performed)
    const page = query.page;
    const pageSize = query.pageSize;
    const skip = (page - 1) * pageSize;
    const where: Prisma.RefundWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.originalTransactionId) where.originalTransactionId = query.originalTransactionId;
    if (query.dateFrom || query.dateTo) {
      where.createdAt = {};
      if (query.dateFrom) where.createdAt.gte = query.dateFrom;
      if (query.dateTo) where.createdAt.lte = query.dateTo;
    }
    if (query.studentId) {
      where.originalTransaction = { userId: query.studentId };
    }
    const [total, items] = await prisma.$transaction([
      prisma.refund.count({ where }),
      prisma.refund.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: {
          requestedBy: { select: { id: true, firstName: true, lastName: true, email: true, role: true } },
          approvedBy: { select: { id: true, firstName: true, lastName: true, email: true, role: true } },
          originalTransaction: {
            include: {
              user: { select: { id: true, firstName: true, lastName: true, matricNumber: true, email: true } },
              invoice: {
                include: { fee: { select: { id: true, name: true, feeCode: true } } },
              },
            },
          },
          originalReceipt: { select: { id: true, receiptNumber: true, isVoided: true } },
        },
      }),
    ]);
    return { items, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
  }

  static async approveRefund(id: number, req?: ReqLike) {
    this.assertRefundsEnabled();
    const pre = await prisma.refund.findUnique({
      where: { id },
      include: {
        originalTransaction: {
          select: {
            id: true,
            amount: true,
            reference: true,
            paystackReference: true,
            status: true,
            type: true,
            userId: true,
          },
        },
      },
    });
    if (!pre) throw new AppError(i18n.errors.refund.notFound, 404);
    if (pre.status !== RefundStatus.REQUESTED) throw new AppError(i18n.errors.refund.statusNotRequested, 409);
    if (pre.originalTransaction.status !== TransactionStatus.SUCCESS) {
      throw new AppError(i18n.errors.refund.transactionNotSuccessful, 400);
    }
    const paystackRef =
      pre.originalTransaction.paystackReference || pre.originalTransaction.reference;
    if (!paystackRef) throw new AppError(i18n.errors.refund.noPaystackReference, 400);

    let psResponse: Awaited<ReturnType<typeof PaystackService.createRefund>>;
    try {
      psResponse = await PaystackService.createRefund(paystackRef, Number(pre.requestedAmount));
    } catch (e) {
      const msg = (e as any)?.message ?? i18n.errors.refund.paystackFailed;
      throw new AppError(msg, 502);
    }

    const psStatus = String(psResponse.expectedStatus).toLowerCase();
    const now = new Date();
    const approved = await prisma.$transaction(async (tx) => {
      const prevNotes: any = (pre.notes as any) ?? {};
      const merged: any = {
        ...(typeof prevNotes === 'object' && prevNotes !== null ? prevNotes : {}),
        approval: {
          at: now.toISOString(),
          paystackRefundReference: psResponse.expectedReference,
          gatewayFeeKobo: psResponse.expectedGatewayFee,
          settlementKobo: psResponse.expectedSettlement,
          paystackStatus: psStatus,
          raw: psResponse.raw as any,
        },
      };
      const notesPayload: Prisma.InputJsonValue = merged as any;
      const row = await tx.refund.update({
        where: { id },
        data: {
          status:
            psStatus === 'processed' || psStatus === 'success'
              ? RefundStatus.PAID
              : RefundStatus.APPROVED,
          approvedById: req?.user?.id ?? null as any,
          paystackRefundReference: psResponse.expectedReference ?? undefined,
          paidAt: psStatus === 'processed' || psStatus === 'success' ? now : undefined,
          notes: notesPayload,
        },
        include: {
          requestedBy: { select: { id: true, firstName: true, lastName: true, email: true, role: true } },
          approvedBy: { select: { id: true, firstName: true, lastName: true, email: true, role: true } },
          originalTransaction: {
            include: {
              user: { select: { id: true, firstName: true, lastName: true, matricNumber: true, email: true } },
              invoice: true,
              receipts: { take: 5 },
            },
          },
          originalReceipt: { select: { id: true, receiptNumber: true, isVoided: true } },
        },
      });
      return row;
    });

    await writeAudit(req, {
      action: i18n.auditActions.refundApproved,
      entityType: 'REFUND',
      entityId: id,
      oldValue: { status: RefundStatus.REQUESTED },
      newValue: {
        status: approved.status,
        paystackRefundReference: approved.paystackRefundReference,
        approvedById: approved.approvedById,
      },
      details: { paystackStatus: psStatus, paystackRaw: psResponse.raw as any },
    });

    if (approved.status === RefundStatus.PAID) {
      return await this.processRefund(id, req, { alreadyApproved: approved });
    }
    return approved;
  }

  static async rejectRefund(id: number, input: RejectRefundInput, req?: ReqLike) {
    this.assertRefundsEnabled();
    if (!input.notes || !String(input.notes).trim()) {
      throw new AppError(i18n.errors.refund.notesRequired, 400);
    }
    const pre = await prisma.refund.findUnique({
      where: { id },
      select: { id: true, status: true, notes: true },
    });
    if (!pre) throw new AppError(i18n.errors.refund.notFound, 404);
    if (pre.status !== RefundStatus.REQUESTED) throw new AppError(i18n.errors.refund.statusNotRequested, 409);

    const now = new Date();
    const prev: any = (pre.notes as any) ?? {};
    const merged: any = {
      ...(typeof prev === 'object' && prev !== null ? prev : {}),
      rejection: {
        at: now.toISOString(),
        reason: input.notes.trim(),
        by: req?.user?.id ?? null,
      },
    };
    const notesPayload: Prisma.InputJsonValue = merged as any;

    const updated = await prisma.refund.update({
      where: { id },
      data: {
        status: RefundStatus.REJECTED,
        notes: notesPayload,
      },
      include: {
        requestedBy: { select: { id: true, firstName: true, lastName: true, email: true, role: true } },
        originalTransaction: {
          include: {
            user: { select: { id: true, firstName: true, lastName: true, matricNumber: true } },
          },
        },
      },
    });

    await writeAudit(req, {
      action: i18n.auditActions.refundRejected,
      entityType: 'REFUND',
      entityId: id,
      oldValue: { status: RefundStatus.REQUESTED },
      newValue: { status: RefundStatus.REJECTED, notes: merged.rejection },
    });
    return updated;
  }

  static async processRefund(
    id: number,
    req?: ReqLike,
    opts?: {
      alreadyApproved?: any;
      fromWebhook?: boolean;
      paystackRefundReference?: string;
    },
  ) {
    this.assertRefundsEnabled();
    const refundRaw =
      opts?.alreadyApproved ??
      (await prisma.refund.findUnique({
        where: { id },
        include: {
          originalTransaction: {
            include: {
              user: { select: { id: true, firstName: true, lastName: true, matricNumber: true, email: true } },
              invoice: true,
              receipts: { take: 10 },
            },
          },
          originalReceipt: true,
        },
      }));

    if (!refundRaw) throw new AppError(i18n.errors.refund.notFound, 404);
    if (
      refundRaw.status !== RefundStatus.APPROVED &&
      refundRaw.status !== RefundStatus.PAID &&
      refundRaw.status !== RefundStatus.REQUESTED &&
      refundRaw.status !== RefundStatus.FAILED
    ) {
      throw new AppError(i18n.errors.refund.statusNotPending, 409);
    }

    const origTx = refundRaw.originalTransaction;
    if (!origTx) throw new AppError(i18n.errors.payment.transactionNotFound, 404);

    const refundAmount = Number(refundRaw.requestedAmount);
    const originalTotal = Number(origTx.amount);
    const isFullRefund = refundAmount >= originalTotal - 0.0001;

    const breakdown = computePaymentBreakdown(refundAmount);
    const serviceChargePortion = breakdown.serviceCharge;
    const gatewayFeePortion = breakdown.gatewayFee;
    const baseRefund = refundAmount - serviceChargePortion - gatewayFeePortion;

    const now = new Date();
    const result = await prisma.$transaction(async (tx) => {
      const r = await tx.refund.findUnique({
        where: { id },
        select: { id: true, status: true, paidAt: true, notes: true },
      });
      if (!r) throw new AppError(i18n.errors.refund.notFound, 404);
      if (r.status === RefundStatus.PAID && r.paidAt) {
        return refundRaw;
      }
      if (
        r.status !== RefundStatus.APPROVED &&
        r.status !== RefundStatus.REQUESTED &&
        r.status !== RefundStatus.FAILED
      ) {
        throw new AppError(i18n.errors.refund.statusNotPending, 409);
      }

      const prevNotes: any = (r.notes as any) ?? {};
      const merged: any = {
        ...(typeof prevNotes === 'object' && prevNotes !== null ? prevNotes : {}),
      };
      if (opts?.fromWebhook) {
        merged.webhookProcessed = {
          at: now.toISOString(),
          paystackRefundReference: opts.paystackRefundReference ?? null,
        };
      }
      const notesPayload: Prisma.InputJsonValue = merged as any;

      const paidRefund = await tx.refund.update({
        where: { id },
        data: {
          status: RefundStatus.PAID,
          paidAt: now,
          notes: notesPayload,
          paystackRefundReference:
            refundRaw.paystackRefundReference ?? opts?.paystackRefundReference ?? undefined,
        },
        include: {
          originalTransaction: {
            include: {
              invoice: true,
              receipts: { take: 10 },
            },
          },
        },
      });

      const parentMetadata: Prisma.InputJsonValue = {
        parentTx: origTx.id,
        parentRef: origTx.reference,
        parentPaystackRef: origTx.paystackReference ?? null,
        refundId: id,
        refundNumber: paidRefund.refundNumber,
      } as any;

      const refundTx = await tx.transaction.create({
        data: {
          reference: `RFD-${paidRefund.refundNumber}-${Math.floor(1000 + Math.random() * 9000)}`,
          userId: origTx.userId,
          amount: refundAmount,
          type: TransactionType.REFUND,
          status: TransactionStatus.SUCCESS,
          invoiceId: origTx.invoiceId ?? undefined,
          paystackReference: paidRefund.paystackRefundReference ?? undefined,
          paystackChannel: origTx.paystackChannel ?? undefined,
          expectedAmount: refundAmount,
          description: `Refund #${paidRefund.refundNumber} for ${origTx.reference}`,
          metadata: parentMetadata,
        },
      });

      // Void original receipt(s) for full refund; for partial, annotate via metadata
      if (paidRefund.originalTransaction.receipts && paidRefund.originalTransaction.receipts.length > 0) {
        if (isFullRefund) {
          await tx.receipt.updateMany({
            where: { transactionId: origTx.id },
            data: {
              isVoided: true,
              voidedAt: now,
              voidedById: req?.user?.id ?? undefined,
            },
          });
        } else {
          const first = paidRefund.originalTransaction.receipts[0];
          if (first && !first.isVoided) {
            await tx.transaction.create({
              data: {
                reference: `RFDN-${paidRefund.refundNumber}-NOTE`,
                userId: origTx.userId,
                amount: 0,
                type: TransactionType.REFUND,
                status: TransactionStatus.SUCCESS,
                expectedAmount: 0,
                description: `Partial refund annotation on receipt #${(first as Receipt).receiptNumber} (refund #${paidRefund.refundNumber}, amount ${refundAmount})`,
              },
            });
          }
        }
      }

      // Invoice update: reduce amountPaid, status REFUNDED if full
      const inv = paidRefund.originalTransaction.invoice;
      if (inv) {
        const newAmountPaid = Math.max(0, Number(inv.amountPaid) - refundAmount);
        const amountDue = Number(inv.amountDue);
        let nextStatus = inv.status;
        if (isFullRefund) {
          nextStatus = 'REFUNDED' as any;
        } else if (newAmountPaid <= 0.0001) {
          nextStatus = 'UNPAID' as any;
        } else if (newAmountPaid + 0.0001 < amountDue) {
          nextStatus = 'PARTIALLY_PAID' as any;
        } else {
          nextStatus = 'PAID' as any;
        }
        await tx.invoice.update({
          where: { id: inv.id },
          data: {
            amountPaid: newAmountPaid,
            status: nextStatus,
            paidAt: isFullRefund ? null : inv.paidAt ?? newAmountPaid > 0 ? now : null,
          },
        });
      }

      return { refund: paidRefund, refundTx, isFullRefund };
    });

    await writeAudit(req, {
      action: i18n.auditActions.refundProcessed,
      entityType: 'REFUND',
      entityId: id,
      newValue: {
        status: 'PAID',
        refundAmount,
        paidAt: now.toISOString(),
        refundTxId: (result as any).refundTx?.id ?? null,
      },
      details: {
        breakdown,
        isFullRefund: (result as any).isFullRefund,
        fromWebhook: opts?.fromWebhook,
        glEntries: (result as any).glRows?.length ?? 0,
      },
    });

    if ((result as any).refundTx) {
      await writeAudit(req, {
        action: i18n.auditActions.refundCompleted,
        entityType: 'TRANSACTION',
        entityId: (result as any).refundTx.id,
        newValue: {
          reference: (result as any).refundTx.reference,
          amount: refundAmount,
          originalTransactionId: origTx.id,
        },
      });
    }

    return result;
  }

  static assertTransactionMutable(
    transaction: { id: number; status: TransactionStatus } | null | undefined,
    attemptedFields: Record<string, any>,
  ) {
    const protectedFields = [
      'amount',
      'reference',
      'paystackReference',
      'status',
      'expectedAmount',
      'userId',
      'type',
      'invoiceId',
      'paystackChannel',
      'alatpayReference',
      'alatpaySessionId',
      'gateway',
      'proofOfPaymentReference',
      'receiptId',
    ];
    const touched = protectedFields.filter((k) => k in attemptedFields);
    if (touched.length > 0) {
      throw new AppError(i18n.errors.payment.immutable, 403);
    }
    if (!transaction) return;
    if (
      transaction.status !== TransactionStatus.SUCCESS &&
      transaction.status !== TransactionStatus.REVERSED
    ) {
      return;
    }
  }
}
