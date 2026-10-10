import { Role } from '@prisma/client';
import prisma from '../config/database';
import { bumpRolePermsVersion } from '../middlewares/auth';

// Sensitive ADMIN-ONLY capabilities. Bursary must NEVER receive these even
// when they exist in PERMISSION_DEFS. These controls allow user impersonation,
// queue job destruction, payment-provider credential exposure, refund approval
// authority, and tenant-wide system configuration changes.
const ADMIN_ONLY_SENSITIVE_KEYS = new Set([
  // Identity & privilege escalation
  'IMPERSONATE_USERS',
  'MANAGE_USERS',
  'MANAGE_ROLES',
  // Payments trust / money movement authority
  'APPROVE_REFUNDS',
  'FLUSH_QUEUES',
  // Configuration & secrets
  'MANAGE_SETTINGS',
  'SYSTEM_SETTINGS',
  'PAYSTACK_CONFIG',
  'MANAGE_PAYMENT_PROVIDERS',
  'MANAGE_EMAIL_TEMPLATES',
  // Full-audit exposure
  'AUDIT_LOGS_VIEW_FULL',
  // Automated BullMQ scheduled jobs (elevated trust — BullMQ queue access)
  'REPORTS_SCHEDULE',
  'SCHEDULE_REPORTS',
]);

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

const BURSARY_EXCLUDED = new Set<string>([
  // ALL sensitive ADMIN-ONLY capabilities are always removed from Bursary.
  // The union of ADMIN_ONLY_SENSITIVE_KEYS with a few additional explicit keys.
  ...Array.from(ADMIN_ONLY_SENSITIVE_KEYS),
]);

export const BURSARY_PERMISSION_KEYS = ALL_PERMISSION_KEYS.filter(
  (k) => !BURSARY_EXCLUDED.has(k),
);

// Explicit release-upgrade delta applied to EXISTING Bursary roles during
// upgrade (diffAdd mode). This set intentionally enumerates ONLY the NEW
// cancellation permissions introduced by this release. It MUST NOT be replaced
// with the full BURSARY_PERMISSION_KEYS array — that would re-grant every
// default permission that an administrator had deliberately removed on an
// existing installation. Fresh installations still receive the full
// BURSARY_PERMISSION_KEYS safe default set via mode='full'.
// One-time sentinel id used as a Counter row. If this row EXISTS in the
// database the release-upgrade phase (BURSARY_RELEASE_UPGRADE_KEYS diffAdd for
// existing installs) has ALREADY been applied and MUST NOT be re-attempted on
// subsequent server startups. An administrator who intentionally removes
// VOID_INVOICES or VOID_TRANSACTIONS from a Bursary role after the initial
// upgrade relies on this sentinel to prevent the seed from restoring them on
// the next boot.
// The identifier is intentionally release-specific so future releases that
// introduce another required delta-upgrade can define a NEW sentinel id and
// have their own independent one-time application guarantee.
export const BURSARY_RELEASE_UPGRADE_SENTINEL_ID = 'bursary_release_upgrade_void_20261010';

