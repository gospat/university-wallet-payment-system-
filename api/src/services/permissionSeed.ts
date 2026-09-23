import { Role } from '@prisma/client';
import prisma from '../config/database';

export const PERMISSION_DEFS: { key: string; name: string; category: string; description?: string }[] = [
  { key: 'VIEW_STUDENTS', name: 'View Students', category: 'Students' },
  { key: 'CREATE_STUDENT', name: 'Create Student', category: 'Students' },
  { key: 'BULK_UPLOAD_STUDENTS', name: 'Bulk Upload Students', category: 'Students' },
  { key: 'CREATE_FEE', name: 'Create Fee', category: 'Fees' },
  { key: 'EDIT_FEE', name: 'Edit Fee', category: 'Fees' },
  { key: 'VIEW_PAYMENTS', name: 'View Payments', category: 'Payments' },
  { key: 'VERIFY_PAYMENT', name: 'Verify Payment', category: 'Payments' },
  { key: 'GENERATE_RECEIPT', name: 'Generate Receipt', category: 'Payments' },
  { key: 'PROCESS_REFUND', name: 'Process Refund', category: 'Payments' },
  { key: 'MANAGE_USERS', name: 'Manage Users', category: 'Admin' },
  { key: 'MANAGE_ROLES', name: 'Manage Roles', category: 'Admin' },
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
).concat('AUDIT_LOGS_VIEW_LIMITED');

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
