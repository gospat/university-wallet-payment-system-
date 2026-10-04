// =============================================================================
// Students routes
//
// Permission model (§4 ADMIN, §5 BURSARY — backend enforced per FR-B1):
//   - GET    /students, /students/:id, /students/matric/:matric,
//            POST   /students,
//            PATCH  /students/:id,
//            POST   /students/:id/status,
//            POST   /students/:id/reset-password
//     → ADMIN | BURSARY (read/write students; bursary CANNOT permanently
//       delete per §5 forbidden actions — we only expose status=WITHDRAWN
//       soft-delete via /students/:id/status).
//
//   - GET    /me, PATCH /me
//     → STUDENT only (self-service: read/write own contact info only).
//       Note: mounted under /api/v1/auth/profile too, but this file defines
//       the canonical REST set; auth routes re-use the same handlers.
// =============================================================================

import express from 'express';
import { protect, restrictTo, requirePermission } from '../middlewares/auth';
import {
  createStudent,
  getMe,
  getStudent,
  getStudentByMatric,
  listStudents,
  resetStudentPassword,
  setStudentStatus,
  updateMe,
  updateStudent,
} from '../controllers/student';
import { Role } from '@prisma/client';
import prisma from '../config/database';
import { AppError } from '../utils/AppError';
import { validateBody, validateParams, validateQuery } from '../middlewares/validate';
import {
  CreateStudentSchema,
  StudentQuerySchema,
  StudentSelfUpdateSchema,
  UpdateStudentSchema,
} from '../services/student';
import { z } from 'zod';
import { catchAsync } from '../utils/catchAsync';
import {
  StudentFeesService,
  StudentInvoiceListSchema,
} from '../services/studentFee';
import {
  confirmPayload,
  confirmPayloadValidator,
  initiatePayment,
  initiatePaymentValidator,
  verifyPayment,
  verifyPaymentValidator,
} from '../controllers/payments';
import { downloadFormalReceipt, downloadStatement, listMyReceipts } from '../controllers/receipt';
import { FeeService, FeeQuerySchema } from '../services/fee';
import { PaymentService, InitiatePaymentSchema } from '../services/payment';
import { Prisma } from '@prisma/client';
import { generateInvoiceReference } from '../utils/paystack';

const router = express.Router();

// ---------- Self-service (authenticated student, any role if STUDENT) -------
router.use('/me', protect, restrictTo(Role.STUDENT));
router.get('/me', getMe);
router.patch('/me', validateBody(StudentSelfUpdateSchema), updateMe);

router.get('/fees/schedule', protect, restrictTo(Role.STUDENT), catchAsync(async (req: any, res) => {
  const data = await StudentFeesService.schedule(req.user.id);
  res.status(200).json({ status: 'success', data });
}));

router.get('/invoices', protect, restrictTo(Role.STUDENT), validateQuery(StudentInvoiceListSchema), catchAsync(async (req: any, res) => {
  const data = await StudentFeesService.listInvoices(req.user.id, { ...req.query, role: Role.STUDENT });
  res.status(200).json({ status: 'success', data });
}));

const IdParam = z.object({ id: z.coerce.number().int().positive() });
router.get('/invoices/:id', protect, restrictTo(Role.STUDENT), validateParams(IdParam), catchAsync(async (req: any, res) => {
  const data = await StudentFeesService.getInvoiceDetail(req.user.id, Number(req.params.id));
  res.status(200).json({ status: 'success', data });
}));

// ---------- Self-service payments (STUDENT only) ----------------------------
const ReceiptDownloadIdParam = z.object({ id: z.coerce.number().int().positive() });
router.get('/receipts', protect, restrictTo(Role.STUDENT), listMyReceipts);
router.get('/receipts/:id/download', protect, restrictTo(Role.STUDENT), validateParams(ReceiptDownloadIdParam), downloadFormalReceipt);
router.get('/statement', protect, restrictTo(Role.STUDENT), downloadStatement);
router.get('/me/receipts', protect, restrictTo(Role.STUDENT), listMyReceipts);
router.get('/me/statement', protect, restrictTo(Role.STUDENT), downloadStatement);
router.get(
  '/payments/confirm-payload',
  protect,
  restrictTo(Role.STUDENT),
  confirmPayloadValidator,
  confirmPayload,
);
router.post(
  '/payments/initiate',
  protect,
  restrictTo(Role.STUDENT),
  initiatePaymentValidator,
  initiatePayment,
);
router.get(
  '/payments/verify/:ref',
  protect,
  restrictTo(Role.STUDENT),
  ...(verifyPaymentValidator as any),
  verifyPayment,
);

