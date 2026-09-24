import express from 'express';
import { protect, restrictTo } from '../middlewares/auth';
import {
  createDirectStudentBill,
  createFeeAssignment,
  generateInvoices,
  getFeeAssignment,
  listFeeAssignments,
  manualStudentInvoice,
  updateFeeAssignment,
} from '../controllers/feeAssignments';

const router = express.Router();

router.use(protect);

// ADMIN | BURSARY may read, create, patch assignments and trigger generates.
router.get('/', restrictTo('ADMIN', 'BURSARY'), listFeeAssignments);
router.get('/:id', restrictTo('ADMIN', 'BURSARY'), getFeeAssignment);
router.post('/', restrictTo('ADMIN', 'BURSARY'), createFeeAssignment);
router.patch('/:id', restrictTo('ADMIN', 'BURSARY'), updateFeeAssignment);
router.post('/:id/generate-invoices', restrictTo('ADMIN', 'BURSARY'), generateInvoices);
router.post('/manual-student', restrictTo('ADMIN', 'BURSARY'), manualStudentInvoice);
router.post('/student-bill', restrictTo('ADMIN', 'BURSARY'), createDirectStudentBill);

export default router;
