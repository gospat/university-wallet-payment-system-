import express from 'express';
import { protect, restrictTo, requirePermission } from '../middlewares/auth';
import {
  createDirectStudentBill,
  createFeeAssignment,
  deleteFeeAssignment,
  generateInvoices,
  getFeeAssignment,
  listFeeAssignments,
  manualStudentInvoice,
  updateFeeAssignment,
} from '../controllers/feeAssignments';

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

// TODO: Add GET /direct-bills-logs route with requirePermission('VIEW_DIRECT_BILLS_LOG') middleware
// when the Direct Bills Log list endpoint is implemented for the sidebar view.

export default router;
