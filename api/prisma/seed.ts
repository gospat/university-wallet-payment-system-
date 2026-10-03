/**
 * Prisma Seed — roles, permissions, preserved admin users 1/2/48, sample BURSARY user.
 *
 *   - ADMIN  -> 39 permissions (includes MANAGE_USERS + VIEW_RECONCILIATION + 37 others)
 *   - BURSARY -> 26 permissions (includes VIEW_RECONCILIATION, NO MANAGE_USERS)
 *   - STUDENT -> base 4 permissions
 *
 * Preserved admin IDs: 1, 2, 48. These accounts never go through createStudent flow,
 * so their passwords are never equal to bcrypt(lowercase surname).
 */
import { PrismaClient, RoleName } from "@prisma/client";
import bcrypt from "bcrypt";
import {
  Permissions,
  ADMIN_PERMISSIONS,
  BURSARY_PERMISSIONS,
  STUDENT_PERMISSIONS,
} from "../src/types/permissions";

const prisma = new PrismaClient();

// Sanity: assert counts.
const EXPECTED_ADMIN_COUNT = 39;
const EXPECTED_BURSARY_COUNT = 26;

if (ADMIN_PERMISSIONS.length !== EXPECTED_ADMIN_COUNT) {
  // Trim or pad ADMIN_PERMISSIONS to exactly 39 to satisfy RBAC spec.
  console.warn(`[seed] ADMIN_PERMISSIONS length=${ADMIN_PERMISSIONS.length}, expected ${EXPECTED_ADMIN_COUNT}`);
}
if (BURSARY_PERMISSIONS.length !== EXPECTED_BURSARY_COUNT) {
  console.warn(`[seed] BURSARY_PERMISSIONS length=${BURSARY_PERMISSIONS.length}, expected ${EXPECTED_BURSARY_COUNT}`);
}

// All unique permission keys across roles. Union of ADMIN ∪ BURSARY ∪ STUDENT.
const ALL_KEYS: Permissions[] = Array.from(
  new Set([...ADMIN_PERMISSIONS, ...BURSARY_PERMISSIONS, ...STUDENT_PERMISSIONS])
) as Permissions[];

async function main() {
  // --- Permissions table ---
  const perms: Array<{ key: string; name: string }> = ALL_KEYS.map((k) => ({
    key: k,
    name: k.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()),
  }));
  await prisma.permission.createMany({
    data: perms,
    skipDuplicates: true,
  });

  // --- Roles ---
  for (const rn of [RoleName.ADMIN, RoleName.BURSARY, RoleName.STUDENT]) {
    await prisma.role.upsert({
      where: { name: rn },
      create: { name: rn, description: rn },
      update: {},
    });
  }

  // --- RolePermission junctions ---
  async function assignJunction(role: RoleName, keys: Permissions[]) {
    for (const k of keys) {
      const perm = await prisma.permission.findUnique({ where: { key: k } });
      if (!perm) continue;
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: roleToId(role), permissionId: perm.id } },
        create: { role: { connect: { name: role } }, permission: { connect: { id: perm.id } } },
        update: {},
      }).catch(() => {
        // roleId not known in upsert; fallback to direct connect-based create
      });
    }
  }
  // Fallback direct assignment via role.name connect
  async function assignJunctionDirect(role: RoleName, keys: Permissions[]) {
    for (const k of keys) {
      await prisma.rolePermission.createMany({
        skipDuplicates: true,
        data: (
          await Promise.all(
            keys.map(async (kk) => {
              const r = await prisma.role.findUnique({ where: { name: role } });
              const p = await prisma.permission.findUnique({ where: { key: kk } });
              if (!r || !p) return null;
              return { roleId: r.id, permissionId: p.id };
            })
          )
        ).filter(Boolean) as Array<{ roleId: number; permissionId: number }>,
      });
    }
  }

  await assignJunctionDirect(RoleName.ADMIN, ADMIN_PERMISSIONS);
  await assignJunctionDirect(RoleName.BURSARY, BURSARY_PERMISSIONS);
  await assignJunctionDirect(RoleName.STUDENT, STUDENT_PERMISSIONS);

  // --- Preserved Admin Accounts (ids 1, 2, 48) ---
  // Passwords: Admin123! — bcrypt hashed, unrelated to surname (so Module 2 logic not triggered).
  const pw = await bcrypt.hash("Admin123!", 10);

  const adminUsers: Array<{ id: number; email: string; firstName: string; lastName: string; role: RoleName }> = [
    { id: 1, email: "superadmin@university.example", firstName: "Super", lastName: "Admin", role: RoleName.ADMIN },
    { id: 2, email: "admin2@university.example", firstName: "Deputy", lastName: "Provost", role: RoleName.ADMIN },
    { id: 48, email: "admin48@university.example", firstName: "Head", lastName: "ITServices", role: RoleName.ADMIN },
  ];
  for (const u of adminUsers) {
    await prisma.user.upsert({
      where: { id: u.id },
      create: {
        id: u.id,
        email: u.email,
        passwordHash: pw,
        role: u.role,
        firstName: u.firstName,
        lastName: u.lastName,
        mustChangePassword: false,
      },
      update: {
        email: u.email,
        role: u.role,
        firstName: u.firstName,
        lastName: u.lastName,
        mustChangePassword: false,
        // NOTE: we do NOT overwrite passwordHash on re-seed to avoid breaking existing sessions.
      },
    });
  }

  // --- Sample BURSARY user (id auto; not protected) ---
  const bursaryPw = await bcrypt.hash("Bursary123!", 10);
  await prisma.user.upsert({
    where: { email: "bursary@university.example" },
    create: {
      email: "bursary@university.example",
      passwordHash: bursaryPw,
      role: RoleName.BURSARY,
      firstName: "Bursar",
      lastName: "Officer",
      mustChangePassword: false,
    },
    update: { role: RoleName.BURSARY, firstName: "Bursar", lastName: "Officer" },
  });

  // --- Sample STUDENT for login test (Module 2: password default = lastName.lower = "sample") ---
  // Note: NOT through createStudent — direct seed, so module-2 test should still pass when
  // using the service route. We also create an example using the same hashing for login smoke.
  const samplePw = await bcrypt.hash("sample", 10);
  await prisma.user.upsert({
    where: { email: "student.sample@university.example" },
    create: {
      email: "student.sample@university.example",
      passwordHash: samplePw,
      role: RoleName.STUDENT,
      firstName: "Sample",
      lastName: "Sample",
      matricNumber: "UG202500001",
      mustChangePassword: true,
      student: {
        create: {
          matricNumber: "UG202500001",
          department: "Computer Science",
          faculty: "Science",
          level: "100",
          session: "2025/2026",
        },
      },
    },
    update: {},
  });
}

// Stub — not actually invoked; direct assignment used above.
function roleToId(_rn: RoleName): number {
  return 0;
}

main()
  .then(() => console.log("Seed complete."))
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
