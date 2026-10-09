// =============================================================================
// Student Invoice / Fee Schedule backend APIs (Task 10.1)
// -----------------------------------------------------------------------------
// GET  /student/fees/schedule          -> grouped per §16 (per session: totalBilled/totalPaid/outstanding + rows)
// GET  /student/invoices              -> filters+pagination, ownership-enforced (STUDENT-only returns 404 for cross-owner access)
// GET  /student/invoices/:id          -> detail with payment history, pay metadata, Pay button payload
// =============================================================================
import { z } from 'zod';
import { Prisma, Invoice } from '@prisma/client';
import prisma from '../config/database';
import { AppError } from '../utils/AppError';
import { generatePaymentReference } from '../utils/paystack';
import { getActiveGatewaySetting } from './payment/providerFactory';
import { gatewayLabel } from './payment/types';

export const StudentInvoiceListSchema = z.object({
  session: z.string().max(20).trim().optional(),
  status: z.enum(['UNPAID', 'PARTIALLY_PAID', 'PAID', 'PENDING', 'FAILED', 'REVERSED', 'REFUNDED', 'CANCELLED']).optional(),
  feeId: z.coerce.number().int().positive().optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  page: z.coerce.number().int().positive().default(1).optional(),
  pageSize: z.coerce.number().int().positive().max(500).default(25).optional(),
  sort: z.enum(['createdAt', 'dueDate', 'amountDue']).default('createdAt').optional(),
  order: z.enum(['asc', 'desc']).default('desc').optional(),
});

export type StudentInvoiceListInput = z.infer<typeof StudentInvoiceListSchema>;

const INVOICE_SELECT = {
  id: true, invoiceNumber: true, feeId: true, studentId: true,
  amountDue: true, amountPaid: true, status: true,
  dueDate: true, session: true, semester: true,
  createdAt: true, updatedAt: true,
  fee: { select: { id: true, feeCode: true, name: true, description: true, amount: true,
                    college: true, department: true, program: true,
                    level: true, studentType: true, isMandatory: true,
                    category: { select: { id: true, name: true, code: true } } } },
  _count: { select: { transactions: true } },
} as const;

type InvoiceRow = Invoice & {
  fee?: any;
  _count?: { transactions: number };
};

function computeStatusWithOverdue(row: any) {
  // §16 spec override: if now > dueDate && balance > 0, mark OVERDUE.
  const balance = Number(row.amountDue) - Number(row.amountPaid);
  const due = row.dueDate ? new Date(row.dueDate) : null;
  if (balance > 0 && due && due.getTime() < Date.now()) return 'OVERDUE';
  return row.status;
}

/**
 * FR-4: mark invoice origin as DIRECT_BILL if an active STUDENT-target FeeAssignment
 * exists for this (studentId, feeId) pair; else CATALOGUE.
 */
export function computeInvoiceOrigin(studentId: number, feeId: number, directAssignmentsByFee: Map<number, any>): 'DIRECT_BILL' | 'CATALOGUE' {
  return directAssignmentsByFee.has(feeId) ? 'DIRECT_BILL' : 'CATALOGUE';
}

async function fetchDirectBillAssignmentsByFee(studentId: number, feeIds: Array<number | bigint>): Promise<Map<number, any>> {
  const ids = Array.from(new Set(feeIds.map((id) => Number(id)))).filter((n) => Number.isFinite(n) && n > 0);
  if (ids.length === 0) return new Map();
  const rows = await prisma.feeAssignment.findMany({
    where: {
      assignmentType: 'STUDENT' as any,
      targetStudentId: studentId,
      feeId: { in: ids },
      isActive: true,
    },
    select: { id: true, feeId: true, overrideAmount: true, overrideDeadline: true, assignedAt: true, assignedBy: { select: { firstName: true, lastName: true, email: true } } },
  });
  const map = new Map<number, any>();
  for (const r of rows) map.set(Number(r.feeId), r);
  return map;
}

