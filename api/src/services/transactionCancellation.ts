import { Request } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import {
  Prisma,
  InvoiceStatus,
  TransactionStatus,
  Role,
  PaymentGateway,
} from '@prisma/client';
import { AppError } from '../utils/AppError';
import { Permissions } from '../types/permissions';
import {
  acquireInvoiceOperationLock,
  releaseInvoiceOperationLock,
} from '../utils/invoiceLock';

const JSON_DB_NULL = Prisma.JsonNull;

export const CANCEL_TRANSACTION_REASONS = [
  'TEST_TRANSACTION',
  'DUPLICATE_ATTEMPT',
  'STUDENT_ABANDONED',
  'PROVIDER_SESSION_EXPIRED',
  'PAYMENT_COMPLETED_ON_NEW_ATTEMPT',
  'ADMINISTRATIVE_CORRECTION',
  'OTHER',
] as const;

export type CancelTransactionReason =
  (typeof CANCEL_TRANSACTION_REASONS)[number];

export const CANCEL_TRANSACTION_REASON_LABELS: Record<
  CancelTransactionReason,
  string
> = {
  TEST_TRANSACTION: 'Test / sandbox transaction',
  DUPLICATE_ATTEMPT: 'Duplicate payment attempt (replaced by newer)',
  STUDENT_ABANDONED: 'Student explicitly abandoned this attempt',
  PROVIDER_SESSION_EXPIRED: 'Provider session / checkout expired',
  PAYMENT_COMPLETED_ON_NEW_ATTEMPT: 'Payment completed on a separate new attempt',
  ADMINISTRATIVE_CORRECTION: 'Administrative correction',
  OTHER: 'Other',
};

