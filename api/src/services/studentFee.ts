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

    // AC-3 (role-aware): STUDENT role must NEVER see UNPAID invoices, even when explicitly requested.
    if (role === 'STUDENT') {
      where.status = query.status && query.status !== 'UNPAID'
        ? (query.status as any)
        : { not: 'UNPAID' } as any;
    } else {
      // ADMIN / BURSARY: UNPAID allowed via explicit query only; default hides UNPAID
      // to avoid presenting legacy debt as current KPI.
      if (query.status) where.status = query.status as any;
    }
    if (query.session) where.session = query.session;
    if (query.feeId) where.feeId = query.feeId;
    if (query.dateFrom || query.dateTo) {
      where.createdAt = {};
      if (query.dateFrom) (where.createdAt as any).gte = query.dateFrom;
      if (query.dateTo) (where.createdAt as any).lte = query.dateTo;
    }
    const orderBy: any = { [sort]: order };
    const [rows, total] = await Promise.all([
      prisma.invoice.findMany({ where, select: INVOICE_SELECT as any, skip, take: pageSize, orderBy }),
      prisma.invoice.count({ where }),
    ]);
    const enriched = (rows as unknown as InvoiceRow[]).map((row) => {
      const amountDue = Number(row.amountDue);
      const amountPaid = Number(row.amountPaid);
      return {
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
        transactionCount: row._count?.transactions ?? 0,
      };
    });
    return { invoices: enriched, total, page, pageSize };
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
            status: true,
            paystackChannel: true,
            paystackReference: true,
            alatpayReference: true,
            alatpaySessionId: true,
            type: true,
            description: true,
            createdAt: true,
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
    const mappedTransactions = ((row as any).transactions ?? []).map((tx: any) => ({
      id: tx.id,
      reference: tx.reference,
      gateway: tx.gateway,
      // channel: frontend history drawer + list render this
      channel: tx.paystackChannel || (tx.gateway ? String(tx.gateway).toLowerCase() : null),
      amount: Number(tx.amount),
      status: tx.status,
      // paymentReference: used as a human-readable reference alias
      paymentReference: tx.reference,
      paystackReference: tx.paystackReference ?? null,
      alatpayReference: tx.alatpayReference ?? null,
      // transactionDate: used in history table (falls back to createdAt on FE too)
      transactionDate: tx.createdAt,
      type: tx.type,
      description: tx.description ?? null,
      createdAt: tx.createdAt,
    }));
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
      },
      transactions: mappedTransactions,
      pay: payPayload,
    };
  }
}
