import express from 'express';
import { protect, restrictTo, requirePermission } from '../middlewares/auth';
import {
  cancelInvoice,
  createDirectStudentBill,
  createFeeAssignment,
  deleteFeeAssignment,
  disableInvoice,
  enableInvoice,
  generateInvoices,
  getFeeAssignment,
  listFeeAssignments,
  manualStudentInvoice,
  updateFeeAssignment,
} from '../controllers/feeAssignments';
import { Role } from '@prisma/client';

const router = express.Router();

router.use(protect);

// ADMIN | BURSARY may read, create, patch assignments and trigger generates.
router.get('/', requirePermission('ASSIGN_FEES'), listFeeAssignments);
router.get('/:id', requirePermission('ASSIGN_FEES'), getFeeAssignment);
router.post('/', requirePermission('ASSIGN_FEES'), createFeeAssignment);
router.patch('/:id', requirePermission('ASSIGN_FEES'), updateFeeAssignment);
router.delete('/:id', requirePermission('ASSIGN_FEES'), deleteFeeAssignment);
router.post('/:id/generate-invoices', requirePermission('ASSIGN_FEES'), generateInvoices);
router.post('/manual-student', requirePermission('DIRECT_BILL_STUDENT'), manualStudentInvoice);
router.post('/student-bill', requirePermission('DIRECT_BILL_STUDENT'), createDirectStudentBill);

router.post(
  '/invoices/:id/cancel',
  restrictTo(Role.ADMIN, Role.BURSARY),
  requirePermission('VOID_INVOICES'),
  cancelInvoice,
);

router.post(
  '/invoices/:id/disable',
  restrictTo(Role.ADMIN, Role.BURSARY),
  requirePermission('VOID_INVOICES'),
  disableInvoice,
);

router.post(
  '/invoices/:id/enable',
  restrictTo(Role.ADMIN, Role.BURSARY),
  requirePermission('VOID_INVOICES'),
  enableInvoice,
);

export default router;