// ---------- Student Fee Catalogue (Browse ALL fees admin has set) ------------
router.get(
  '/fees/catalogue',
  protect,
  restrictTo(Role.STUDENT),
  validateQuery(FeeQuerySchema),
  catchAsync(async (req: any, res) => {
    const me = await prisma.user.findFirst({
      where: { id: Number(req.user?.id), role: 'STUDENT' as any },
      select: {
        id: true, college: true, department: true, program: true,
        level: true, studentType: true, academicSession: true,
      },
    });
    if (!me) throw new AppError('Student profile not found.', 404);

    type AllowedSort = 'createdAt' | 'amountDue' | 'dueDate' | 'feeName' | 'category';
    type AllowedOrder = 'asc' | 'desc';
    const ALLOWED_SORTS: ReadonlySet<AllowedSort> = new Set(['createdAt', 'amountDue', 'dueDate', 'feeName', 'category']);
    const ALLOWED_ORDERS: ReadonlySet<AllowedOrder> = new Set(['asc', 'desc']);
    const SORT_TO_PRISMA_FIELD: Record<AllowedSort, 'createdAt' | 'amount' | 'paymentDeadline' | 'name' | 'categoryId'> = {
      createdAt: 'createdAt',
      amountDue: 'amount',
      dueDate: 'paymentDeadline',
      feeName: 'name',
      category: 'categoryId',
    };
    const validatedQuery = req.query as NonNullable<typeof req.query>;

    const baseWhere: any = { isActive: true };
    if (validatedQuery?.session) baseWhere.academicSession = validatedQuery.session;
    if (validatedQuery?.category) {
      const cat = typeof validatedQuery.category === 'number'
        ? { id: validatedQuery.category }
        : { code: String(validatedQuery.category).toUpperCase() };
      baseWhere.category = cat;
    }
    if (validatedQuery?.semester) baseWhere.semester = validatedQuery.semester;
    if (validatedQuery?.q) {
      baseWhere.OR = [
        { name: { contains: String(validatedQuery.q) } },
        { feeCode: { contains: String(validatedQuery.q) } },
        { description: { contains: String(validatedQuery.q) } },
      ];
    }

    const scopeMatches: any[] = [];
    const F = (field: string, value: any) => {
      if (!value && value !== 0 && value !== false) return;
      scopeMatches.push({ [field]: null });
      scopeMatches.push({ [field]: value });
    };
    F('college', me.college);
    F('department', me.department);
    F('program', me.program);
    F('studentType', me.studentType);

    const globalOrMatch: Prisma.FeeWhereInput = {};
    if (scopeMatches.length > 0) {
      globalOrMatch.AND = [];
      const fields = ['college', 'department', 'program', 'studentType'];
      const studentValues: any = me;
      for (const f of fields) {
        const v = studentValues[f];
        if (!v && v !== 0) {
          (globalOrMatch.AND as any).push({ [f]: null });
        } else {
          (globalOrMatch.AND as any).push({
            OR: [{ [f]: null }, { [f]: v }],
          });
        }
      }
    }

    const where: Prisma.FeeWhereInput = {
      ...baseWhere,
      ...globalOrMatch,
    };

    const rawPage = Number(validatedQuery?.page);
    const rawPageSize = Number(validatedQuery?.pageSize);
    const rawSort = validatedQuery?.sort as AllowedSort | string | undefined;
    const rawOrder = validatedQuery?.order as AllowedOrder | string | undefined;

    const page: number = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
    const pageSize: number = Number.isFinite(rawPageSize) && rawPageSize > 0 && rawPageSize <= 500 ? Math.floor(rawPageSize) : 25;
    const sort: AllowedSort = ALLOWED_SORTS.has(rawSort as AllowedSort) ? (rawSort as AllowedSort) : 'createdAt';
    const order: AllowedOrder = ALLOWED_ORDERS.has(rawOrder as AllowedOrder) ? (rawOrder as AllowedOrder) : 'desc';
    const prismaSortField = SORT_TO_PRISMA_FIELD[sort];
    const skip = (page - 1) * pageSize;

    // STEP 1: load ACTIVE direct-bill FeeAssignment rows for this student.
    const directAssignments = await prisma.feeAssignment.findMany({
      where: {
        assignmentType: 'STUDENT' as any,
        targetStudentId: me.id,
        isActive: true,
        fee: { isActive: true },
      },
      select: {
        id: true,
        overrideAmount: true,
        overrideDeadline: true,
        noteToStudent: true,
        assignedAt: true,
        settledAt: true,
        isActive: true,
        assignedBy: { select: { firstName: true, lastName: true, email: true } },
        fee: {
          select: {
            id: true, feeCode: true, name: true, description: true,
            categoryId: true, category: { select: { id: true, name: true, code: true } },
            amount: true, currency: true,
            academicSession: true, semester: true,
            college: true, department: true, program: true, level: true, studentType: true,
            isMandatory: true, paymentDeadline: true, isActive: true,
            createdAt: true, updatedAt: true,
          },
        },
      },
    });

    // ============  DIRECT BILLS COMPLETELY SEPARATED FROM GENERAL CATALOGUE  ============
    //  · General catalogue (fees array) = ONLY self-browsable, admin-published fees.
    //    ANY feeId that is ever used as a STUDENT-type (individual direct bill) assignment
    //    is FULLY EXCLUDED from the general catalogue for EVERY STUDENT — so the same
    //    DIRECT BILL never leaks to a non-targeted student.
    //  · Assigned/owing direct bills → separate array `assignedBills`,
    //    only for the TARGETED student. Once the specific FEE_ASSIGNMENT row is settled
    //    (settledAt populated OR it has a latest terminal-status PAID/… invoice that
    //    matches the overrideAmount) → removed from owing.
    //    IMPORTANT: uses PER FEE_ASSIGNMENT detection (row.settledAt or row-linked
    //    terminal invoice) — not per feeId, because the same feeId can legitimately
    //    have multiple direct-bill postings to the same student (e.g., N200 paid + N100
    //    still outstanding → we must NOT drop the N100 owed one just because the earlier
    //    N200 posting reached terminal).

    const TERMINAL_STATUSES: ReadonlyArray<string> = ['PAID', 'CANCELLED', 'REFUNDED', 'REVERSED'];
    const TERMINAL_SETTLED: ReadonlyArray<string> = ['PAID'];

    // --- GLOBAL exclusion set (used in general catalogue, never show direct-bill fee IDs) ---
    const ALL_DIRECT_BILL_FEEIDS: Array<number> = (await (prisma as any).$queryRaw(
      Prisma.sql`SELECT DISTINCT feeId FROM fee_assignments WHERE assignmentType = 'STUDENT'`
    ) as Array<{ feeId: number }>).map((r: any) => Number(r.feeId));
    const GLOBAL_DIRECT_BILL_EXCLUDE = new Set<number>(ALL_DIRECT_BILL_FEEIDS.filter(Boolean));

    // --- PER FEE_ASSIGNMENT settlement detection ----------------------------
    // A STUDENT direct-bill FeeAssignment is CONSIDERED SETTLED (excluded from owing)
    // when EITHER:
    //   (A) row.settledAt IS NOT NULL                                 — explicit DB mark (from verifyPayment path)
    //   (B) row has isActive=false and has any PAID terminal invoice — disable/paid
    //   (C) for the row.assignmentId + row.feeId + row.overrideAmount (or fee.amount if none):
    //       the LATEST invoice created >= row.assignedAt has status ∈ {PAID, CANCELLED, REFUNDED, REVERSED}
    //
    // Otherwise → OWED (shown in assignedBills).
    const OMITTED = new Set<number>(); // holds fee_assignment.id of SETTLED rows
    if (directAssignments.length > 0) {
      // Build (assignmentId,feeId,assignedAt) triples
      type Row = { id: number; fee: { id: number }; assignedAt: string | Date; settledAt?: string | Date | null; isActive: boolean; overrideAmount?: number | Prisma.Decimal | null };
      const candidateFeeIds = Array.from(new Set(directAssignments.map((da) => Number((da as any).fee.id))));
      const candidateAssIds = directAssignments.map((da) => Number((da as any).id));
      // Pull all invoices (for these students + feeIds) since rows.createdAt <= inv.createdAt
      // Grouped per feeId, filtered by createdAt >= row.assignedAt for that row later.
      const invoices = await prisma.invoice.findMany({
        where: {
          studentId: me.id,
          feeId: { in: candidateFeeIds },
          OR: [
            { status: { in: TERMINAL_STATUSES as any } },
            { status: 'UNPAID' },
            { status: 'PENDING' },
            { status: 'PARTIALLY_PAID' },
          ],
        },
        select: {
          id: true, invoiceNumber: true, feeId: true, status: true, amountDue: true, amountPaid: true, createdAt: true, updatedAt: true,
        },
      });

      // Group invoices per feeId
      const invoicesByFee = new Map<number, Array<typeof invoices[number]>>();
      for (const inv of invoices) {
        const fid = Number((inv as any).feeId);
        const arr = invoicesByFee.get(fid) || [];
        arr.push(inv);
        invoicesByFee.set(fid, arr);
      }

      for (const rawRow of directAssignments) {
        const row = rawRow as any as Row;
        const rowId = Number(row.id);
        const feeId = Number(row.fee.id);
        const rowHasSettledAt =
          (row as any).settledAt !== null && (row as any).settledAt !== undefined && String((row as any).settledAt) !== '';
        if (rowHasSettledAt) {
          OMITTED.add(rowId);
          continue;
        }

        const rowAmountExpected = Number(
          (row as any).overrideAmount != null ? (row as any).overrideAmount : (row as any).fee?.amount ?? 0
        );

        // Invoices for this feeId created on or after this specific assignment's assignedAt
        // AND matching the row's expected amount (to avoid cross-contamination when the same
        // feeId has multiple direct-bill postings with different overrideAmounts for the same
        // student — e.g., ₦200 settled earlier vs a new ₦100 still outstanding).
        const invsFee = (invoicesByFee.get(feeId) || [])
          .filter((inv) => {
            const tsOk = new Date(String((inv as any).createdAt)) >= new Date(String(row.assignedAt));
            if (!tsOk) return false;
            const amtOk = Math.abs(Number((inv as any).amountDue ?? 0) - rowAmountExpected) < 0.01;
            // If overrideAmount is not set, allow fallback to any invoice that at least matches the
            // original fee.amount exactly (to avoid amount drift stripping all rows).
            if ((row as any).overrideAmount == null) return amtOk;
            // For DIRECT override billings — strict amount check since each posting targets exact N amount.
            // Also allow tiny rounding drift (±0.01 only).
            return amtOk;
          });
        // Find the LATEST by createdAt
        invsFee.sort((a, b) =>
          new Date(String((b as any).createdAt)).getTime() - new Date(String((a as any).createdAt)).getTime()
        );
        const latest = invsFee[0];
        if (!latest) {
          // No invoice created yet. But admin might have just done Bill Student; we still show it in OWED
          // (even without invoice) so the student can click Pay-Now to generate one.
          continue; // keep in OWED
        }

        const statusLatest = String((latest as any).status || '').toUpperCase();
        const amountDueLatest = Number((latest as any).amountDue ?? 0);
        const amountPaidLatest = Number((latest as any).amountPaid ?? 0);
        const BAL_ZERO = Math.abs(amountDueLatest - amountPaidLatest) < 0.01;

        if (TERMINAL_STATUSES.includes(statusLatest) && BAL_ZERO) {
          // Explicit terminal reached → mark settled, OMIT
          OMITTED.add(rowId);
          continue;
        }
        if (statusLatest === 'PAID') {
          OMITTED.add(rowId);
          continue;
        }
        // Else UNPAID/PENDING/PARTIALLY_PAID → still OWED, don't OMIT
      }
    }

    // owedAssignmentIds = all assignment.id rows that are NOT in OMITTED set
    const OWED_ASSIGNMENT_IDS = new Set(
      directAssignments
        .map((da) => Number((da as any).id))
        .filter((id) => !OMITTED.has(id))
    );

    // General catalogue where: NEVER include any DIRECT_BILL feeId (for ANY student),
    // even if matches null college/dept/prog filters.
    const catalogueExclude = Array.from(GLOBAL_DIRECT_BILL_EXCLUDE);
    const [rows, totalGlobal] = await Promise.all([
      prisma.fee.findMany({
        where: { ...where, id: { notIn: catalogueExclude } },
        select: {
          id: true, feeCode: true, name: true, description: true,
          categoryId: true, category: { select: { id: true, name: true, code: true } },
          amount: true, currency: true,
          academicSession: true, semester: true,
          college: true, department: true, program: true, level: true, studentType: true,
          isMandatory: true, paymentDeadline: true, isActive: true,
          createdAt: true, updatedAt: true,
        },
        skip: Math.max(0, skip),
        take: pageSize,
        orderBy: { [prismaSortField]: order as 'asc' | 'desc' },
      }),
      prisma.fee.count({ where: { ...where, id: { notIn: catalogueExclude } } }),
    ]);

    const directFeeRows = directAssignments.map((da: any) => {
      const base = da.fee;
      const overrideAmount = da.overrideAmount != null ? Number(da.overrideAmount) : null;
      return {
        ...base,
        amount: overrideAmount ?? Number(base.amount),
        paymentDeadline: da.overrideDeadline ?? base.paymentDeadline,
        noteToStudent: da.noteToStudent ?? null,
        badge: 'DIRECT BILL' as const,
        assignmentId: da.id,
        assignedAt: da.assignedAt,
        assignedBy: da.assignedBy,
        _isDirectBill: true,
      };
    });

    const globalRows = rows.map((r) => ({
      ...r,
      amount: Number((r as any).amount),
      badge: null as null,
      assignmentId: null as null,
      _isDirectBill: false,
    }));

    // ---------- Filter assignedBills to ONLY OWED rows (per feeAssignment.id, not per feeId) ----------
    const owingDirectBills = directFeeRows.filter((r) => OWED_ASSIGNMENT_IDS.has(Number(r.assignmentId)));

    res.status(200).json({
      status: 'success',
      data: {
        fees: globalRows,
        assignedBills: owingDirectBills,
        total: totalGlobal,
        page,
        pageSize,
      },
    });
  }),
);

