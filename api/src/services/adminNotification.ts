import { Prisma } from '@prisma/client';
import prisma from '../config/database';

export type AdminNotificationType =
  | 'LARGE_PAYMENT'
  | 'FAILED_PAYMENT'
  | 'ANOMALY_UNDERPAID'
  | 'ANOMALY_OVERPAID'
  | 'WEBHOOK_FAIL_3'
  | 'IMPORT_ERRORS_10'
  | 'REFUND_REQUESTED';

export type AdminNotificationSeverity = 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';

const JSON_DB_NULL = Prisma.JsonNull;

export interface NotifyArgs {
  type: AdminNotificationType;
  title: string;
  body?: string;
  severity?: AdminNotificationSeverity;
  metadata?: Record<string, any>;
}

export class AdminNotificationService {
  static async notifyAdminsAndBursary(args: NotifyArgs) {
    const { type, title, body, severity = 'INFO', metadata } = args;
    try {
      const row = await prisma.adminNotification.create({
        data: {
          type,
          title,
          body: body ?? null,
          severity,
          metadata: metadata ? (metadata as Prisma.InputJsonValue) : JSON_DB_NULL,
        },
      });
      return row;
    } catch (err) {
      console.warn('[AdminNotification] create failed:', (err as Error)?.message);
      return null;
    }
  }

  static async emitLargePayment(
    transaction: { id: number; reference: string; amount: number | Prisma.Decimal; userId?: number },
    amountNgn: number,
    threshold: number,
  ) {
    if (amountNgn < threshold) return null;
    return this.notifyAdminsAndBursary({
      type: 'LARGE_PAYMENT',
      title: `Large Payment Detected: ₦${amountNgn.toLocaleString()}`,
      body: `Transaction reference ${transaction.reference} exceeded the large payment threshold of ₦${threshold.toLocaleString()}.`,
      severity: 'WARNING',
      metadata: {
        transactionId: transaction.id,
        reference: transaction.reference,
        amountNgn,
        threshold,
        userId: (transaction as any).userId ?? null,
      },
    });
  }

  static async emitFailedPayment(transaction: {
    id: number;
    reference: string;
    underpaidReason?: string | null;
    userId?: number;
  }) {
    return this.notifyAdminsAndBursary({
      type: 'FAILED_PAYMENT',
      title: `Payment Failed: ${transaction.reference}`,
      body: transaction.underpaidReason ?? `Transaction ${transaction.reference} failed.`,
      severity: 'ERROR',
      metadata: {
        transactionId: transaction.id,
        reference: transaction.reference,
        underpaidReason: transaction.underpaidReason ?? null,
        userId: (transaction as any).userId ?? null,
      },
    });
  }

  static async emitAnomaly(
    anomalyType: 'UNDERPAID' | 'OVERPAID',
    transaction: {
      id: number;
      reference: string;
      amount: number | Prisma.Decimal;
      expectedAmount?: number | Prisma.Decimal | null;
      underpaidReason?: string | null;
      userId?: number;
    },
  ) {
    const type: AdminNotificationType =
      anomalyType === 'UNDERPAID' ? 'ANOMALY_UNDERPAID' : 'ANOMALY_OVERPAID';
    const titleLabel = anomalyType === 'UNDERPAID' ? 'Underpayment' : 'Overpayment';
    const amount = Number(transaction.amount ?? 0);
    const expected = Number(transaction.expectedAmount ?? 0);
    return this.notifyAdminsAndBursary({
      type,
      title: `${titleLabel} Anomaly: ${transaction.reference}`,
      body: transaction.underpaidReason
        ?? `${titleLabel}: paid ₦${amount.toLocaleString()} vs expected ₦${expected.toLocaleString()}.`,
      severity: anomalyType === 'UNDERPAID' ? 'ERROR' : 'WARNING',
      metadata: {
        anomalyType,
        transactionId: transaction.id,
        reference: transaction.reference,
        amountNgn: amount,
        expectedNgn: expected,
        userId: (transaction as any).userId ?? null,
      },
    });
  }

  static async emitWebhookFail3(paystackReference: string) {
    return this.notifyAdminsAndBursary({
      type: 'WEBHOOK_FAIL_3',
      title: 'Webhook Failed 3+ Attempts',
      body: `Paystack reference ${paystackReference} webhook handler failed 3 or more attempts. Manual reconciliation required.`,
      severity: 'CRITICAL',
      metadata: { paystackReference },
    });
  }

  static async emitImportErrors(
    studentImportId: number,
    errorCount: number,
    threshold: number = 10,
  ) {
    if (errorCount < threshold) return null;
    return this.notifyAdminsAndBursary({
      type: 'IMPORT_ERRORS_10',
      title: `Student Import: ${errorCount} error rows`,
      body: `Import batch #${studentImportId} encountered ${errorCount} errors (threshold ${threshold}). Review the error CSV for details.`,
      severity: 'WARNING',
      metadata: { studentImportId, errorCount, threshold },
    });
  }

  static async emitRefundRequested(refund: {
    id: number;
    refundNumber: string;
    requestedAmount: number | Prisma.Decimal;
    originalTransaction?: {
      reference?: string;
      user?: { firstName?: string | null; lastName?: string | null };
    };
  }) {
    const amount = Number(refund.requestedAmount ?? 0);
    const reference = (refund as any).originalTransaction?.reference ?? 'N/A';
    const studentName = [
      (refund as any).originalTransaction?.user?.firstName,
      (refund as any).originalTransaction?.user?.lastName,
    ]
      .filter(Boolean)
      .join(' ')
      .trim();
    return this.notifyAdminsAndBursary({
      type: 'REFUND_REQUESTED',
      title: `Refund Requested: ${refund.refundNumber}`,
      body: `Refund #${refund.refundNumber} for ₦${amount.toLocaleString()} on tx ${reference}${
        studentName ? ` (student: ${studentName})` : ''
      } requires review.`,
      severity: 'INFO',
      metadata: {
        refundId: refund.id,
        refundNumber: refund.refundNumber,
        requestedAmount: amount,
        transactionReference: reference,
        studentName: studentName || null,
      },
    });
  }

  static async listNotifications(opts: {
    read?: 'unread' | 'all';
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(100, Math.max(1, opts.limit ?? 25));
    const skip = (page - 1) * limit;
    const where: Prisma.AdminNotificationWhereInput = {};
    if (opts.read === 'unread') {
      where.readAt = null;
    }
    const [items, total] = await Promise.all([
      prisma.adminNotification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          readByUser: { select: { id: true, email: true, firstName: true, lastName: true, role: true } },
        },
      }),
      prisma.adminNotification.count({ where }),
    ]);
    return {
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        hasNext: page * limit < total,
        hasPrev: page > 1,
      },
    };
  }

  static async markRead(id: number, userId: number) {
    return prisma.adminNotification.update({
      where: { id },
      data: {
        readAt: new Date(),
        readBy: userId,
      },
      include: {
        readByUser: { select: { id: true, email: true, firstName: true, lastName: true, role: true } },
      },
    });
  }
}

export default AdminNotificationService;
