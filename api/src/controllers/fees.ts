import { Request, Response } from 'express';
import { catchAsync } from '../utils/catchAsync';
import {
  CloneFeeSchema,
  CreateFeeCategorySchema,
  CreateFeeSchema,
  FeeCategoryService,
  FeeQuerySchema,
  FeeService,
  UpdateFeeCategorySchema,
  UpdateFeeSchema,
} from '../services/fee';
import { validateBody, validateParams, validateQuery } from '../middlewares/validate';
import { z } from 'zod';

const IdParam = z.object({ id: z.coerce.number().int().positive() });

export const listFeeCategories = [
  catchAsync(async (_req: Request, res: Response) => {
    const categories = await FeeCategoryService.list();
    res.status(200).json({ status: 'success', data: { categories } });
  }),
];

export const getFeeCategory = [
  validateParams(IdParam),
  catchAsync(async (req: Request, res: Response) => {
    const cat = await FeeCategoryService.getById(Number(req.params.id));
    res.status(200).json({ status: 'success', data: { category: cat } });
  }),
];

export const createFeeCategory = [
  validateBody(CreateFeeCategorySchema),
  catchAsync(async (req: Request, res: Response) => {
    const created = await FeeCategoryService.create(req.body, req);
    res.status(201).json({ status: 'success', data: { category: created } });
  }),
];

export const updateFeeCategory = [
  validateParams(IdParam),
  validateBody(UpdateFeeCategorySchema),
  catchAsync(async (req: Request, res: Response) => {
    const updated = await FeeCategoryService.update(Number(req.params.id), req.body, req);
    res.status(200).json({ status: 'success', data: { category: updated } });
  }),
];

export const deleteFeeCategory = [
  validateParams(IdParam),
  catchAsync(async (req: Request, res: Response) => {
    await FeeCategoryService.remove(Number(req.params.id), req);
    res.status(200).json({ status: 'success', data: null });
  }),
];

export const listFees = [
  validateQuery(FeeQuerySchema),
  catchAsync(async (req: Request, res: Response) => {
    const data = await FeeService.list(req.query as any);
    res.status(200).json({ status: 'success', data });
  }),
];

export const getFee = [
  validateParams(IdParam),
  catchAsync(async (req: Request, res: Response) => {
    const fee = await FeeService.getById(Number(req.params.id));
    res.status(200).json({ status: 'success', data: { fee } });
  }),
];

export const createFee = [
  validateBody(CreateFeeSchema),
  catchAsync(async (req: Request, res: Response) => {
    const created = await FeeService.create(req.body, req);
    res.status(201).json({ status: 'success', data: { fee: created } });
  }),
];

export const updateFee = [
  validateParams(IdParam),
  validateBody(UpdateFeeSchema),
  catchAsync(async (req: Request, res: Response) => {
    const updated = await FeeService.update(Number(req.params.id), req.body, req);
    res.status(200).json({ status: 'success', data: { fee: updated } });
  }),
];

export const cloneFee = [
  validateParams(IdParam),
  validateBody(CloneFeeSchema),
  catchAsync(async (req: Request, res: Response) => {
    const cloned = await FeeService.clone(Number(req.params.id), req.body, req);
    res.status(201).json({ status: 'success', data: { fee: cloned } });
  }),
];

export const activateFee = [
  validateParams(IdParam),
  catchAsync(async (req: Request, res: Response) => {
    const updated = await FeeService.setActive(Number(req.params.id), true, req);
    res.status(200).json({ status: 'success', data: { fee: updated } });
  }),
];

export const disableFee = [
  validateParams(IdParam),
  catchAsync(async (req: Request, res: Response) => {
    const updated = await FeeService.setActive(Number(req.params.id), false, req);
    res.status(200).json({ status: 'success', data: { fee: updated } });
  }),
];

export const deleteFee = [
  validateParams(IdParam),
  catchAsync(async (req: Request, res: Response) => {
    const removed = await FeeService.remove(Number(req.params.id), req);
    res.status(200).json({ status: 'success', data: removed });
  }),
];