// ---------- Initiate payment for a Fee (auto-create invoice if needed) ------
const FeeIdParam = z.object({ feeId: z.coerce.number().int().positive() });
const _FeeInitiateInnerSchema = z.object({
  partialAmount: z.union([
    z.number().positive(),
    z.string().refine((s) => Number(s) > 0, { message: 'positive numeric required' }).transform((s) => Number(s)),
  ]).optional(),
  email: z.string().trim().max(255).email().optional(),
  idempotencyKey: z.string().min(1).max(128).trim().optional(),
}).strict();
const FeeInitiateValidator = [validateParams(FeeIdParam), validateBody(_FeeInitiateInnerSchema)];

// Helper: find-or-create PENDING invoice for (studentId, feeId) — never UNPAID.
// Uses Idempotency-Key header to de-duplicate rapid Pay-Now clicks.
async function ensureInvoiceForFee(studentId: number, feeId: number, opts?: { idempotencyKey?: string }) {
  const fee = await prisma.fee.findFirst({
    where: { id: feeId, isActive: true },
    select: {
      id: true, feeCode: true, name: true, amount: true, currency: true,
      academicSession: true, semester: true, paymentDeadline: true,
    },
  });
  if (!fee) throw new AppError('Fee not found or no longer available.', 404);

  // If idempotency key given, try to return existing one first (even if PENDING).
  if (opts?.idempotencyKey) {
    const existingByKey = await prisma.invoice.findFirst({
      where: {
        idempotencyKey: opts.idempotencyKey,
        studentId,
        feeId: fee.id,
      },
      select: { id: true, invoiceNumber: true, amountDue: true, amountPaid: true, status: true },
    });
    if (existingByKey) {
      const bal = Number(existingByKey.amountDue) - Number(existingByKey.amountPaid);
      if (bal <= 0 && existingByKey.status === 'PAID') {
        throw new AppError('This fee is already paid.', 409);
      }
      return {
        invoiceId: existingByKey.id,
        invoiceNumber: existingByKey.invoiceNumber,
        created: false,
        fee,
      };
    }
  }

  const reuse = await prisma.invoice.findFirst({
    where: {
      studentId, feeId: fee.id,
      status: { in: ['PENDING', 'PARTIALLY_PAID'] as any },
    },
    select: { id: true, invoiceNumber: true, amountDue: true, amountPaid: true, status: true },
  });
  if (reuse) {
    const bal = Number(reuse.amountDue) - Number(reuse.amountPaid);
    if (bal <= 0) throw new AppError('This fee is already paid.', 409);
    return { invoiceId: reuse.id, invoiceNumber: reuse.invoiceNumber, created: false, fee };
  }
  const created = await prisma.$transaction(async (tx: any) => {
    const baseRow = (await (tx as any).$queryRaw(
      Prisma.sql`SELECT COALESCE(MAX(id),0)+1 AS next_id FROM invoices FOR UPDATE`,
    )) as unknown as Array<{ next_id: number }>;
    let nextId = Number(baseRow?.[0]?.next_id ?? 0);
    if (Number.isNaN(nextId) || nextId <= 0) nextId = 1;
    const fiscalYear = fee.academicSession?.split('/')?.[0] ?? String(new Date().getFullYear());
    const invRef = generateInvoiceReference(nextId, fiscalYear);
    return tx.invoice.create({
      data: {
        invoiceNumber: invRef,
        student: { connect: { id: studentId } },
        fee: { connect: { id: fee.id } },
        amountDue: new (Prisma as any).Decimal(String(fee.amount)),
        amountPaid: new (Prisma as any).Decimal(0),
        status: 'PENDING',
        idempotencyKey: opts?.idempotencyKey ?? null,
        session: fee.academicSession ?? 'General',
        semester: fee.semester ?? undefined,
        dueDate: fee.paymentDeadline ?? undefined,
      },
      select: { id: true, invoiceNumber: true },
    });
  });
  return { invoiceId: created.id, invoiceNumber: created.invoiceNumber, created: true, fee };
}

