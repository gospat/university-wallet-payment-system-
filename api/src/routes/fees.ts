import express, { Request, Response } from 'express';
import { z } from 'zod';
import { protect, restrictTo, requirePermission } from '../middlewares/auth';
import { validateParams } from '../middlewares/validate';
import { catchAsync } from '../utils/catchAsync';
import {
  activateFee,
  cloneFee,
  createFee,
  createFeeCategory,
  deleteFee,
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
import { buildTwoSheetWorkbook } from '../utils/xlsxTemplate';
import { csvLineSafe } from '../utils/security';
import { assertCanManageTemplates } from '../utils/templateAuth';

const router = express.Router();

// ============ TEMPLATE ROUTES (mounted BEFORE protect — inline auth with HTML fallback) ============

const FRONTEND_URL_FEES = process.env.FRONTEND_URL || 'http://localhost:5173';

// --- Fees templates (ADMIN | BURSARY) ---
router.get('/template.csv', catchAsync(async (req: Request, res: Response) => {
  const auth = await assertCanManageTemplates(req, ['ADMIN', 'BURSARY'], { frontendUrl: FRONTEND_URL_FEES });
  if (!auth.ok) {
    return res.status(401).type('text/html').send(auth.html!);
  }
  const BOM = '\uFEFF';
  const headers = [
    'feeCode (required, unique per session)',
    'name (required)',
    'categoryCode (required e.g. TUITION, ACCEPTANCE, LIBRARY, OTHER)',
    'amount (required, NGN)',
    'academicSession (required e.g. 2025/2026)',
    'semester (optional: FIRST / SECOND / THIRD)',
    'collegeCode (optional; scope to College)',
    'departmentCode (optional; scope to Dept)',
    'programmeCode (optional; scope to Programme)',
    'studentType (optional: UNDERGRADUATE / POSTGRADUATE / PART_TIME / JUPEB / OTHER)',
    'paymentDeadline (optional YYYY-MM-DD)',
    'isMandatory (optional true/false, default true)',
    'isActive (optional true/false, default true)',
    'description (optional)',
  ];
  const sample1 = [
    'FEE-TUIT-001',
    'BSc Computer Science Tuition (Year 1)',
    'TUITION',
    '500000.00',
    '2025/2026',
    '',
    'COS',
    'CSC',
    'BScCS',
    'UNDERGRADUATE',
    '2025-12-01',
    'true',
    'true',
    'Tuition fee for regular academic session',
  ];
  const sample2 = [
    'FEE-LIB-2025',
    'Library Access Fee (All students)',
    'LIBRARY',
    '15000.00',
    '2025/2026',
    '',
    '',
    '',
    '',
    '',
    '2025-11-30',
    'true',
    'true',
    'Leave college/department/programme columns EMPTY for a GLOBAL fee visible to ALL students',
  ];
  const content =
    BOM +
    '# Required columns: feeCode, name, categoryCode, amount, academicSession\r\n' +
    '# Leave collegeCode/departmentCode/programmeCode EMPTY for a GLOBAL fee (every student sees it).\r\n' +
    '# Match category either by CODE (preferred) or by numeric ID. Scope codes come from the Colleges/Depts/Programmes pages.\r\n' +
    csvLineSafe(headers) +
    csvLineSafe(sample1) +
    csvLineSafe(sample2);
  res.attachment('fees-import-template.csv');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.status(200).send(content);
}));

router.get('/template.xlsx', catchAsync(async (req: Request, res: Response) => {
  const auth = await assertCanManageTemplates(req, ['ADMIN', 'BURSARY'], { frontendUrl: FRONTEND_URL_FEES });
  if (!auth.ok) {
    return res.status(401).type('text/html').send(auth.html!);
  }
  const templateHeader = [
    'feeCode',
    'name',
    'categoryCode',
    'amount',
    'academicSession',
    'semester',
    'collegeCode',
    'departmentCode',
    'programmeCode',
    'studentType',
    'paymentDeadline',
    'isMandatory',
    'isActive',
    'description',
  ];
  const templateSamples = [
    [
      'FEE-TUIT-001',
      'BSc Computer Science Tuition (Year 1)',
      'TUITION',
      '500000.00',
      '2025/2026',
      '',
      'COS',
      'CSC',
      'BScCS',
      'UNDERGRADUATE',
      '2025-12-01',
      'true',
      'true',
      'Tuition fee for regular academic session',
    ],
    [
      'FEE-LIB-2025',
      'Library Access Fee (All students)',
      'LIBRARY',
      '15000.00',
      '2025/2026',
      '',
      '',
      '',
      '',
      '',
      '2025-11-30',
      'true',
      'true',
      'Leave college/department/programme columns EMPTY for a GLOBAL fee visible to ALL students',
    ],
  ];
  const colWidths = [14, 38, 16, 12, 18, 12, 14, 16, 16, 18, 18, 12, 12, 40];
  const instructionRows: string[][] = [
    ['#', 'Topic', 'Rule / Description', 'Example'],
    ['1', 'Upload Order', 'Upload Fees AFTER Colleges/Departments/Programmes are set up so codes resolve correctly', 'Colleges → Depts → Programmes → Fees'],
    ['2', 'Global Fee Scope', 'Leave collegeCode/departmentCode/programmeCode EMPTY for a GLOBAL fee visible to all students', '(all three blank)'],
    ['3', 'categoryCode', 'Must match Fee Category code (TUITION, LIBRARY, ACCEPTANCE, IDCARD, OTHER, etc.)', 'TUITION'],
    ['4', 'amount', 'Numeric value in NGN, no ₦ symbol, 2 decimals allowed', '500000.00'],
    ['5', 'academicSession', 'Format e.g. 2025/2026; blank allowed (no session auto-assigned)', '2025/2026'],
    ['6', 'Scope Codes', 'collegeCode/departmentCode/programmeCode — use Code field values (NOT numeric id) from respective pages', 'COS / CSC / BScCS'],
    ['7', 'Boolean Columns', 'isMandatory / isActive — literal TRUE or FALSE (lowercase or uppercase both accepted)', 'TRUE'],
    ['8', 'paymentDeadline', 'Strict YYYY-MM-DD date format', '2025-12-31'],
  ];
  const columnNotes = [
    { header: 'feeCode', required: true, note: 'Unique fee code per academic session. Max 50 chars.' },
    { header: 'name', required: true, note: 'Human-readable fee name. Max 200 chars.' },
    { header: 'categoryCode', required: true, note: 'Must match an existing Fee Category code.' },
    { header: 'amount', required: true, note: 'NGN amount, numeric only, 2 decimals optional.' },
    { header: 'academicSession', required: true, note: 'Session label e.g. 2025/2026.' },
    { header: 'semester', required: false, note: 'FIRST / SECOND / THIRD — blank = all semesters.' },
    { header: 'collegeCode', required: false, note: 'Scope fee to a College. Blank = all Colleges.' },
    { header: 'departmentCode', required: false, note: 'Scope fee to a Department. Blank = all Depts.' },
    { header: 'programmeCode', required: false, note: 'Scope fee to a Programme. Blank = all Programmes.' },
    { header: 'studentType', required: false, note: 'UNDERGRADUATE / POSTGRADUATE / PART_TIME / JUPEB / OTHER.' },
    { header: 'paymentDeadline', required: false, note: 'YYYY-MM-DD. Blank = no deadline.' },
    { header: 'isMandatory', required: false, note: 'TRUE/FALSE — default TRUE if blank.' },
    { header: 'isActive', required: false, note: 'TRUE/FALSE — default TRUE if blank.' },
    { header: 'description', required: false, note: 'Free-form notes about the fee.' },
  ];
  const xlsx = await buildTwoSheetWorkbook({
    title: 'Fee Catalogue — Bulk Import Template',
    instructionRows,
    templateHeader,
    templateSamples,
    colWidths,
    columnNotes,
  });
  res.attachment('fees-import-template.xlsx');
  res.setHeader('Content-Type', xlsx.mimeType);
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.status(200).send(xlsx.buffer);
}));

router.use(protect);
router.use(restrictTo('ADMIN', 'BURSARY'));

// FeeCategory CRUD — ADMIN | BURSARY
router.get('/categories', requirePermission('VIEW_BILL_CATEGORIES'), listFeeCategories);
router.get('/categories/:id', requirePermission('VIEW_BILL_CATEGORIES'), getFeeCategory);
router.post('/categories', requirePermission('EDIT_FEE'), createFeeCategory);
router.patch('/categories/:id', requirePermission('EDIT_FEE'), updateFeeCategory);
router.delete('/categories/:id', requirePermission('EDIT_FEE'), deleteFeeCategory);

// Fee CRUD
router.get('/', requirePermission('VIEW_BILLS_CATALOGUE'), listFees);
router.get('/:id', requirePermission('VIEW_BILLS_CATALOGUE'), getFee);
router.post('/', requirePermission('CREATE_FEE'), createFee);
router.patch('/:id', requirePermission('EDIT_FEE'), updateFee);
router.delete('/:id', requirePermission('EDIT_FEE'), deleteFee);
router.post('/:id/clone', requirePermission('CREATE_FEE'), cloneFee);
router.post('/:id/activate', requirePermission('EDIT_FEE'), activateFee);
router.post('/:id/disable', requirePermission('EDIT_FEE'), disableFee);

// Fee bulk upload (reuses admin stage/preview/confirm pattern)
const BulkIdParam = z.object({ id: z.string().min(3).max(100).trim() });
router.post('/bulk-upload', requirePermission('BULK_UPLOAD_FEES'), stageFeeBulkUpload as any);
router.get('/bulk-upload/:id', requirePermission('BULK_UPLOAD_FEES'), previewFeeBulkUpload as any);
router.post('/bulk-upload/:id/confirm', requirePermission('BULK_UPLOAD_FEES'), confirmFeeBulkUpload as any);
router.get('/bulk-upload/:id/errors.csv', requirePermission('BULK_UPLOAD_FEES'), validateParams(BulkIdParam), downloadFeeErrorCsv);

export default router;
