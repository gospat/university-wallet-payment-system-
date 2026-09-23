import express from 'express';
import { protect, restrictTo } from '../middlewares/auth';
import {
  activateFee,
  cloneFee,
  createFee,
  createFeeCategory,
  deleteFeeCategory,
  disableFee,
  getFee,
  getFeeCategory,
  listFeeCategories,
  listFees,
  updateFee,
  updateFeeCategory,
} from '../controllers/fees';
import {
  stageFeeBulkUpload,
  previewFeeBulkUpload,
  confirmFeeBulkUpload,
  downloadFeeErrorCsv,
} from '../controllers/feeBulkUpload';

const router = express.Router();

router.use(protect);
router.use(restrictTo('ADMIN', 'BURSARY'));

// FeeCategory CRUD — ADMIN | BURSARY
router.get('/categories', listFeeCategories);
router.get('/categories/:id', getFeeCategory);
router.post('/categories', restrictTo('ADMIN', 'BURSARY'), createFeeCategory);
router.patch('/categories/:id', restrictTo('ADMIN', 'BURSARY'), updateFeeCategory);
router.delete('/categories/:id', restrictTo('ADMIN', 'BURSARY'), deleteFeeCategory);

// Fee CRUD
router.get('/', listFees);
router.get('/:id', getFee);
router.post('/', restrictTo('ADMIN', 'BURSARY'), createFee);
router.patch('/:id', restrictTo('ADMIN', 'BURSARY'), updateFee);
router.post('/:id/clone', restrictTo('ADMIN', 'BURSARY'), cloneFee);
router.post('/:id/activate', restrictTo('ADMIN', 'BURSARY'), activateFee);
router.post('/:id/disable', restrictTo('ADMIN', 'BURSARY'), disableFee);

export default router;
