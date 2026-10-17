import { Prisma, Role } from '@prisma/client';
import prisma from '../config/database';
import { bumpRolePermsVersion } from '../middlewares/auth';

// ---------------------------------------------------------------------------
// CANONICAL PERMISSION REGISTRY
// ---------------------------------------------------------------------------
// PERMISSION_DEFS below is the SINGLE authoritative permission registry for the
// whole application. The backend permission enum, the frontend types and the
// GET /admin/permissions endpoint are all derived from / validated against it.
//
// ADMIN-only classification is declared INLINE on the registry entry itself via
// `adminOnly: true` (see ADMIN_ONLY_PERMISSION_KEYS / isAdminOnlyPermission
// derived after the array). Those capabilities can never be granted to a
// configurable role (BURSARY) and are: user impersonation, role/user
// administration, refund approval authority, queue destruction,
// payment-provider credential exposure, tenant-wide configuration, full audit
// exposure and automated BullMQ scheduled jobs.
export interface PermissionDefinition {
  key: string;
  name: string;
  category: string;
  description?: string;
  /** true = ADMIN-only; never assignable to a configurable role (BURSARY). */
  adminOnly?: boolean;
  /**
   * true = only a FLAG-AWARE SUPER ADMINISTRATOR may exercise this capability
   * (role === ADMIN AND User.isSuperAdmin === true). A plain role=ADMIN account
   * that is NOT flagged as super admin must never reach it. `superAdminOnly`
   * implies `adminOnly` (the key is therefore never BURSARY-assignable and is
   * still covered by the Layer-4 ADMIN-only runtime guard).
   */
  superAdminOnly?: boolean;
}

export const PERMISSION_DEFS: PermissionDefinition[] = [
  { key: 'VIEW_DASHBOARD', name: 'View Dashboard', category: 'Dashboard' },
  { key: 'VIEW_AUDIT_LOG', name: 'View Audit Log', category: 'Admin' },
  { key: 'VIEW_USERS', name: 'View Users', category: 'Admin' },
  { key: 'MANAGE_USERS', name: 'Manage Users', category: 'Admin', adminOnly: true },
  { key: 'VIEW_ROLES', name: 'View Roles', category: 'Admin' },
  { key: 'MANAGE_ROLES', name: 'Manage Roles & Permissions', category: 'Admin', adminOnly: true, superAdminOnly: true },
  { key: 'IMPERSONATE_USERS', name: 'Impersonate Users', category: 'Admin', adminOnly: true },
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
  { key: 'APPROVE_REFUNDS', name: 'Approve Refunds', category: 'Payments', adminOnly: true },
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
  { key: 'VIEW_LEVELS', name: 'View Levels', category: 'Academic Structure' },
  { key: 'VIEW_SESSIONS', name: 'View Academic Sessions', category: 'Academic Structure' },
  { key: 'VIEW_RECONCILIATION', name: 'View Reconciliation Dashboard', category: 'Reconciliation' },
  { key: 'VIEW_RECONCILIATION_REPORTS', name: 'View Reconciliation Reports', category: 'Reconciliation' },
  { key: 'RESOLVE_EXCEPTIONS', name: 'Resolve Reconciliation Exceptions', category: 'Reconciliation' },
  { key: 'EXPORT_RECONCILIATION', name: 'Export Reconciliation', category: 'Reconciliation' },
  { key: 'RUN_RECONCILIATION', name: 'Run Reconciliation', category: 'Reconciliation' },
  { key: 'SYSTEM_SETTINGS', name: 'System Settings', category: 'Admin', adminOnly: true },
  { key: 'PAYSTACK_CONFIG', name: 'Payment Configuration', category: 'Admin', adminOnly: true },
  { key: 'MANAGE_PAYMENT_PROVIDERS', name: 'Manage Payment Providers', category: 'Admin', adminOnly: true },
  { key: 'VIEW_SETTINGS', name: 'View Settings', category: 'Admin' },
  { key: 'MANAGE_SETTINGS', name: 'Manage Settings', category: 'Admin', adminOnly: true },
  { key: 'MANAGE_EMAIL_TEMPLATES', name: 'Manage Email Templates', category: 'Admin', adminOnly: true },
  { key: 'VIEW_QUEUES', name: 'View Background Queues', category: 'Admin' },
  { key: 'FLUSH_QUEUES', name: 'Flush Background Queues', category: 'Admin', adminOnly: true },
  { key: 'AUDIT_LOGS_VIEW_FULL', name: 'Audit Logs (Full)', category: 'Admin', adminOnly: true },
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
  { key: 'REPORTS_SCHEDULE', name: 'Reports: Schedule Recurring (R20)', category: 'Reports', description: 'Create, edit, pause BullMQ-based scheduled report jobs (ADMIN only; Bursary excluded)', adminOnly: true },
  { key: 'VIEW_REPORTS', name: 'View Reports', category: 'Reports' },
  { key: 'EXPORT_REPORTS', name: 'Export Reports', category: 'Reports' },
  { key: 'SCHEDULE_REPORTS', name: 'Schedule Reports', category: 'Reports', adminOnly: true },
];

