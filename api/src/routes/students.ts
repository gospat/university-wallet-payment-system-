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
import prisma from '../config/database';
import { Prisma } from '@prisma/client';
import { generateInvoiceReference } from '../utils/paystack';
import { AppError } from '../utils/AppError';

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

    const directFeeIds = new Set(directAssignments.map((da: any) => Number(da.fee.id)));

    const [rows, totalGlobal] = await Promise.all([
      prisma.fee.findMany({
        where: { ...where, id: { notIn: Array.from(directFeeIds) } },
        select: {
          id: true, feeCode: true, name: true, description: true,
          categoryId: true, category: { select: { id: true, name: true, code: true } },
          amount: true, currency: true,
          academicSession: true, semester: true,
          college: true, department: true, program: true, level: true, studentType: true,
          isMandatory: true, paymentDeadline: true, isActive: true,
          createdAt: true, updatedAt: true,
        },
        skip: Math.max(0, skip - directAssignments.length),
        take: pageSize,
        orderBy: { [prismaSortField]: order as 'asc' | 'desc' },
      }),
      prisma.fee.count({ where }),
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

    const combinedCount = directFeeRows.length + globalRows.length;
    const sliceStart = skip > directFeeRows.length ? 0 : Math.max(0, directFeeRows.length - skip);
    const directSlice = directFeeRows.slice(Math.min(skip, directFeeRows.length), directFeeRows.length);
    const finalRows = [...directSlice, ...globalRows].slice(0, pageSize);
    const adjustedTotal = totalGlobal + directFeeRows.length - directFeeIds.size;

    res.status(200).json({
      status: 'success',
      data: {
        fees: finalRows,
        total: Math.max(adjustedTotal, combinedCount),
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
    const fiscalYear = fee.academicSession?.split('/')?.[0] ?? undefined;
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

export default router;
