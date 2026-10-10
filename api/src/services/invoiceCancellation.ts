import { Request } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { Prisma, InvoiceStatus, TransactionStatus, Role } from '@prisma/client';
import { AppError } from '../utils/AppError';
import { i18n } from '../i18n/en';

const JSON_DB_NULL = Prisma.JsonNull;

export const CANCEL_INVOICE_REASONS = [
  'INVOICE_CREATED_IN_ERROR',
  'DUPLICATE_INVOICE',
  'WRONG_STUDENT',
  'WRONG_FEE_ASSIGNMENT',
  'FEE_NO_LONGER_APPLICABLE',
  'ADMINISTRATIVE_CORRECTION',
  'OTHER',
] as const;

export type CancelInvoiceReason = (typeof CANCEL_INVOICE_REASONS)[number];

export const CANCEL_INVOICE_REASON_LABELS: Record<CancelInvoiceReason, string> = {
  INVOICE_CREATED_IN_ERROR: 'Invoice created in error',
  DUPLICATE_INVOICE: 'Duplicate invoice',
  WRONG_STUDENT: 'Wrong student',
  WRONG_FEE_ASSIGNMENT: 'Wrong fee assignment',
  FEE_NO_LONGER_APPLICABLE: 'Fee no longer applicable',
  ADMINISTRATIVE_CORRECTION: 'Administrative correction',
  OTHER: 'Other',
};

export const CancelInvoiceBodySchema = z
  .object({
    reason: z.enum(CANCEL_INVOICE_REASONS, {
      required_error: 'Cancellation reason is required',
      invalid_type_error: 'Invalid cancellation reason',
    }),
    writtenExplanation: z.string().trim().max(2000).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.reason === 'OTHER') {
      const x = (val.writtenExplanation ?? '').trim();
      if (x.length < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Written explanation is required when reason is "Other"',
          path: ['writtenExplanation'],
        });
      }
    }
  });

export type CancelInvoiceBody = z.infer<typeof CancelInvoiceBodySchema>;

type InvoiceCancelInput = {
  invoiceId: number;
  actorId: number;
  actorRole: Role;
  reason: CancelInvoiceReason;
  writtenExplanation?: string;
  req?: Pick<Request, 'ip' | 'headers'>;
};

const UNSAFE_INVOICE_STATUS_BEFORE_CANCEL: InvoiceStatus[] = [
  InvoiceStatus.PAID,
  InvoiceStatus.PARTIALLY_PAID,
  InvoiceStatus.REFUNDED,
  InvoiceStatus.REVERSED,
  InvoiceStatus.CANCELLED,
];

const UNSAFE_TX_STATUS_FOR_INVOICE_CANCEL: TransactionStatus[] = [
  TransactionStatus.PENDING,
  TransactionStatus.PROCESSING,
  TransactionStatus.SUCCESS,
];

export class InvoiceCancellationService {
  private static assertRoleAuthorized(role: Role) {
    if (role !== Role.ADMIN && role !== Role.BURSARY) {
      throw new AppError(i18n.errors.auth.notPermitted, 403);
    }
  }