export class StudentFeesService {
  // §16 grouped schedule
  static async schedule(studentId: number) {
    const me = await prisma.user.findFirst({ where: { id: studentId, role: 'STUDENT' as any }, select: { id: true } });
    if (!me) throw new AppError('Student not found', 404);

    const invoices = await prisma.invoice.findMany({
      where: { studentId },
      select: INVOICE_SELECT as any,
      orderBy: { session: 'asc' },
    });
    const feeIds = invoices.map((i: any) => i.feeId).filter((n: any) => n != null);
    const directByFee = await fetchDirectBillAssignmentsByFee(studentId, feeIds);
    // group by session
    const grouped: Record<string, any[]> = {};
    for (const row of invoices as unknown as InvoiceRow[]) {
      const s = row.session ?? 'Unknown';
      if (!grouped[s]) grouped[s] = [];
      grouped[s].push(row);
    }
    const sessions = Object.keys(grouped).sort();
    const schedule = sessions.map((session) => {
      const rows = grouped[session];
      let totalBilled = 0;
      let totalPaid = 0;
      const feeRows = rows.map((row) => {
        const amountDue = Number(row.amountDue);
        const amountPaid = Number(row.amountPaid);
        const balance = +(amountDue - amountPaid).toFixed(2);
        totalBilled += amountDue;
        totalPaid += amountPaid;
        return {
          id: row.id,
          invoiceNumber: row.invoiceNumber,
          feeId: row.feeId,
          feeName: row.fee?.name ?? 'Fee',
          feeCode: row.fee?.feeCode ?? null,
          feeCategory: row.fee?.category?.name ?? row.fee?.category?.code ?? null,
          amountDue,
          amountPaid,
          balance,
          status: computeStatusWithOverdue(row),
          dueDate: row.dueDate,
          semester: row.semester,
          isMandatory: row.fee?.isMandatory ?? false,
          origin: computeInvoiceOrigin(studentId, Number(row.feeId), directByFee),
        };
      });
      const totalBilledFixed = +totalBilled.toFixed(2);
      const totalPaidFixed = +totalPaid.toFixed(2);
      const totalOutstanding = +(totalBilled - totalPaid).toFixed(2);
      return {
        session,
        totalBilled: totalBilledFixed,
        totalPaid: totalPaidFixed,
        totalOutstanding,
        rows: feeRows,
      };
    });
    return { schedule };
  }

  static async listInvoices(studentId: number, query: StudentInvoiceListInput & { role?: string }) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const skip = (page - 1) * pageSize;
    const sort = (query.sort ?? 'createdAt') as 'createdAt' | 'dueDate' | 'amountDue';
    const order = (query.order ?? 'desc') as 'asc' | 'desc';

    const where: Prisma.InvoiceWhereInput = { studentId };
    const role: string | undefined = (query as any).role;

    // Invoice terminal statuses: once an invoice reaches one of these it is "cleared"
    // (either fully paid, cancelled, refunded or reversed).
    const TERMINAL_STATUSES = ['PAID', 'CANCELLED', 'REFUNDED', 'REVERSED'] as const;
    // Invoice "open/owing" statuses: STUDENT-only catalogue browse shows them owing.
    const OPEN_STATUSES = ['UNPAID', 'PENDING', 'PARTIALLY_PAID', 'FAILED'] as const;