export const ALL_PERMISSION_KEYS: readonly string[] = PERMISSION_DEFS.map((p) => p.key);

/**
 * SINGLE authoritative ADMIN-only permission definition.
 * Derived from PERMISSION_DEFS (`adminOnly: true`) so the registry and the
 * sensitive-permission policy can never drift apart. Used by the role-update
 * endpoint (Layer 2), the runtime authorization guard (Layer 4) and the seed
 * cleanup pre-sweep (Layer 3).
 */
export const ADMIN_ONLY_PERMISSION_KEYS: readonly string[] = PERMISSION_DEFS
  .filter((p) => p.adminOnly === true)
  .map((p) => p.key);

export const ADMIN_ONLY_SENSITIVE_KEYS: ReadonlySet<string> = new Set(ADMIN_ONLY_PERMISSION_KEYS);

export function isAdminOnlyPermission(key: string): boolean {
  return ADMIN_ONLY_SENSITIVE_KEYS.has(key);
}

/**
 * SINGLE authoritative SUPER-ADMIN-only permission definition.
 * Derived INLINE from PERMISSION_DEFS (`superAdminOnly: true`). These keys may
 * only be exercised by a FLAG-AWARE super administrator (role === ADMIN AND
 * User.isSuperAdmin === true). superAdminOnly ⊆ adminOnly by construction — a
 * guard below fails loudly at module load if that invariant is ever broken.
 */
export const SUPER_ADMIN_ONLY_PERMISSION_KEYS: readonly string[] = PERMISSION_DEFS
  .filter((p) => p.superAdminOnly === true)
  .map((p) => p.key);

export const SUPER_ADMIN_ONLY_SENSITIVE_KEYS: ReadonlySet<string> = new Set(
  SUPER_ADMIN_ONLY_PERMISSION_KEYS,
);

export function isSuperAdminOnlyPermission(key: string): boolean {
  return SUPER_ADMIN_ONLY_SENSITIVE_KEYS.has(key);
}

// Invariant guard: every super-admin-only key MUST also be ADMIN-only, otherwise
// the Layer-4 runtime guard (which only consults ADMIN_ONLY) could be bypassed.
for (const k of SUPER_ADMIN_ONLY_PERMISSION_KEYS) {
  if (!ADMIN_ONLY_SENSITIVE_KEYS.has(k)) {
    throw new Error(
      `[permissionSeed] superAdminOnly key must also be adminOnly: ${k}`,
    );
  }
}

/** Registry entry shape exposed by GET /admin/permissions (canonical catalogue). */
export interface PermissionCatalogueEntry {
  key: string;
  name: string;
  category: string;
  description: string | null;
  adminOnly: boolean;
  /** true = only a FLAG-AWARE super administrator may exercise this capability. */
  superAdminOnly: boolean;
  /** false for ADMIN-only capabilities — they are never assignable to BURSARY. */
  assignable: boolean;
}

/**
 * The canonical permission catalogue. The frontend obtains displayable
 * permissions from GET /admin/permissions (which is built from this array) and
 * must NOT maintain an independent master list.
 */
export const PERMISSION_CATALOGUE: readonly PermissionCatalogueEntry[] = PERMISSION_DEFS.map((p) => ({
  key: p.key,
  name: p.name,
  category: p.category,
  description: p.description ?? null,
  adminOnly: p.adminOnly === true,
  superAdminOnly: p.superAdminOnly === true,
  assignable: p.adminOnly !== true,
}));

const BURSARY_EXCLUDED: ReadonlySet<string> = ADMIN_ONLY_SENSITIVE_KEYS;

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

/**
 * Explicit "BURSARY role has been initialized" marker (a Counter sentinel row).
 *
 * Replaces the unsafe `RolePermission count === 0 ⇒ never initialized` heuristic
 * so that an intentionally zero-permission BURSARY role is NEVER re-seeded with
 * defaults on a server restart. BURSARY defaults are applied exactly once, when
 * the role has genuinely never been initialized.
 *
 * Reuses the existing Counter table/sentinel pattern (see
 * BURSARY_RELEASE_UPGRADE_SENTINEL_ID) — therefore NO database migration.
 */
