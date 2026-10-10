import { Role } from '@prisma/client';
import prisma from '../config/database';
import { bumpRolePermsVersion } from '../middlewares/auth';

export const PERMISSION_DEFS: { key: string; name: string; category: string; description?: string }[] = [
  { key: 'VIEW_DASHBOARD', name: 'View Dashboard', category: 'Dashboard' },
  { key: 'VIEW_AUDIT_LOG', name: 'View Audit Log', category: 'Admin' },
  { key: 'VIEW_USERS', name: 'View Users', category: 'Admin' },
  { key: 'MANAGE_USERS', name: 'Manage Users', category: 'Admin' },
  { key: 'VIEW_ROLES', name: 'View Roles', category: 'Admin' },
  { key: 'MANAGE_ROLES', name: 'Manage Roles & Permissions', category: 'Admin' },
  { key: 'IMPERSONATE_USERS', name: 'Impersonate Users', category: 'Admin' },
  { key: 'VIEW_STUDENTS', name: 'View Students', category: 'Students' },
  { key: 'CREATE_STUDENT', name: 'Create Student', category: 'Students' },
  { key: 'MANAGE_STUDENTS', name: 'Manage Students', category: 'Students' },
  { key: 'BULK_UPLOAD_STUDENTS', name: 'Bulk Upload Students', category: 'Students' },
  { key: 'BULK_IMPORT_STUDENTS', name: 'Bulk Import Students', category: 'Students' },
  { key: 'RESEND_CREDENTIALS', name: 'Resend Credentials', category: 'Students' },
  { key: 'MANAGE_STUDENT_PROFILE', name: 'Manage Student Profile', category: 'Students' },
  { key: 'VIEW_IMPORT_HISTORY', name: 'View Import History', category: 'Students' },
  { key: 'VIEW_INVOICES', name: 'View Invoices', category: 'Fees' },
  { key: 'CREATE_INVOICES', name: 'Create Invoices', category: 'Fees' },
  { key: 'UPDATE_INVOICES', name: 'Update Invoices', category: 'Fees' },
  { key: 'VOID_INVOICES', name: 'Void / Cancel Invoices', category: 'Fees', description: 'Cancel unpaid invoices that have no successful payments or unresolved pending transactions.' },
  { key: 'VIEW_TRANSACTIONS', name: 'View Transactions', category: 'Payments' },
  { key: 'MANUAL_TRANSACTION', name: 'Post Manual Transaction', category: 'Payments' },
  { key: 'REVERSE_TRANSACTION', name: 'Reverse Transaction', category: 'Payments' },
  { key: 'VOID_TRANSACTIONS', name: 'Void / Cancel Transactions', category: 'Payments', description: 'Cancel or abandon individual payment attempts that have no financial postings.' },
  { key: 'VIEW_RECEIPTS', name: 'View Receipts', category: 'Receipts' },
  { key: 'ISSUE_RECEIPTS', name: 'Issue Receipts', category: 'Receipts' },
  { key: 'CANCEL_RECEIPTS', name: 'Cancel / Void Receipts', category: 'Receipts' },
  { key: 'VIEW_REFUNDS', name: 'View Refunds', category: 'Payments' },
  { key: 'INITIATE_REFUNDS', name: 'Initiate Refunds', category: 'Payments' },
  { key: 'APPROVE_REFUNDS', name: 'Approve Refunds', category: 'Payments' },
  { key: 'VIEW_SETTLEMENTS', name: 'View Settlements', category: 'Payments' },
  { key: 'CREATE_SETTLEMENTS', name: 'Record Settlements', category: 'Payments' },
  { key: 'VIEW_BILL_CATEGORIES', name: 'View Bill Categories', category: 'Fees' },
  { key: 'VIEW_BILLS_CATALOGUE', name: 'View Bills Catalogue', category: 'Fees' },
  { key: 'CREATE_FEE', name: 'Create Bill / Fee', category: 'Fees' },
  { key: 'EDIT_FEE', name: 'Edit Bill / Fee', category: 'Fees' },
  { key: 'BULK_UPLOAD_FEES', name: 'Bulk Upload Bills', category: 'Fees' },
  { key: 'ASSIGN_FEES', name: 'Assign Bills to Students', category: 'Fees' },
  { key: 'VIEW_PAYMENTS', name: 'View Payments', category: 'Payments' },
  { key: 'VERIFY_PAYMENT', name: 'Verify Payment', category: 'Payments' },
  { key: 'DIRECT_BILL_STUDENT', name: 'Bill a Student (Direct Billing)', category: 'Direct Billing' },
  { key: 'VIEW_DIRECT_BILLS_LOG', name: 'View Direct Bills Log', category: 'Direct Billing' },
  { key: 'GENERATE_RECEIPT', name: 'Generate Receipt', category: 'Receipts' },
  { key: 'VERIFY_RECEIPT', name: 'Verify Receipt Authenticity', category: 'Receipts' },
  { key: 'PROCESS_REFUND', name: 'Process Refund', category: 'Payments' },
  { key: 'VIEW_COLLEGES', name: 'View Colleges', category: 'Academic Structure' },
  { key: 'VIEW_DEPARTMENTS', name: 'View Departments', category: 'Academic Structure' },
  { key: 'VIEW_PROGRAMMES', name: 'View Programmes', category: 'Academic Structure' },
  { key: 'VIEW_RECONCILIATION', name: 'View Reconciliation Dashboard', category: 'Reconciliation' },
  { key: 'VIEW_RECONCILIATION_REPORTS', name: 'View Reconciliation Reports', category: 'Reconciliation' },
  { key: 'RESOLVE_EXCEPTIONS', name: 'Resolve Reconciliation Exceptions', category: 'Reconciliation' },
  { key: 'EXPORT_RECONCILIATION', name: 'Export Reconciliation', category: 'Reconciliation' },
  { key: 'RUN_RECONCILIATION', name: 'Run Reconciliation', category: 'Reconciliation' },
  { key: 'SYSTEM_SETTINGS', name: 'System Settings', category: 'Admin' },
  { key: 'PAYSTACK_CONFIG', name: 'Payment Configuration', category: 'Admin' },
  { key: 'MANAGE_PAYMENT_PROVIDERS', name: 'Manage Payment Providers', category: 'Admin' },
  { key: 'VIEW_SETTINGS', name: 'View Settings', category: 'Admin' },
  { key: 'MANAGE_SETTINGS', name: 'Manage Settings', category: 'Admin' },
  { key: 'MANAGE_EMAIL_TEMPLATES', name: 'Manage Email Templates', category: 'Admin' },
  { key: 'VIEW_QUEUES', name: 'View Background Queues', category: 'Admin' },
  { key: 'FLUSH_QUEUES', name: 'Flush Background Queues', category: 'Admin' },
  { key: 'AUDIT_LOGS_VIEW_FULL', name: 'Audit Logs (Full)', category: 'Admin' },
  { key: 'AUDIT_LOGS_VIEW_LIMITED', name: 'Audit Logs (Limited)', category: 'Admin' },
  // === BURSARY REPORTS MODULE (existing preserved) ===
  { key: 'REPORTS_VIEW_COLLECTIONS', name: 'Reports: View Collections (R1/R2/R3)', category: 'Reports', description: 'View Daily/Monthly Collection reports and Dashboard collection summary cards' },
  { key: 'REPORTS_VIEW_REVENUE', name: 'Reports: View Revenue-by-Bill & Hierarchical (R4/R7/R9)', category: 'Reports', description: 'View revenue analysis: per bill, collection %, college/dept/programme rollup' },
  { key: 'REPORTS_VIEW_ACCOUNTING', name: 'Reports: View Accounting/GL/Charges (R13/R14/R15/R16)', category: 'Reports', description: 'View Refund, Charges & Fee Income, General Ledger, Receipt Register' },
  { key: 'REPORTS_VIEW_RECONCILIATION', name: 'Reports: View Settlement & Exceptions (R10/R11/R12)', category: 'Reports', description: 'View Payment Gateway, Settlement, and Reconciliation Exception reports' },
  { key: 'REPORTS_VIEW_OUTSTANDING', name: 'Reports: View Outstanding & Debtors (R8/R6/R17)', category: 'Reports', description: 'View Outstanding/Debtors, per-student statements, Transaction Status mix' },
  { key: 'REPORTS_VIEW_STUDENT_STATEMENT', name: 'Reports: View Individual Student Statement (R6)', category: 'Reports', description: 'View chronological ledger-style financial statement for one student by matric' },
  { key: 'REPORTS_EXPORT_EXCEL', name: 'Reports: Export Excel/CSV', category: 'Reports', description: 'Export any report to XLSX / CSV (Excel streaming writer, 250k row cap)' },
  { key: 'REPORTS_EXPORT_PDF', name: 'Reports: Export PDF', category: 'Reports', description: 'Export any report to branded PDF with Bells official header + page numbers' },
  { key: 'REPORTS_SCHEDULE', name: 'Reports: Schedule Recurring (R20)', category: 'Reports', description: 'Create, edit, pause BullMQ-based scheduled report jobs (ADMIN only; Bursary excluded)' },
  { key: 'VIEW_REPORTS', name: 'View Reports', category: 'Reports' },
  { key: 'EXPORT_REPORTS', name: 'Export Reports', category: 'Reports' },
  { key: 'SCHEDULE_REPORTS', name: 'Schedule Reports', category: 'Reports' },
];