    if (query.status) {
      // Explicit ?status= override always wins regardless of role.
      where.status = query.status as any;
    } else if (role === 'STUDENT') {
      // STUDENT Payment History list = COMPLETE ledger (ALL statuses).
      // (Previous code showed only OPEN — that bug caused "status still showing unpaid
      // after PAID" because PAID invoices were hidden, not the amount.)
      // No status filter here: UNPAID + PAID + PARTIALLY_PAID + CANCELLED + REFUNDED all visible.
    } else {
      // ADMIN / BURSARY dashboard receivables: hide TERMINAL invoices by default.
      where.status = { notIn: TERMINAL_STATUSES as any } as any;
    }
    if (query.session) where.session = query.session;
    if (query.feeId) where.feeId = query.feeId;
    if (query.dateFrom || query.dateTo) {
      where.createdAt = {};
      if (query.dateFrom) (where.createdAt as any).gte = query.dateFrom;
      if (query.dateTo) (where.createdAt as any).lte = query.dateTo;
    }
    // NEVER show duplicate invoice rows. We dedupe by (studentId, feeId, invoiceNumber)
    // via Prisma DISTINCT fallback: group by id (which is unique), so no duplicates
    // possible — but we ORDER BY updatedAt DESC so the most-recently touched invoice
    // for a fee appears first (helps when historical manual re-invoice exists).
    const orderBy: any = sort === 'createdAt' ? { updatedAt: order } : { [sort]: order };
    const [rows, total] = await Promise.all([
      prisma.invoice.findMany({ where, select: INVOICE_SELECT as any, skip, take: pageSize, orderBy, distinct: ['id'] }),
      prisma.invoice.count({ where }),
    ]);
    const feeIds = rows.map((r: any) => r.feeId).filter((n: any) => n != null);
    const directByFee = await fetchDirectBillAssignmentsByFee(studentId, feeIds);
    const seenInvoiceIds = new Set<number>();
    const enriched: InvoiceRow[] = [];
    for (const row of rows as unknown as InvoiceRow[]) {
      if (seenInvoiceIds.has(Number(row.id))) continue;
      seenInvoiceIds.add(Number(row.id));
      const amountDue = Number(row.amountDue);
      const amountPaid = Number(row.amountPaid);
      (enriched as any[]).push({
        id: row.id,
        invoiceNumber: row.invoiceNumber,
        fee: row.fee,
        amountDue,
        amountPaid,
        balance: +(amountDue - amountPaid).toFixed(2),
        status: computeStatusWithOverdue(row),
        dueDate: row.dueDate,
        session: row.session,
        semester: row.semester,
        createdAt: row.createdAt,
        transactionCount: (row as any)._count?.transactions ?? 0,
        origin: computeInvoiceOrigin(studentId, Number(row.feeId), directByFee),
        directAssignment: directByFee.get(Number(row.feeId)) ?? null,
      });
    }
    return { invoices: enriched, total: enriched.length + Math.max(0, total - rows.length), page, pageSize };
  }

  static async getInvoiceDetail(studentId: number, id: number) {
    // §17 ownership guard: cross-owner access returns 404 (never 403)
    // NOTE: explicitly destructure INVOICE_SELECT without `_count` because we
    // already spread a separate `transactions` relation select below; Prisma
    // rejects selecting the same relation (`transactions`) twice in different
    // shapes (`_count.transactions:true` + `transactions:{select,take,orderBy}`)
    // in the same query, producing an invocation error.
    const { _count: _omitCount, ...invoiceSelectNoCount } = INVOICE_SELECT;
    const row = await prisma.invoice.findFirst({
      where: { id, studentId },
      select: {
        ...(invoiceSelectNoCount as any),
        transactions: {
          select: {
            id: true,
            reference: true,
            gateway: true,
            amount: true,
            expectedAmount: true,
            status: true,
            paystackChannel: true,
            paystackReference: true,
            alatpayReference: true,
            alatpayFinalTransactionId: true,
            alatpaySessionId: true,
            type: true,
            description: true,
            createdAt: true,
            updatedAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 50,
        },
      } as any,
    });
    if (!row) throw new AppError('Invoice not found', 404);
    const amountDue = Number((row as any).amountDue);
    const amountPaid = Number((row as any).amountPaid);
    const balance = +(amountDue - amountPaid).toFixed(2);
    const feeId = Number((row as any).feeId);
    const directByFee = await fetchDirectBillAssignmentsByFee(studentId, [feeId]);
    const origin = computeInvoiceOrigin(studentId, feeId, directByFee);
    const directAssignment = directByFee.get(feeId) ?? null;
    const activeGateway = await getActiveGatewaySetting();
    const payPayload = {
      canPay: balance > 0 && (row as any).status !== 'CANCELLED' && (row as any).status !== 'REFUNDED' && (row as any).status !== 'REVERSED',
      amountToPay: balance,
      paymentReference: generatePaymentReference(),
      dueDate: (row as any).dueDate,
      activeGateway,
      gateway_label: gatewayLabel(activeGateway),
    };
    // Map raw Transaction fields (per schema.prisma model) into the shape
    // the frontend expects (channel / paymentReference / transactionDate).
    const mappedTransactions = ((row as any).transactions ?? []).map((tx: any) => {
      const status = String(tx.status ?? 'UNKNOWN').toUpperCase();
      // Presentation-only amount rule:
      //   - SUCCESS / UNDERPAID / OVERPAID / REVERSED: use authoritative amount
      //   - PENDING / FAILED: amount is typically 0 because the provider never
      //     (or not yet) moved money. Show expectedAmount (the amount the
      //     student *attempted* to pay) instead. NEVER mutate DB values here.
      let displayAmount = Number(tx.amount ?? 0);
      const isAttemptOnly = ['PENDING', 'FAILED'].includes(status);
      if (isAttemptOnly) {
        const expected = Number(tx.expectedAmount ?? 0);
        // If FAILED has an authoritative amount > 0 (Paystack declined with
        // captured amount or manual corrected amount), prefer it. Otherwise
        // (amount == 0, e.g. no callback happened at all), use expectedAmount.
        if (displayAmount <= 0 && expected > 0) displayAmount = expected;
      }
      return {
        id: tx.id,
        reference: tx.reference,
        gateway: tx.gateway,
        // channel: frontend history drawer + list render this
        channel: tx.paystackChannel || (tx.gateway ? String(tx.gateway).toLowerCase() : null),
        amount: Number(tx.amount),
        expectedAmount: Number(tx.expectedAmount ?? 0),
        displayAmount,
        status: tx.status,
        // paymentReference: used as a human-readable reference alias
        paymentReference: tx.reference,
        paystackReference: tx.paystackReference ?? null,
        alatpayReference: tx.alatpayReference ?? null,
        alatpayFinalTransactionId: tx.alatpayFinalTransactionId ?? null,
        // transactionDate: used in history table (falls back to createdAt on FE too)
        transactionDate: tx.createdAt,
        type: tx.type,
        description: tx.description ?? null,
        createdAt: tx.createdAt,
        updatedAt: tx.updatedAt,
      };
    });
    return {
      invoice: {
        id: row.id,
        invoiceNumber: row.invoiceNumber,
        fee: (row as any).fee,
        amountDue,
        amountPaid,
        balance,
        status: computeStatusWithOverdue(row),
        dueDate: (row as any).dueDate,
        session: (row as any).session,
        semester: (row as any).semester,
        createdAt: (row as any).createdAt,
        updatedAt: (row as any).updatedAt,
        origin,
        directAssignment,
      },
      transactions: mappedTransactions,
      pay: payPayload,
    };
  }
}