  static async cancelInvoice(input: InvoiceCancelInput) {
    this.assertRoleAuthorized(input.actorRole);

    const { invoiceId, actorId, reason, writtenExplanation, req } = input;

    const precheckInvoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        invoiceNumber: true,
        studentId: true,
        status: true,
        amountDue: true,
        amountPaid: true,
      },
    });
    if (!precheckInvoice) {
      throw new AppError(i18n.errors.invoice.notFound, 404);
    }

    if (precheckInvoice.status === InvoiceStatus.CANCELLED) {
      throw new AppError('Invoice is already cancelled', 409);
    }

    if (UNSAFE_INVOICE_STATUS_BEFORE_CANCEL.includes(precheckInvoice.status)) {
      throw new AppError(
        `Invoice cannot be cancelled because its status is ${precheckInvoice.status}. Use the appropriate financial workflow instead.`,
        409,
      );
    }

    if (Number(precheckInvoice.amountPaid) > 0) {
      throw new AppError(
        `Invoice cannot be cancelled because amountPaid (${precheckInvoice.amountPaid}) is greater than 0. A payment has already been recorded against this invoice.`,
        409,
      );
    }

    const unsafeTxs = await prisma.transaction.findMany({
      where: {
        invoiceId,
        status: { in: UNSAFE_TX_STATUS_FOR_INVOICE_CANCEL },
      },
      take: 5,
      select: { id: true, status: true, reference: true },
    });
    if (unsafeTxs.length > 0) {
      const hasPendingOrProcessing = unsafeTxs.some(
        (t) => t.status === TransactionStatus.PENDING || t.status === TransactionStatus.PROCESSING,
      );
      if (hasPendingOrProcessing) {
        throw new AppError(
          'Invoice has unresolved pending or processing transactions that must be safely reconciled first. Cancellation is rejected until those payment attempts are resolved.',
          409,
        );
      }
      throw new AppError(
        'Invoice cannot be cancelled because it has successful payment transactions.',
        409,
      );
    }

    const hasSuccessReceipts = await prisma.receipt.count({
      where: { invoiceId, voidedAt: null },
    });
    if (hasSuccessReceipts > 0) {
      throw new AppError(
        'Invoice cannot be cancelled because it has receipts representing successful payments.',
        409,
      );
    }

    const hasSettlementPostings = await prisma.generalLedger.count({
      where: {
        invoiceId,
        entryType: {
          in: [
            'PAYMENT_SUCCESS',
            'CONVENIENCE_FEE_INCOME',
            'SERVICE_CHARGE_INCOME',
            'GATEWAY_FEE_EXPENSE',
          ],
        },
      },
    });
    if (hasSettlementPostings > 0) {
      throw new AppError(
        'Invoice cannot be cancelled because it has settlement or financial postings that would make cancellation unsafe.',
        409,
      );
    }

    const previousStatus = precheckInvoice.status;
    const amountDueBefore = precheckInvoice.amountDue;
    const amountPaidBefore = precheckInvoice.amountPaid;
    const studentId = precheckInvoice.studentId;
    const invoiceNumber = precheckInvoice.invoiceNumber;

    const ipAddress =
      ((req as any)?.ip as string | undefined) ??
      (((req as any)?.headers?.['x-forwarded-for'] as string | undefined) ?? '').split(',')[0] ??
      null;
    const userAgent = ((req as any)?.headers?.['user-agent'] as string | undefined) ?? null;

    const result = await prisma.$transaction(async (tx) => {
      const unsafeTxRecheck = await tx.transaction.count({
        where: {
          invoiceId,
          status: { in: UNSAFE_TX_STATUS_FOR_INVOICE_CANCEL },
        },
      });
      if (unsafeTxRecheck > 0) {
        throw new AppError(
          'Invoice state changed while the cancellation was being processed (unresolved transaction detected). Please refresh and try again.',
          409,
        );
      }

      const updateRes = await tx.invoice.updateMany({
        where: {
          id: invoiceId,
          amountPaid: 0,
          status: { notIn: UNSAFE_INVOICE_STATUS_BEFORE_CANCEL },
        },
        data: { status: InvoiceStatus.CANCELLED },
      });
      if (updateRes.count !== 1) {
        throw new AppError(
          'Invoice state changed while the cancellation dialog was open. Please refresh the invoice and try again.',
          409,
        );
      }

      const receiptsRecheck = await tx.receipt.count({ where: { invoiceId, voidedAt: null } });
      if (receiptsRecheck > 0) {
        throw new AppError(
          'Invoice state changed during cancellation (receipt appeared). Please refresh and try again.',
          409,
        );
      }

      const audit = await tx.auditLog.create({
        data: {
          userId: actorId,
          action: 'INVOICE_CANCELLED',
          entityType: 'INVOICE',
          entityId: String(invoiceId),
          oldValue: {
            invoiceId,
            invoiceNumber,
            studentId,
            previousStatus,
            amountDue: amountDueBefore,
            amountPaid: amountPaidBefore,
          } as unknown as Prisma.InputJsonValue,
          newValue: {
            newStatus: InvoiceStatus.CANCELLED,
            amountDue: amountDueBefore,
            amountPaid: amountPaidBefore,
            reason,
            reasonLabel: CANCEL_INVOICE_REASON_LABELS[reason],
            writtenExplanation: writtenExplanation?.trim() ?? null,
          } as unknown as Prisma.InputJsonValue,
          details: {
            invoiceId,
            invoiceNumber,
            studentId,
            previousStatus,
            newStatus: InvoiceStatus.CANCELLED,
            amountDue: amountDueBefore,
            amountPaid: amountPaidBefore,
            cancellationReason: reason,
            cancellationReasonLabel: CANCEL_INVOICE_REASON_LABELS[reason],
            writtenExplanation: writtenExplanation?.trim() ?? null,
            actorId,
          } as unknown as Prisma.InputJsonValue,
          ipAddress: ipAddress ? String(ipAddress).slice(0, 64) : null,
          userAgent: userAgent ? String(userAgent).slice(0, 512) : null,
        },
        select: { id: true, createdAt: true },
      });

      return { audit };
    });

    const finalInvoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        invoiceNumber: true,
        status: true,
        amountDue: true,
        amountPaid: true,
        studentId: true,
      },
    });

    return {
      invoice: finalInvoice,
      auditId: result.audit.id,
      auditedAt: result.audit.createdAt,
    };
  }
}

type _JsonNullGuard = typeof JSON_DB_NULL;
void (undefined as unknown as _JsonNullGuard | undefined);
