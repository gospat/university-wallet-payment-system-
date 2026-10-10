import { Request, Response } from 'express';
import { catchAsync } from '../utils/catchAsync';
import {
  CreateFeeAssignmentSchema,
  DirectStudentBillSchema,
  FeeAssignmentQuerySchema,
  FeeAssignmentService,
  GenerateInvoiceSchema,
  InvoiceEngine,
  ManualInvoiceSchema,
  UpdateFeeAssignmentSchema,
} from '../services/feeAssignment';
import { validateBody, validateParams, validateQuery } from '../middlewares/validate';
import { z } from 'zod';
import { sendStudentBillAssigned } from '../services/email';
import {
  CancelInvoiceBodySchema,
  InvoiceCancellationService,
} from '../services/invoiceCancellation';

const IdParam = z.object({ id: z.coerce.number().int().positive() });
const InvoiceIdParam = z.object({ id: z.coerce.number().int().positive() });

export const cancelInvoice = [
  validateParams(InvoiceIdParam),
  validateBody(CancelInvoiceBodySchema),
  catchAsync(async (req: Request, res: Response) => {
    const actorId = (req as any).user?.id;
    const actorRole = (req as any).user?.role;
    if (!actorId || !actorRole) {
      return res.status(401).json({ status: 'fail', message: 'Authentication required' });
    }
    const result = await InvoiceCancellationService.cancelInvoice({
      invoiceId: Number(req.params.id),
      actorId: Number(actorId),
      actorRole,
      reason: (req.body as any).reason,
      writtenExplanation: (req.body as any).writtenExplanation,
      req,
    });
    return res.status(200).json({ status: 'success', data: result });
  }),
];

export const listFeeAssignments = [
  validateQuery(FeeAssignmentQuerySchema),
  catchAsync(async (req: Request, res: Response) => {
    const data = await FeeAssignmentService.list(req.query as any);
    res.status(200).json({ status: 'success', data });
  }),
];

export const getFeeAssignment = [
  validateParams(IdParam),
  catchAsync(async (req: Request, res: Response) => {
    const assignment = await FeeAssignmentService.getById(Number(req.params.id));
    res.status(200).json({ status: 'success', data: { assignment } });
  }),
];

export const createFeeAssignment = [
  validateBody(CreateFeeAssignmentSchema),
  catchAsync(async (req: Request, res: Response) => {
    const created = await FeeAssignmentService.create(req.body, req);
    res.status(201).json({ status: 'success', data: { assignment: created } });
  }),
];

export const updateFeeAssignment = [
  validateParams(IdParam),
  validateBody(UpdateFeeAssignmentSchema),
  catchAsync(async (req: Request, res: Response) => {
    const updated = await FeeAssignmentService.update(Number(req.params.id), req.body, req);
    res.status(200).json({ status: 'success', data: { assignment: updated } });
  }),
];

export const deleteFeeAssignment = [
  validateParams(IdParam),
  catchAsync(async (req: Request, res: Response) => {
    const result = await FeeAssignmentService.remove(Number(req.params.id), req);
    res.status(200).json({ status: 'success', data: result });
  }),
];

export const generateInvoices = [
  validateParams(IdParam),
  validateQuery(GenerateInvoiceSchema),
  catchAsync(async (req: Request, res: Response) => {
    const force = (req.query as any).force === true || (req.query as any).force === 'true' || (req.query as any).force === '1';
    const data = await InvoiceEngine.generateInvoices(Number(req.params.id), !!force, req);
    res.status(200).json({ status: 'success', data });
  }),
];

export const manualStudentInvoice = [
  validateBody(ManualInvoiceSchema),
  catchAsync(async (req: Request, res: Response) => {
    const data = await InvoiceEngine.manualInvoice(req.body, req);
    res.status(data.created ? 201 : 200).json({ status: 'success', data });
  }),
];

export const createDirectStudentBill = [
  validateBody(DirectStudentBillSchema),
  catchAsync(async (req: Request, res: Response) => {
    const result = await FeeAssignmentService.billStudentByMatric(req.body, req);
    const { assignment, invoice, created, adhocFeeCreated, fee, student, noteToStudent } = result;
    let emailQueued = false;
    let emailError: string | null = null;
    // Fire-and-forget email (non-blocking; swallow errors)
    (async () => {
      try {
        const ok = await sendStudentBillAssigned(student, fee, invoice, assignment, noteToStudent ?? undefined);
        emailQueued = !!ok;
      } catch (e: any) {
        emailError = e?.message ?? String(e);
        try { console.warn('[directBill.email] notify failed:', emailError); } catch {}
      }
    })().catch(() => {});
    res.status(created ? 201 : 200).json({
      status: 'success',
      data: {
        assignment,
        invoice,
        fee,
        student,
        created,
        assignmentCreated: result.assignmentCreated,
        invoiceCreated: result.invoiceCreated,
        adhocFeeCreated,
        emailQueued,
        noteToStudent: noteToStudent ?? null,
      },
    });
  }),
];
