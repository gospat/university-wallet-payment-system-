import { Role } from '@prisma/client';
import prisma from '../config/database';

export const PERMISSION_DEFS: { key: string; name: string; category: string; description?: string }[] = [
  { key: 'VIEW_DASHBOARD', name: 'View Dashboard', category: 'Dashboard' },
  { key: 'VIEW_STUDENTS', name: 'View Students', category: 'Students' },
  { key: 'CREATE_STUDENT', name: 'Create Student', category: 'Students' },
  { key: 'BULK_UPLOAD_STUDENTS', name: 'Bulk Upload Students', category: 'Students' },
  { key: 'VIEW_IMPORT_HISTORY', name: 'View Import History', category: 'Students' },
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
  { key: 'VIEW_RECEIPTS', name: 'View Receipts', category: 'Receipts' },
  { key: 'GENERATE_RECEIPT', name: 'Generate Receipt', category: 'Receipts' },
  { key: 'VERIFY_RECEIPT', name: 'Verify Receipt Authenticity', category: 'Receipts' },
  { key: 'PROCESS_REFUND', name: 'Process Refund', category: 'Payments' },
  { key: 'VIEW_COLLEGES', name: 'View Colleges', category: 'Academic Structure' },
  { key: 'VIEW_DEPARTMENTS', name: 'View Departments', category: 'Academic Structure' },
  { key: 'VIEW_PROGRAMMES', name: 'View Programmes', category: 'Academic Structure' },
  { key: 'VIEW_RECONCILIATION', name: 'View Reconciliation Dashboard', category: 'Reconciliation' },
  { key: 'VIEW_RECONCILIATION_REPORTS', name: 'View Reconciliation Reports', category: 'Reconciliation' },
  { key: 'MANAGE_USERS', name: 'Manage Users', category: 'Admin' },
  { key: 'MANAGE_ROLES', name: 'Manage Roles & Permissions', category: 'Admin' },
  { key: 'SYSTEM_SETTINGS', name: 'System Settings', category: 'Admin' },
  { key: 'PAYSTACK_CONFIG', name: 'Payment Configuration', category: 'Admin' },
  { key: 'AUDIT_LOGS_VIEW_FULL', name: 'Audit Logs (Full)', category: 'Admin' },
  { key: 'AUDIT_LOGS_VIEW_LIMITED', name: 'Audit Logs (Limited)', category: 'Admin' },
];

const ALL_PERMISSION_KEYS = PERMISSION_DEFS.map((p) => p.key);

const BURSARY_EXCLUDED = new Set([
  'MANAGE_USERS',
  'MANAGE_ROLES',
  'PAYSTACK_CONFIG',
  'SYSTEM_SETTINGS',
  'AUDIT_LOGS_VIEW_FULL',
]);

const BURSARY_PERMISSION_KEYS = ALL_PERMISSION_KEYS.filter(
  (k) => !BURSARY_EXCLUDED.has(k),
);

export async function seedPermissions() {
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

  const keyToIdMap = new Map<string, number>();
  const allPerms = await prisma.permission.findMany({
    where: { key: { in: ALL_PERMISSION_KEYS } },
    select: { id: true, key: true },
  });
  for (const p of allPerms) keyToIdMap.set(p.key, p.id);

  for (const key of ALL_PERMISSION_KEYS) {
    const permissionId = keyToIdMap.get(key);
    if (!permissionId) continue;
    await prisma.rolePermission.upsert({
      where: { role_permissionId: { role: Role.ADMIN, permissionId } },
      create: { role: Role.ADMIN, permissionId },
      update: {},
    });
  }

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

export default { seedPermissions, PERMISSION_DEFS };
