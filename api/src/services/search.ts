import { Prisma, TransactionStatus, Role } from '@prisma/client';
import prisma from '../config/database';

export interface SearchResultLinks {
  profile: string;
  fees: string;
  invoices: string;
  payments: string;
  receipts: string;
}

export interface StudentSearchHit {
  id: number;
  email: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  matricNumber: string | null;
  phoneNumber: string | null;
  college: string | null;
  department: string | null;
  program: string | null;
  level: number | null;
  totalFees: number;
  totalPaid: number;
  outstanding: number;
  links: SearchResultLinks;
}

export interface PaymentSearchHit {
  id: number;
  reference: string;
  paystackReference: string | null;
  amount: number;
  expectedAmount: number | null;
  status: TransactionStatus;
  type: string;
  userId: number;
  invoiceId: number | null;
  createdAt: Date;
}

export interface ReceiptSearchHit {
  id: number;
  receiptNumber: string;
  verificationToken: string;
  transactionId: number;
  invoiceId: number | null;
  studentId: number;
  paidAmount: number;
  paystackReference: string | null;
  paidAt: Date;
  isVoided: boolean;
}

export interface CompositeSearchResult {
  students: StudentSearchHit[];
  payments: PaymentSearchHit[];
  receipts: ReceiptSearchHit[];
  tookMs: number;
}

function makeLinks(id: number): SearchResultLinks {
  return {
    profile: `/admin/students/${id}`,
    fees: `/admin/students/${id}/fees`,
    invoices: `/admin/students/${id}/invoices`,
    payments: `/admin/students/${id}/payments`,
    receipts: `/admin/students/${id}/receipts`,
  };
}

export class AdminSearchService {
  static async composite(
    q: string,
    opts?: { limit?: number },
  ): Promise<CompositeSearchResult> {
    const started = Date.now();
    const limit = Math.min(100, opts?.limit ?? 20);

    const query = (q ?? '').trim();
    if (query.length < 2) {
      return {
        students: [],
        payments: [],
        receipts: [],
        tookMs: Date.now() - started,
      };
    }

    const ilikeQ = `%${query}%`;
    const numericOnly = /^\d+$/.test(query);
    const numericId = numericOnly ? Number(query) : null;

    const firstNameContains = { firstName: { contains: query } };
    const lastNameContains = { lastName: { contains: query } };
    const fullNameConcatIlike = {
      AND: [firstNameContains, lastNameContains],
    };

    const [studentsRaw, payments, receiptsRaw] = await Promise.all([
      prisma.user.findMany({
        where: {
          role: Role.STUDENT,
          OR: [
            { matricNumber: { contains: query } },
            fullNameConcatIlike,
            firstNameContains,
            lastNameContains,
            { email: { contains: query } },
            { phoneNumber: { contains: query } },
          ],
        } as any,
        select: {
          id: true,
          email: true,
          firstName: true,
          middleName: true,
          lastName: true,
          matricNumber: true,
          phoneNumber: true,
          college: true,
          department: true,
          program: true,
          level: true,
          invoices: {
            select: { amountDue: true, amountPaid: true },
          },
          transactions: {
            where: { status: TransactionStatus.SUCCESS },
            select: {
              amount: true,
              invoice: { select: { amountDue: true, amountPaid: true } },
            },
          },
        },
        take: limit,
        orderBy: { id: 'asc' },
      }),
      prisma.transaction.findMany({
        where: {
          OR: [
            { reference: { contains: query } },
            { paystackReference: { contains: query } },
          ],
        },
        take: limit,
        orderBy: { id: 'desc' },
      }),
      prisma.receipt.findMany({
        where: numericId
          ? {
              OR: [
                { receiptNumber: { contains: query } },
                { id: numericId },
              ],
            }
          : { receiptNumber: { contains: query } },
        take: limit,
        orderBy: { id: 'desc' },
      }),
    ]);

    const students: StudentSearchHit[] = studentsRaw.map((u: any) => {
      const invoices = u.invoices ?? [];
      const totalFees = invoices.reduce(
        (acc: number, inv: any) => acc + Number(inv.amountDue ?? 0),
        0,
      );
      const totalPaid = invoices.reduce(
        (acc: number, inv: any) => acc + Number(inv.amountPaid ?? 0),
        0,
      );
      const outstanding = +(totalFees - totalPaid).toFixed(2);
      return {
        id: u.id,
        email: u.email,
        firstName: u.firstName,
        middleName: u.middleName ?? null,
        lastName: u.lastName,
        matricNumber: u.matricNumber ?? null,
        phoneNumber: u.phoneNumber ?? null,
        college: u.college ?? null,
        department: u.department ?? null,
        program: u.program ?? null,
        level: u.level ?? null,
        totalFees: +totalFees.toFixed(2),
        totalPaid: +totalPaid.toFixed(2),
        outstanding,
        links: makeLinks(u.id),
      };
    });

    const paymentsOut: PaymentSearchHit[] = payments.map((p: any) => ({
      id: p.id,
      reference: p.reference,
      paystackReference: p.paystackReference ?? null,
      amount: Number(p.amount ?? 0),
      expectedAmount: p.expectedAmount ? Number(p.expectedAmount) : null,
      status: p.status,
      type: p.type,
      userId: p.userId,
      invoiceId: p.invoiceId ?? null,
      createdAt: p.createdAt,
    }));

    const receipts: ReceiptSearchHit[] = receiptsRaw.map((r: any) => ({
      id: r.id,
      receiptNumber: r.receiptNumber,
      verificationToken: r.verificationToken,
      transactionId: r.transactionId,
      invoiceId: r.invoiceId ?? null,
      studentId: r.studentId,
      paidAmount: Number(r.paidAmount ?? 0),
      paystackReference: r.paystackReference ?? null,
      paidAt: r.paidAt,
      isVoided: !!r.isVoided,
    }));

    return {
      students,
      payments: paymentsOut,
      receipts,
      tookMs: Date.now() - started,
    };
  }
}

export default AdminSearchService;