export const CancelTransactionBodySchema = z
  .object({
    reason: z.enum(CANCEL_TRANSACTION_REASONS, {
      required_error: 'Cancellation reason is required',
      invalid_type_error: 'Invalid cancellation reason',
    }),
    writtenExplanation: z.string().trim().max(2000).optional(),
    evidenceReference: z
      .string()
      .trim()
      .max(500)
      .optional()
      .refine((v) => v == null || v.length === 0 || v.length >= 4, {
        message: 'If provided, evidence reference must be at least 4 characters',
      }),
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

export type CancelTransactionBody = z.infer<typeof CancelTransactionBodySchema>;

type TransactionCancelInput = {
  transactionId: number;
  actorId: number;
  actorRole: Role;
  actorPermissions: string[];
  reason: CancelTransactionReason;
  writtenExplanation?: string;
  evidenceReference?: string;
  req?: Pick<Request, 'ip' | 'headers'>;
};

const INELIGIBLE_STATUSES: TransactionStatus[] = [
  TransactionStatus.SUCCESS,
  TransactionStatus.REVERSED,
  TransactionStatus.CANCELLED,
];

const ELIGIBLE_INVOICE_STATUSES_FOR_TX_CANCEL: InvoiceStatus[] = [
  InvoiceStatus.UNPAID,
  InvoiceStatus.PENDING,
  InvoiceStatus.FAILED,
  InvoiceStatus.PARTIALLY_PAID,
];

export class TransactionCancellationService {
  static assertAuthorized(role: Role, permissions: string[]) {
    if (role === Role.ADMIN) return true;
    if (role === Role.BURSARY && permissions.includes(Permissions.VOID_TRANSACTIONS)) {
      return true;
    }
    return false;
  }

  static async cancelTransaction(input: TransactionCancelInput) {
    if (!this.assertAuthorized(input.actorRole, input.actorPermissions ?? [])) {
      throw new AppError(
        'You do not have permission to cancel payment transactions. The VOID_TRANSACTIONS permission is required.',
        403,
      );
    }
    const {
      transactionId,
      actorId,
      reason,
      writtenExplanation,
      evidenceReference,
      req,
    } = input;

    // Precheck 0: load tx + invoice (studentId/amount) for subsequent checks
    const initialTx = await prisma.transaction.findUnique({
      where: { id: transactionId },
      include: {
        invoice: {
          select: {
            id: true,
            invoiceNumber: true,
            status: true,
            amountDue: true,
            amountPaid: true,
          },
        },
      },
    });
    if (!initialTx) {
      throw new AppError('Transaction not found.', 404);
    }
    const invoiceId = initialTx.invoiceId;
    if (invoiceId == null) {
      throw new AppError(
        'Only invoice-backed fee payment attempts can be cancelled via this workflow.',
        400,
      );
    }

    // Shared invoice-level TTL lock so concurrent cancelInvoice / initiatePayment
    // / cancelTransaction do not race. 8s is enough for 1 DB $tx + audit.
    const lockOk = await acquireInvoiceOperationLock(invoiceId, 8_000);
    if (!lockOk) {
      throw new AppError(
        'Another operation (invoice cancel, payment initiation, or reconciliation) is in progress for this invoice. Please wait and try again.',
        429,
      );
    }
    try {
      // --- Precheck 1: status must be eligible unpaid/non-terminal ------------
      if ((INELIGIBLE_STATUSES as TransactionStatus[]).includes(initialTx.status as any)) {
        throw new AppError(
          `Transaction ${initialTx.reference ?? initialTx.id} has status ${
            initialTx.status
          } and cannot be cancelled. Only pending, processing, failed or unbalanced unpaid attempts may be cancelled.`,
          409,
        );
      }

      // Precheck 2: if invoice status is CANCELLED / REFUNDED / REVERSED
      // allow tx cancel ONLY if tx never posted any money (safe administrative).
      if (initialTx.invoice) {
        const invSt = initialTx.invoice.status;
        const terminal = ['CANCELLED', 'REFUNDED', 'REVERSED'];
        if (terminal.includes(invSt as string) && initialTx.amount != null && Number(initialTx.amount) > 0) {
          throw new AppError(
            `Invoice ${initialTx.invoice.invoiceNumber ?? initialTx.invoice.id} is ${invSt} but this attempt already recorded a paid amount. It must be handled via refund/reversal workflow, not transaction cancellation.`,
            409,
          );
        }
      }

      // Precheck 3: No receipt exists for this tx (receipt generation is a
      // terminal financial event → cancel would erase evidence of receipted tx).
      const receiptCount = await prisma.receipt.count({
        where: { transactionId },
      });
      if (receiptCount > 0) {
        throw new AppError(
          `Transaction already has ${receiptCount} receipt(s). Receipted transactions must be reversed through the financial reversal workflow, not cancelled.`,
          409,
        );
      }

      // Precheck 4: No GL financial entries have been posted
      const glCount = await (prisma as any).generalLedger.count({
        where: { transactionId },
      });
      if (Number(glCount ?? 0) > 0) {
        throw new AppError(
          `Transaction has ${glCount} General Ledger posting(s). Transactions with GL entries must be reversed using the reversal workflow, not cancelled.`,
          409,
        );
      }

      // Precheck 5: No settlement exists
      const settlementCount = await prisma.settlement.count?.({
        where: { transactionId },
      }).catch(() => 0) ?? 0;
      if (Number(settlementCount) > 0) {
        throw new AppError(
          `Transaction already has settlement record(s). Settled transactions cannot be cancelled.`,
          409,
        );
      }

      // Precheck 6: Invoice amountPaid has not been credited by this tx
      if (initialTx.invoice) {
        if (Number(initialTx.invoice.amountPaid ?? 0) > 0) {
          // There is *some* posting against the invoice. Make sure THIS tx
          // is not the one who posted it.
          // If we ever support partial cancel on partial-paid invoices,
          // tighten this check. Currently we forbid any cancel against
          // invoice already with amountPaid>0 AND this tx has raw amount>0.
          if (Number(initialTx.amount ?? 0) > 0) {
            throw new AppError(
              `Invoice ${initialTx.invoice.invoiceNumber ?? initialTx.invoice.id} already has amountPaid > 0 and this attempt recorded an amount. Use refund/reversal workflow instead.`,
              409,
            );
          }
        }
      }

      // Precheck 7: if success-reference columns are populated we need to
      // require explicit written explanation (case: provider returned SUCCESS
      // but internal status never transitioned; this is dangerous to cancel
      // silently. Still allowed because financial posting checks passed, but
      // requires user evidence/written explanation for audit).
      const hasSuccessRef =
        (initialTx.status === TransactionStatus.SUCCESS as any) ||
        (initialTx.alatpayFinalTransactionId && (initialTx.alatpayFinalTransactionId as string).length > 0) ||
        ((initialTx as any).paystackReference && (initialTx as any).paystackReference.length > 0 &&
          initialTx.status === TransactionStatus.SUCCESS);
      if (hasSuccessRef) {
        const written = (writtenExplanation ?? '').trim().length;
        const ev = (evidenceReference ?? '').trim().length;
        if (written < 20 || ev < 6) {
          throw new AppError(
            'This attempt contains provider success references or a SUCCESS-like status. To cancel, provide both written explanation (>=20 chars) and evidence reference (>=6 chars) for the audit trail.',
            409,
          );
        }
      }

      const ipAddress =
        ((req as any)?.ip as string | undefined) ??
        (((req as any)?.headers?.['x-forwarded-for'] as string | undefined) ?? '').split(',')[0] ??
        null;
      const userAgent = ((req as any)?.headers?.['user-agent'] as string | undefined) ?? null;

      const writtenNow = new Date();
      const result = await prisma.$transaction(async (tx) => {
        if (process.env.NODE_ENV !== 'test') {
          try {
            await tx.$executeRawUnsafe('SELECT id FROM invoices WHERE id = ? FOR UPDATE;', [invoiceId]);
          } catch { /* swallow */ }
        }
        // Precheck 8: re-read tx inside tx for optimistic concurrency
        const liveTx = await tx.transaction.findUnique({
          where: { id: transactionId },
          include: { invoice: { select: { id: true, status: true, amountPaid: true } } },
        });
        if (!liveTx) throw new AppError('Transaction not found.', 404);
        if ((INELIGIBLE_STATUSES as TransactionStatus[]).includes(liveTx.status as any)) {
          throw new AppError(
            `Transaction state changed to ${liveTx.status} while cancellation was being processed. Refresh and try again.`,
            409,
          );
        }

        // Precheck 9: no receipt / GL row created concurrently between our
        // initial read above and this $tx.
        const receiptRecheck = await tx.receipt.count({ where: { transactionId } });
        if (receiptRecheck > 0) {
          throw new AppError('A receipt was created concurrently. Cancellation aborted.', 409);
        }
        const glRecheck = await (tx as any).generalLedger.count({ where: { transactionId } }).catch(() => 0);
        if (Number(glRecheck ?? 0) > 0) {
          throw new AppError('General Ledger entries were posted concurrently. Cancellation aborted.', 409);
        }
        // Precheck 10: invoice amountPaid recheck (did another payment just post?)
        if (liveTx.invoice) {
          const invRecheck = await tx.invoice.findUnique({
            where: { id: liveTx.invoice.id },
            select: { id: true, status: true, amountPaid: true },
          });
          if (
            invRecheck &&
            Number(invRecheck.amountPaid ?? 0) > 0 &&
            Number(liveTx.amount ?? 0) > 0
          ) {
            throw new AppError(
              'Invoice amountPaid changed concurrently. Cancellation aborted.',
              409,
            );
          }
          // Invoice CANCELLED itself — allow cancelTransaction only if 0 posting
          if (
            invRecheck &&
            (invRecheck.status === InvoiceStatus.CANCELLED ||
              invRecheck.status === InvoiceStatus.REFUNDED ||
              invRecheck.status === InvoiceStatus.REVERSED) &&
            Number(liveTx.amount ?? 0) > 0
          ) {
            throw new AppError(
              `Invoice ${invRecheck.id} status changed to ${invRecheck.status} with a posted amount. Use reversal/refund workflow instead.`,
              409,
            );
          }
        }

        // Precheck 11: preserve original provider refs — store them in
        // metadata.cancellation, NOT overwrite columns.
        const existingMeta =
          liveTx.metadata && typeof liveTx.metadata === 'object'
            ? (liveTx.metadata as Record<string, any>)
            : {};
        const cancellationMeta = {
          at: writtenNow.toISOString(),
          reason,
          writtenExplanation: (writtenExplanation ?? '').trim().slice(0, 2000) || null,
          evidenceReference: (evidenceReference ?? '').trim().slice(0, 500) || null,
          actorId,
          statusBefore: String(liveTx.status),
          preservedReferences: {
            reference: liveTx.reference ?? null,
            paystackReference: (liveTx as any).paystackReference ?? null,
            alatpayReference: (liveTx as any).alatpayReference ?? null,
            alatpayFinalTransactionId: (liveTx as any).alatpayFinalTransactionId ?? null,
            alatpayOrderReference: (liveTx as any).alatpayOrderReference ?? null,
            alatpayInitPaymentReference: (liveTx as any).alatpayInitPaymentReference ?? null,
            alatpaySessionId: (liveTx as any).alatpaySessionId ?? null,
            gateway: (liveTx.gateway as PaymentGateway | null) ?? null,
            expectedAmount: liveTx.expectedAmount ? Number(liveTx.expectedAmount) : null,
            rawAmount: liveTx.amount ? Number(liveTx.amount) : null,
          },
        };
        const updatedMeta: Record<string, any> = {
          ...existingMeta,
          cancellation: cancellationMeta,
        };

        // Precheck 12: atomic updateMany WHERE status=eligible AND id=tx.id so
        // another process can't modify row between our read + write.
        const eligibleWhere: any[] = [
          TransactionStatus.PENDING,
          TransactionStatus.PROCESSING,
          TransactionStatus.FAILED,
          TransactionStatus.UNDERPAID,
          TransactionStatus.OVERPAID,
        ];
        const updateRes = await tx.transaction.updateMany({
          where: {
            id: transactionId,
            status: { in: eligibleWhere },
          },
          data: {
            status: TransactionStatus.CANCELLED,
            metadata: updatedMeta as Prisma.InputJsonValue,
            updatedAt: writtenNow,
          },
        });
        if (updateRes.count !== 1) {
          throw new AppError(
            'Transaction status changed concurrently between precheck and commit. Please refresh and try again.',
            409,
          );
        }

        // Audit TRANSACTION_CANCELLED (inside tx for atomicity with the
        // updateMany — either both persist, or neither does.)
        const audit = await tx.auditLog.create({
          data: {
            userId: actorId,
            action: 'TRANSACTION_CANCELLED',
            entityType: 'TRANSACTION',
            entityId: String(transactionId),
            oldValue: {
              id: liveTx.id,
              reference: liveTx.reference,
              status: liveTx.status,
              invoiceId: liveTx.invoiceId,
              expectedAmount: liveTx.expectedAmount ? Number(liveTx.expectedAmount) : null,
              amount: liveTx.amount ? Number(liveTx.amount) : null,
            } as Prisma.InputJsonValue,
            newValue: {
              status: TransactionStatus.CANCELLED,
              cancellation: cancellationMeta,
            } as Prisma.InputJsonValue,
            details: {
              code: 'MANUAL_TRANSACTION_CANCEL',
              invoiceId,
              invoiceNumber: initialTx.invoice?.invoiceNumber ?? null,
              reason,
              writtenExplanation: cancellationMeta.writtenExplanation,
              evidenceReference: cancellationMeta.evidenceReference,
              preservedReferences: cancellationMeta.preservedReferences,
              prechecks: {
                receiptCleared: receiptRecheck === 0,
                glCleared: Number(glRecheck ?? 0) === 0,
                statusEligible: true,
                invoiceAmountSafe: true,
              },
            } as Prisma.InputJsonValue,
            ipAddress,
            userAgent,
          },
        });

        // Explicitly DO NOT touch invoice amountPaid, DO NOT generate
        // receipts, DO NOT create settlements, DO NOT post GL. This
        // preserves the cancelled payment attempt for audit without any
        // financial side effects.
        return { audit, cancellationMeta };
      }, { timeout: 15000 });

      const finalTx = await prisma.transaction.findUnique({ where: { id: transactionId } });
      return {
        transaction: finalTx,
        auditId: result.audit.id,
        auditedAt: result.audit.createdAt,
        cancellation: result.cancellationMeta,
      };
    } finally {
      await releaseInvoiceOperationLock(invoiceId);
    }
  }
}

type _JsonNullGuard = typeof JSON_DB_NULL;
void (undefined as unknown as _JsonNullGuard | undefined);