export const RBAC_BURSARY_INIT_SENTINEL_ID = 'rbac_bursary_role_initialized_20261016';

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
    where: { key: { in: [...ALL_PERMISSION_KEYS] } },
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
    defaultKeys: readonly string[],
    mode: 'full' | 'diffAdd',
    tx?: Prisma.TransactionClient,
  ) => {
    const db: Prisma.TransactionClient | typeof prisma = tx ?? prisma;
    const rowsToCreate: { role: Role; permissionId: number }[] = [];
    for (const key of defaultKeys) {
      const permissionId = keyToIdMap.get(key);
      if (!permissionId) continue;
      rowsToCreate.push({ role, permissionId });
    }
    if (rowsToCreate.length === 0) return 0;

    if (mode === 'full') {
      for (const row of rowsToCreate) {
        await db.rolePermission.upsert({
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
    const existingRows = await db.rolePermission.findMany({
      where: { role },
      select: { permissionId: true },
    });
    for (const row of existingRows) existingForRole.add(row.permissionId);

    const missing = rowsToCreate.filter((r) => !existingForRole.has(r.permissionId));
    if (missing.length === 0) return 0;

    // createMany so we don't re-issue individual upsert calls (safe because
    // we've already filtered to rows that don't exist).
    try {
      const createRes = await db.rolePermission.createMany({
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
          await db.rolePermission.create({ data: row });
          applied += 1;
        } catch { /* duplicate unique key — another seed beat us; skip */ }
      }
      return applied;
    }
  };

  // -------------------------------------------------------------------------
  // ADMIN: protected SUPER-ADMINISTRATOR (see middlewares/auth.ts).
  // Runtime authorization always grants ADMIN the whole registry, so its
  // RolePermission rows exist only so the Roles/Permissions catalogue renders
  // accurately. Keeping them complete can never weaken security and never
  // undoes an administrator configuration, because ADMIN permissions are not
  // user-configurable in this phase.
  // -------------------------------------------------------------------------
  await safeApplyDefaults(Role.ADMIN, ALL_PERMISSION_KEYS, 'full');

  const bursaryCount = existingCountByRole.get(Role.BURSARY) ?? 0;

  // -------------------------------------------------------------------------
  // BURSARY: configurable. Its saved RolePermission set is AUTHORITATIVE.
  //
  // "Never initialized" is determined by an EXPLICIT marker — NEVER by
  // `RolePermission count === 0`. A zero-permission BURSARY role is a VALID,
  // intentional administrator configuration and must survive server restarts.
  //
  // Markers consulted (existing Counter table — no schema change):
  //   RBAC_BURSARY_INIT_SENTINEL_ID        (this correction)
  //   BURSARY_RELEASE_UPGRADE_SENTINEL_ID  (legacy proof of a prior seed)
  // -------------------------------------------------------------------------
  let bursaryInitialized = false;
  try {
    const markers = await prisma.counter.findMany({
      where: { id: { in: [RBAC_BURSARY_INIT_SENTINEL_ID, BURSARY_RELEASE_UPGRADE_SENTINEL_ID] } },
      select: { id: true },
    });
    bursaryInitialized = markers.length > 0;
  } catch (e) {
    const msg = (e as Error)?.message ?? '';
    // Fail-safe: if we cannot PROVE the role is uninitialized, assume it IS
    // initialized so defaults are never re-granted over an admin's config.
    bursaryInitialized = true;
    if (!(msg.toLowerCase().includes('counter') && msg.toLowerCase().includes('exist'))) {
      console.warn('[seedPermissions] BURSARY init marker read failed; assuming initialized (fail-safe):', msg.slice(0, 180));
    }
  }

  // A pre-existing install that already has rows predates the marker; adopt its
  // current state as initialized (add nothing, remove nothing).
  const bursaryHasRows = bursaryCount > 0;
  const mustGrantBursaryDefaults = !bursaryInitialized && !bursaryHasRows;

  const writeBursaryInitMarker = async (tx?: Prisma.TransactionClient) => {
    const db: Prisma.TransactionClient | typeof prisma = tx ?? prisma;
    await db.counter.upsert({
      where: { id: RBAC_BURSARY_INIT_SENTINEL_ID },
      create: { id: RBAC_BURSARY_INIT_SENTINEL_ID, value: 1 },
      update: {},
    });
  };

  if (mustGrantBursaryDefaults) {
    // FRESH installation: BURSARY has genuinely never been initialized. Apply
    // the full safe default set and record the explicit init marker atomically
    // so a crash between the two can never trigger a later re-grant.
    try {
      await prisma.$transaction(async (tx) => {
        await safeApplyDefaults(Role.BURSARY, BURSARY_PERMISSION_KEYS, 'full', tx);
        await writeBursaryInitMarker(tx);
        // The full default set already contains the release-upgrade delta keys;
        // record that sentinel too so the delta never re-runs on this install.
        await tx.counter.upsert({
          where: { id: BURSARY_RELEASE_UPGRADE_SENTINEL_ID },
          create: { id: BURSARY_RELEASE_UPGRADE_SENTINEL_ID, value: 1 },
          update: {},
        });
      }, { timeout: 15000 });
    } catch (e) {
      const msg = (e as Error)?.message ?? '';
      const counterDoesNotExist =
        msg.toLowerCase().includes('counter') && msg.toLowerCase().includes('exist');
      if (counterDoesNotExist) {
        // Rolling-deploy schema drift: Counter table not converged yet, so the
        // marker cannot be written. Apply defaults only; the marker is written
        // on a subsequent boot once the schema has converged.
        console.warn('[seedPermissions:bursary-init] Counter table not available during schema-drift first boot; wrote full Bursary defaults only (init marker deferred).');
        try { await safeApplyDefaults(Role.BURSARY, BURSARY_PERMISSION_KEYS, 'full'); } catch {}
      } else {
        console.warn('[seedPermissions:bursary-init] Atomic full-default grant + init marker failed:', msg.slice(0, 200));
      }
    }
  } else {
    // INITIALIZED / customized install: the saved RolePermission set is
    // authoritative. Deliberately do NOT add missing default keys — that is
    // exactly the behaviour that used to silently undo an administrator's
    // intentional removals on every boot.
    //
    // The ONLY remaining write is the genuine ONE-TIME release-upgrade delta
    // (BURSARY_RELEASE_UPGRADE_KEYS) for legacy installs that predate that
    // release. It is gated by its own sentinel and cannot recur.
    let releaseUpgradeApplied = false;
    try {
      const sentinelRow = await prisma.counter.findUnique({
        where: { id: BURSARY_RELEASE_UPGRADE_SENTINEL_ID },
        select: { id: true },
      });
      releaseUpgradeApplied = !!sentinelRow;
    } catch (e) {
      const msg = (e as Error)?.message ?? '';
      if (msg.toLowerCase().includes('counter') && msg.toLowerCase().includes('exist')) {
        releaseUpgradeApplied = false;
      } else {
        // Unknown DB error: fail-safe NO-OP so we never re-restore
        // admin-removed permissions when unsure.
        console.warn('[seedPermissions:bursary-upgrade] Bursary sentinel read failed; skipping release-upgrade delta for safety:', msg.slice(0, 180));
        releaseUpgradeApplied = true;
      }
    }

    if (!releaseUpgradeApplied) {
      const deltaKeys = Array.from(BURSARY_RELEASE_UPGRADE_KEYS);
      try {
        await prisma.$transaction(async (tx) => {
          await safeApplyDefaults(Role.BURSARY, deltaKeys, 'diffAdd', tx);
          await tx.counter.upsert({
            where: { id: BURSARY_RELEASE_UPGRADE_SENTINEL_ID },
            create: { id: BURSARY_RELEASE_UPGRADE_SENTINEL_ID, value: 1 },
            update: {},
          });
          await writeBursaryInitMarker(tx);
        }, { timeout: 15000 });
      } catch (e) {
        const msg = (e as Error)?.message ?? '';
        const counterDoesNotExist =
          msg.toLowerCase().includes('counter') && msg.toLowerCase().includes('exist');
        if (counterDoesNotExist) {
          console.warn('[seedPermissions:bursary-upgrade] Counter table missing during schema-drift boot; applied delta defaults only (sentinels deferred).');
          try { await safeApplyDefaults(Role.BURSARY, deltaKeys, 'diffAdd'); } catch {}
        } else {
          console.warn('[seedPermissions:bursary-upgrade] Atomic delta grant + sentinel failed; rolled back; will retry on next startup:', msg.slice(0, 200));
        }
      }
    }
    // Note: when releaseUpgradeApplied === true the release sentinel already
    // exists, which also means the BURSARY init marker exists (it is written
    // alongside it), so there is nothing further to record here.
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
    // Counter model may not yet exist in db during rolling-deploy schema drift seed runs; swallow.
    const msg = (e as Error)?.message ?? '';
    if (msg.toLowerCase().includes('counter') && msg.toLowerCase().includes('exist')) {
      // ignore
    } else {
      console.warn('[seedPermissions] Counter seed note:', msg.slice(0, 180));
    }
  }
}

export default { seedPermissions, PERMISSION_DEFS };