async function ensureInvoiceForFeeAssignment(studentId: number, assignmentId: number, opts?: { idempotencyKey?: string }) {
  const assignment = await prisma.feeAssignment.findUnique({
    where: { id: assignmentId, targetStudentId: studentId },
    include: {
      fee: {
        select: {
          id: true, name: true, feeCode: true, academicSession: true, semester: true,
          paymentDeadline: true, amount: true, currency: true,
        },
      },
    },
  });
  if (!assignment) throw new AppError('Assignment not found', 404);

  const fee = assignment.fee as any;
  const targetAmount = (assignment.overrideAmount != null) ? Number(assignment.overrideAmount) : Number(fee.amount);
  const targetDueDate = (assignment as any).overrideDeadline || fee.paymentDeadline;
  const targetSession = (assignment as any).session || fee.academicSession || 'General';
  const targetSemester = (assignment as any).semester ?? fee.semester ?? undefined;

  if (opts?.idempotencyKey) {
    const existingByKey = await prisma.invoice.findFirst({
      where: {
        idempotencyKey: opts.idempotencyKey,
        studentId,
        feeId: fee.id,
      },
      select: { id: true, invoiceNumber: true, amountDue: true, amountPaid: true, status: true },
    });
    if (existingByKey) {
      const bal = Number(existingByKey.amountDue) - Number(existingByKey.amountPaid);
      if (bal <= 0 && existingByKey.status === 'PAID') {
        throw new AppError('This fee is already paid.', 409);
      }
      return {
        invoiceId: existingByKey.id,
        invoiceNumber: existingByKey.invoiceNumber,
        created: false,
        fee,
      };
    }
  }

  const candidates = await prisma.invoice.findMany({
    where: {
      studentId,
      feeId: fee.id,
      status: { in: ['UNPAID', 'PENDING', 'PARTIALLY_PAID'] as any },
      createdAt: { gte: new Date(String(assignment.assignedAt)) },
    },
    select: { id: true, invoiceNumber: true, amountDue: true, amountPaid: true, status: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });

  const matched = candidates.filter((c: any) => {
    const due = Number((c as any).amountDue ?? 0);
    return Math.abs(due - targetAmount) < 0.01;
  });

  if (matched.length > 0) {
    const reuse = matched[0];
    const bal = Number(reuse.amountDue) - Number(reuse.amountPaid);
    if (bal <= 0) throw new AppError('This fee is already paid.', 409);
    return { invoiceId: reuse.id, invoiceNumber: reuse.invoiceNumber, created: false, fee };
  }

  const created = await prisma.$transaction(async (tx: any) => {
    const baseRow = (await (tx as any).$queryRaw(
      Prisma.sql`SELECT COALESCE(MAX(id),0)+1 AS next_id FROM invoices FOR UPDATE`,
    )) as unknown as Array<{ next_id: number }>;
    let nextId = Number(baseRow?.[0]?.next_id ?? 0);
    if (Number.isNaN(nextId) || nextId <= 0) nextId = 1;
    const fiscalYear = (fee.academicSession && fee.academicSession.split('/')?.[0])
      ?? ((assignment as any).session && (assignment as any).session.split('/')?.[0])
      ?? String(new Date().getFullYear());
    const invRef = generateInvoiceReference(nextId, fiscalYear);
    return tx.invoice.create({
      data: {
        invoiceNumber: invRef,
        student: { connect: { id: studentId } },
        fee: { connect: { id: fee.id } },
        amountDue: new (Prisma as any).Decimal(String(targetAmount)),
        amountPaid: new (Prisma as any).Decimal(0),
        status: 'PENDING',
        idempotencyKey: opts?.idempotencyKey ?? `DA-${assignmentId}-${Math.floor(Date.now()/60000)}`,
        session: targetSession,
        semester: targetSemester ?? undefined,
        dueDate: targetDueDate ?? undefined,
      },
      select: { id: true, invoiceNumber: true },
    });
  });
  return { invoiceId: created.id, invoiceNumber: created.invoiceNumber, created: true, fee };
}

const AssignmentIdParam = z.object({ assignmentId: z.coerce.number().int().positive() });

router.post(
  '/fee-assignments/:assignmentId/ensure-invoice',
  protect,
  restrictTo(Role.STUDENT),
  validateParams(AssignmentIdParam),
  catchAsync(async (req: any, res) => {
    const idempotencyKey = (req.headers?.['idempotency-key'] as string) || req.body?.idempotencyKey;
    const opts: any = idempotencyKey ? { idempotencyKey: String(idempotencyKey).slice(0, 128) } : undefined;
    const result = await ensureInvoiceForFeeAssignment(Number(req.user?.id), Number(req.params.assignmentId), opts);
    res.status(200).json({
      status: 'success',
      data: {
        invoiceId: result.invoiceId,
        invoiceNumber: result.invoiceNumber,
        created: result.created,
        fee: {
          id: result.fee.id, feeCode: result.fee.feeCode, name: result.fee.name,
          amount: Number(result.fee.amount),
          currency: (result.fee as any).currency,
          academicSession: result.fee.academicSession,
          semester: result.fee.semester,
        },
      },
    });
  }),
);

const AssignmentInitiateValidator = [validateParams(AssignmentIdParam), validateBody(_FeeInitiateInnerSchema)];

router.post(
  '/fee-assignments/:assignmentId/pay',
  protect,
  restrictTo(Role.STUDENT),
  ...AssignmentInitiateValidator,
  catchAsync(async (req: any, res) => {
    const studentId = Number(req.user?.id);
    const assignmentId = Number(req.params.assignmentId);
    const partialAmount = req.body?.partialAmount;
    const idempotencyKey: string | undefined =
      (req.headers?.['idempotency-key'] as string) ||
      (typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey : undefined);
    const ensured = await ensureInvoiceForFeeAssignment(
      studentId,
      assignmentId,
      idempotencyKey ? { idempotencyKey: String(idempotencyKey).slice(0, 128) } : undefined,
    );
    const initInput: any = { invoiceId: ensured.invoiceId };
    if (partialAmount !== undefined && partialAmount !== null) {
      initInput.partialAmount = partialAmount;
    }
    if (typeof req.body?.email === 'string' && req.body.email.trim()) initInput.email = req.body.email.trim();
    if (idempotencyKey) initInput.idempotencyKey = String(idempotencyKey).slice(0, 128);
    const result = await PaymentService.initiatePayment(studentId, initInput, req);
    res.status(200).json({ status: 'success', data: { ...result, invoiceId: ensured.invoiceId } });
  }),
);

router.post(
  '/fees/:feeId/ensure-invoice',
  protect,
  restrictTo(Role.STUDENT),
  validateParams(FeeIdParam),
  catchAsync(async (req: any, res) => {
    const idempotencyKey = (req.headers?.['idempotency-key'] as string) || req.body?.idempotencyKey;
    const opts: any = idempotencyKey ? { idempotencyKey: String(idempotencyKey).slice(0, 128) } : undefined;
    const result = await ensureInvoiceForFee(Number(req.user?.id), Number(req.params.feeId), opts);
    res.status(200).json({
      status: 'success',
      data: {
        invoiceId: result.invoiceId,
        invoiceNumber: result.invoiceNumber,
        created: result.created,
        fee: {
          id: result.fee.id, feeCode: result.fee.feeCode, name: result.fee.name,
          amount: Number(result.fee.amount),
          currency: (result.fee as any).currency,
          academicSession: result.fee.academicSession,
          semester: result.fee.semester,
        },
      },
    });
  }),
);

router.post(
  '/fees/:feeId/initiate',
  protect,
  restrictTo(Role.STUDENT),
  ...FeeInitiateValidator,
  catchAsync(async (req: any, res) => {
    const studentId = Number(req.user?.id);
    const feeId = Number(req.params.feeId);
    const partialAmount = req.body?.partialAmount;
    const idempotencyKey: string | undefined =
      (req.headers?.['idempotency-key'] as string) ||
      (typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey : undefined);
    const ensured = await ensureInvoiceForFee(studentId, feeId, idempotencyKey ? { idempotencyKey: String(idempotencyKey).slice(0, 128) } : undefined);
    const initInput: any = { invoiceId: ensured.invoiceId };
    if (partialAmount !== undefined && partialAmount !== null) {
      initInput.partialAmount = partialAmount;
    }
    if (typeof req.body?.email === 'string' && req.body.email.trim()) initInput.email = req.body.email.trim();
    if (idempotencyKey) initInput.idempotencyKey = String(idempotencyKey).slice(0, 128);
    const result = await PaymentService.initiatePayment(studentId, initInput, req);
    res.status(200).json({ status: 'success', data: { ...result, invoiceId: ensured.invoiceId } });
  }),
);

// ---------- All routes below require ADMIN | BURSARY ------------------------
router.use(protect);
router.use(restrictTo(Role.ADMIN, Role.BURSARY));

router.get('/', requirePermission('VIEW_STUDENTS'), validateQuery(StudentQuerySchema), listStudents);
router.post('/', requirePermission('CREATE_STUDENT'), validateBody(CreateStudentSchema), createStudent);
router.get('/:id', getStudent);
router.patch('/:id', validateBody(UpdateStudentSchema), updateStudent);
router.post('/:id/status', requirePermission('CREATE_STUDENT'), setStudentStatus);
router.post('/:id/reset-password', requirePermission('MANAGE_USERS'), resetStudentPassword);
const MatricParam = z.object({ matric: z.string().min(3).max(50).trim() });
router.get('/matric/:matric', requirePermission('VIEW_STUDENTS'), validateParams(MatricParam), getStudentByMatric);

// DELETE /students/:id — ADMIN only (Bursary cannot permanently delete).
// Financial integrity gate: students with ANY invoice / receipt / transaction /
// refund record cannot be deleted (409). Otherwise: cleanup audit_logs.userId +
// refresh_tokens + user row, identical to /admin/users/:id handler.
const DeleteStudentParam = z.object({ id: z.coerce.number().int().min(1) });
const DELETE_STUDENT_PROTECTED_IDS = new Set<number>([1, 2, 48]);
router.delete(
  '/:id',
  restrictTo(Role.ADMIN),
  requirePermission('MANAGE_USERS'),
  validateParams(DeleteStudentParam),
  catchAsync(async (req: any, res: any) => {
    const id = Number(req.params.id);
    const existing = await prisma.user.findUnique({
      where: { id },
      select: { id: true, role: true, email: true, firstName: true, lastName: true, accountStatus: true },
    });
    if (!existing) return res.status(404).json({ status: 'fail', error: 'Student not found' });
    if (existing.role !== Role.STUDENT) {
      return res.status(400).json({
        status: 'fail',
        error: `This endpoint deletes STUDENT accounts only; this user is ${existing.role}. Use /admin/users/:id instead.`,
        code: 'WRONG_ROLE_FOR_ENDPOINT',
      });
    }
    if (DELETE_STUDENT_PROTECTED_IDS.has(id)) {
      return res.status(403).json({
        status: 'fail',
        error: 'Cannot delete protected id',
        code: 'PROTECTED_ID',
      });
    }
    const [invoices, receipts, transactions, refundsAsRequester, refundsViaTx] = await Promise.all([
      prisma.invoice.count({ where: { studentId: id } }),
      prisma.receipt.count({ where: { studentId: id } }),
      prisma.transaction.count({ where: { userId: id } }),
      prisma.refund.count({ where: { requestedById: id } }),
      prisma.refund.count({ where: { originalTransaction: { userId: id } } }),
    ]);
    const totalFin = invoices + receipts + transactions + refundsAsRequester + refundsViaTx;
    if (totalFin > 0) {
      const breakdown: string[] = [];
      if (invoices > 0) breakdown.push(`${invoices} invoice(s)`);
      if (receipts > 0) breakdown.push(`${receipts} receipt(s)`);
      if (transactions > 0) breakdown.push(`${transactions} transaction(s)`);
      if (refundsAsRequester + refundsViaTx > 0) breakdown.push(`${refundsAsRequester + refundsViaTx} refund record(s)`);
      return res.status(409).json({
        status: 'fail',
        error: 'Cannot delete student with generated invoices / payments. Suspend or mark WITHDRAWN instead.',
        code: 'STUDENT_HAS_FINANCIAL_RECORDS',
        breakdown,
      });
    }
    await prisma.$transaction(async (tx: any) => {
      await tx.auditLog.updateMany({ where: { userId: id }, data: { userId: null } });
      await tx.refreshToken.deleteMany({ where: { userId: id } });
      await tx.user.delete({ where: { id } });
    });
    try {
      await (prisma as any).auditLog.create({
        data: {
          action: 'DELETE_STUDENT',
          entityType: 'USER',
          entityId: String(id),
          userId: (req as any).user?.id ?? null,
          ipAddress: (req as any).ip?.slice?.(0, 64) ?? null,
          userAgent: (req as any).headers?.['user-agent']?.slice?.(0, 512) ?? null,
          oldValue: { id, email: existing.email, role: existing.role, firstName: existing.firstName, lastName: existing.lastName },
          details: { noFinancialRecords: true },
        },
      });
    } catch { /* swallow */ }
    return res.status(200).json({ status: 'success', data: { id, deleted: true } });
  }),
);

export default router;