export const BURSARY_RELEASE_UPGRADE_KEYS: readonly string[] = [
  'VOID_INVOICES',
  'VOID_TRANSACTIONS',
];
// Guard: release-upgrade keys must never contain ADMIN-ONLY sensitive keys.
for (const k of BURSARY_RELEASE_UPGRADE_KEYS) {
  if (ADMIN_ONLY_SENSITIVE_KEYS.has(k)) {
    // Fail loudly at module load time on the extremely off-chance a future
    // editor accidentally lists an admin-only key here.
    throw new Error(
      `[permissionSeed] BURSARY_RELEASE_UPGRADE_KEYS must not include admin-only key: ${k}`,
    );
  }
}
// Guard: release-upgrade keys must be a subset of safe Bursary defaults.
for (const k of BURSARY_RELEASE_UPGRADE_KEYS) {
  if (!BURSARY_PERMISSION_KEYS.includes(k)) {
    throw new Error(
      `[permissionSeed] BURSARY_RELEASE_UPGRADE_KEYS lists non-Bursary-default key: ${k}`,
    );
  }
}

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

  // === ROLE-PERMISSION ASSIGNMENT ==========================================
  // Two modes for each role, explicitly handled so FRESH databases get full
  // defaults and EXISTING databases (bursary/admin has >=1 row with previous
  // manual customizations via Admin -> Roles UI) ONLY ADD new missing keys,
  // never overwriting or deleting Admin's manual permission customizations.
  //
  // BURSARY_EXCLUDED pre-sweep still runs ABOVE so sensitive Admin-only
  // keys are explicitly removed from Bursary regardless of freshness.
  const existingRoleCountsRaw = await prisma.rolePermission.groupBy({
    by: ['role'],
    where: { role: { in: [Role.ADMIN, Role.BURSARY] } },
    _count: { role: true },
  });
  const existingCountByRole = new Map<string, number>();
  for (const row of existingRoleCountsRaw) existingCountByRole.set(row.role, row._count.role);

  /**
   * Apply default role permissions safely.
   *   mode='full'   → upsert every key for role (role count === 0 / FRESH install)
   *   mode='diffAdd' → ONLY create rolePermission rows for keys that are not
   *                     yet assigned → never delete, never overwrite, never upsert
   */
  const safeApplyDefaults = async (
    role: Role,
    defaultKeys: string[],
    mode: 'full' | 'diffAdd',
  ) => {
    const rowsToCreate: { role: Role; permissionId: number }[] = [];
    for (const key of defaultKeys) {
      const permissionId = keyToIdMap.get(key);
      if (!permissionId) continue;
      rowsToCreate.push({ role, permissionId });
    }
    if (rowsToCreate.length === 0) return 0;

    if (mode === 'full') {
      for (const row of rowsToCreate) {
        await prisma.rolePermission.upsert({
          where: { role_permissionId: { role: row.role, permissionId: row.permissionId } },
          create: row,
          update: {},
        });
      }
      return rowsToCreate.length;
    }

    // diffAdd mode (existing customized database): ONLY INSERT rows that are
    // missing. We deliberately do NOT touch existing rows so admins' saved
    // role-permission customizations (e.g., remove Students VIEW from Bursary)
    // are preserved across upgrades/server-boot seeding runs.
    const existingForRole = new Set<number>();
    const existingRows = await prisma.rolePermission.findMany({
      where: { role },
      select: { permissionId: true },
    });
    for (const row of existingRows) existingForRole.add(row.permissionId);

    const missing = rowsToCreate.filter((r) => !existingForRole.has(r.permissionId));
    if (missing.length === 0) return 0;

    // createMany so we don't re-issue individual upsert calls (safe because
    // we've already filtered to rows that don't exist).
    try {
      const createRes = await prisma.rolePermission.createMany({
        data: missing,
        skipDuplicates: true,
      });
      return createRes.count ?? 0;
    } catch {
      // Fallback: MySQL versions before 8.0.20 / older drivers may not
      // support createMany skipDuplicates. Issue individual createOrIgnore
      // tries instead; never throw from seed — don't block server boot.
      let applied = 0;
      for (const row of missing) {
        try {
          await prisma.rolePermission.create({ data: row });
          applied += 1;
        } catch { /* duplicate unique key — another seed beat us; skip */ }
      }
      return applied;
    }
  };

  const adminCount = existingCountByRole.get(Role.ADMIN) ?? 0;
  const adminMode: 'full' | 'diffAdd' = adminCount === 0 ? 'full' : 'diffAdd';
  await safeApplyDefaults(Role.ADMIN, ALL_PERMISSION_KEYS, adminMode);

  const bursaryCount = existingCountByRole.get(Role.BURSARY) ?? 0;
  const bursaryMode: 'full' | 'diffAdd' = bursaryCount === 0 ? 'full' : 'diffAdd';
  if (bursaryMode === 'full') {
    // FRESH installation: Bursary has never had a permission row → grant the
    // complete safe Bursary default set.
    await safeApplyDefaults(Role.BURSARY, BURSARY_PERMISSION_KEYS, bursaryMode);
    // Fresh install does not need the one-time sentinel because the admin has
    // never had a chance to customize anything yet. Still write the sentinel
    // so subsequent boots that re-enter as existing-install (mode='diffAdd')
    // do not re-run RELEASE_UPGRADE_KEYS and potentially restore perms that
    // were later removed by admin after first boot.
    try {
      await prisma.counter.upsert({
        where: { id: BURSARY_RELEASE_UPGRADE_SENTINEL_ID },
        create: { id: BURSARY_RELEASE_UPGRADE_SENTINEL_ID, value: 1 },
        update: {},
      });
    } catch (e) {
      // Counter model may not yet exist in DB during pre-migration seed runs.
      const msg = (e as Error)?.message ?? '';
      if (!(msg.toLowerCase().includes('counter') && msg.toLowerCase().includes('exist'))) {
        console.warn('[seedPermissions] Bursary sentinel upsert note:', msg.slice(0, 180));
      }
    }
  } else {
    // EXISTING installation: Bursary role has been seeded before and admins
    // may have intentionally removed individual grants (e.g., no student
    // create, no email templates etc).
    // E2: ONE-TIME upgrade. If the release-upgrade sentinel row EXISTS in
    // counters, then THIS release has ALREADY applied its delta in a prior
    // server startup. We MUST NOT run RELEASE_UPGRADE_KEYS again — doing so
    // would restore permissions (VOID_INVOICES, VOID_TRANSACTIONS) that the
    // admin intentionally removed after the upgrade.
    let alreadyApplied = false;
    try {
      const sentinelRow = await prisma.counter.findUnique({
        where: { id: BURSARY_RELEASE_UPGRADE_SENTINEL_ID },
        select: { id: true },
      });
      alreadyApplied = !!sentinelRow;
    } catch (e) {
      const msg = (e as Error)?.message ?? '';
      if (msg.toLowerCase().includes('counter') && msg.toLowerCase().includes('exist')) {
        // Counter table doesn't exist yet — pre-migration seed. Fall back to
        // running the delta (it will be the first run anyway so it is safe).
        alreadyApplied = false;
      } else {
        // Unknown DB error: fail-safe NO-OP for the delta-add path so we
        // never re-restore admin-removed permissions when unsure.
        console.warn('[seedPermissions] Bursary sentinel read failed; skipping release-upgrade delta for safety:', msg.slice(0, 180));
        alreadyApplied = true;
      }
    }
    if (!alreadyApplied) {
      // First boot on existing install: delta-add the newly introduced
      // cancellation permissions. Admin-only sensitive keys continue to be
      // removed by the BURSARY_EXCLUDED pre-sweep above and are also
      // explicitly excluded from BURSARY_RELEASE_UPGRADE_KEYS via module
      // load-time guard.
      await safeApplyDefaults(
        Role.BURSARY,
        Array.from(BURSARY_RELEASE_UPGRADE_KEYS),
        bursaryMode,
      );
      // Write the sentinel so FUTURE startups NEVER re-run this delta (even
      // if the admin later removes these keys manually).
      try {
        await prisma.counter.upsert({
          where: { id: BURSARY_RELEASE_UPGRADE_SENTINEL_ID },
          create: { id: BURSARY_RELEASE_UPGRADE_SENTINEL_ID, value: 1 },
          update: {},
        });
      } catch (e) {
        const msg = (e as Error)?.message ?? '';
        if (!(msg.toLowerCase().includes('counter') && msg.toLowerCase().includes('exist'))) {
          console.warn('[seedPermissions] Bursary sentinel write note:', msg.slice(0, 180));
        }
      }
    }
  }

  // Expose applied statistics for diagnostics (no logging secrets — only counts).
  try {
    // noop; reserved for future audit counter row
  } catch { /* swallow */ }

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