const ALL_PERMISSION_KEYS = PERMISSION_DEFS.map((p) => p.key);

const BURSARY_EXCLUDED = new Set([
  'MANAGE_USERS',
  'MANAGE_ROLES',
  'PAYSTACK_CONFIG',
  'SYSTEM_SETTINGS',
  'AUDIT_LOGS_VIEW_FULL',
  // R20: Scheduled Reports is Admin-only (automated emailing with BullMQ = elevated trust)
  'REPORTS_SCHEDULE',
]);

const BURSARY_PERMISSION_KEYS = ALL_PERMISSION_KEYS.filter(
  (k) => !BURSARY_EXCLUDED.has(k),
);

export async function seedPermissions() {
  // === Pre-sweep: DELETE any BURSARY RolePermission rows for keys in BURSARY_EXCLUDED
  // (idempotent cleanup — upsert-only below would otherwise preserve stale grants
  //  e.g. REPORTS_SCHEDULE from legacy seeding before BURSARY_EXCLUDED existed)
  try {
    const excludedPermIds = await prisma.permission.findMany({
      where: { key: { in: Array.from(BURSARY_EXCLUDED) } },
      select: { id: true, key: true },
    });
    if (excludedPermIds.length > 0) {
      await prisma.rolePermission.deleteMany({
        where: {
        role: Role.BURSARY,
          permissionId: { in: excludedPermIds.map(p => p.id) },
      },
      });
    }
  } catch (e) {
    const msg = (e as Error)?.message ?? '';
    if (!msg.toLowerCase().includes('not') || !msg.toLowerCase().includes('exist')) {
      console.warn('[seedPermissions] BURSARY excluded-key pre-sweep note:', msg.slice(0, 180));
    }
  }

  for (const def of PERMISSION_DEFS) {
    await prisma.permission.upsert({
      where: { key: def.key },
      create: {
        key: def.key,
        name: def.name,
        category: def.category,
        description: def.description ?? null,
      },
      update: {
        name: def.name,
        category: def.category,
        description: def.description ?? undefined,
      },
    });
  }
  bumpRolePermsVersion();

  const keyToIdMap = new Map<string, number>();
  const allPerms = await prisma.permission.findMany({
    where: { key: { in: ALL_PERMISSION_KEYS } },
    select: { id: true, key: true },
  });
  for (const p of allPerms) keyToIdMap.set(p.key, p.id);

  // === ROLE-PERMISSION UPSERT: ONLY FOR FRESH-FIRST-RUN (zero rows per role) =========
  // Admin customizes role permissions in the Admin → Roles UI: they can remove
  // Students VIEW/CREATE/UPLOAD from Bursary, add/remove Bill permissions, etc.
  // Old behavior: ALWAYS upsert every default ADMIN=39 + BURSARY=33 rows on
  // EVERY server boot → if Admin deleted a row via saveRolePermissions → next
  // server restart upsert's `create` branch RE-ADDED the deleted rows (the
  // unique compound `(role, permissionId)` was not found → create fires with
  // the default grant) → the exact bug reported by user: "I unticked Students
  // from Admin → Bursary card saved, panel still shows Student Management".
  //
  // Fix: Seed default role-perms ONLY if the role has ZERO rolePermission rows
  // (fresh database / zero rows). If >= 1 row exists for a role, Admin has
  // ALREADY interacted with that role via the Roles UI (or from a previous
  // seed that they then customized). We MUST NOT overwrite their customizations
  // on subsequent boots. Permission rows alone are always upserted (name/description
  // changes) above — we only skip role-permission assignment upserts for
  // already-customized roles. BURSARY_EXCLUDED pre-sweep at top still runs so
  // forbidden keys (MANAGE_ROLES, REPORTS_SCHEDULE etc.) are never present for
  // Bursary even on old databases — that behavior is preserved.
  const existingRoleCountsRaw = await prisma.rolePermission.groupBy({
    by: ['role'],
    where: { role: { in: [Role.ADMIN, Role.BURSARY] } },
    _count: { role: true },
  });
  const existingCountByRole = new Map<string, number>();
  for (const row of existingRoleCountsRaw) existingCountByRole.set(row.role, row._count.role);

  const adminCount = existingCountByRole.get(Role.ADMIN) ?? 0;
  if (adminCount === 0) {
    for (const key of ALL_PERMISSION_KEYS) {
      const permissionId = keyToIdMap.get(key);
      if (!permissionId) continue;
      await prisma.rolePermission.upsert({
        where: { role_permissionId: { role: Role.ADMIN, permissionId } },
        create: { role: Role.ADMIN, permissionId },
        update: {},
      });
    }
  }

  const bursaryCount = existingCountByRole.get(Role.BURSARY) ?? 0;
  if (bursaryCount === 0) {
    for (const key of BURSARY_PERMISSION_KEYS) {
      const permissionId = keyToIdMap.get(key);
      if (!permissionId) continue;
      await prisma.rolePermission.upsert({
        where: { role_permissionId: { role: Role.BURSARY, permissionId } },
        create: { role: Role.BURSARY, permissionId },
        update: {},
      });
    }
  }

  // TASK B3: Seed atomic receipt_number counter (idempotent).
  // Ensures receipt number generation uses dedicated row instead of MAX(id)+1 race.
  try {
    await prisma.counter.upsert({
      where: { id: 'receipt_number' },
      create: { id: 'receipt_number', value: 1 },
      update: {},
    });
  } catch (e) {
    // Counter model may not yet exist in db during pre-migration seed runs; swallow.
    const msg = (e as Error)?.message ?? '';
    if (msg.toLowerCase().includes('counter') && msg.toLowerCase().includes('exist')) {
      // ignore
    } else {
      console.warn('[seedPermissions] Counter seed note:', msg.slice(0, 180));
    }
  }
}

export default { seedPermissions, PERMISSION_DEFS };
