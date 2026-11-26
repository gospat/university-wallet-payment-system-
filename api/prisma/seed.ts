import { PrismaClient, Role } from '@prisma/client';
import bcrypt from 'bcrypt';
import crypto from 'crypto';

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// BOOTSTRAP CREDENTIALS — NO PREDICTABLE DEFAULTS
// ---------------------------------------------------------------------------
// This script previously hard-coded `admin123` / `bursary123` / `student123`.
// Those defaults are REMOVED. Bootstrap passwords must now be supplied
// explicitly through the environment:
//
//   SEED_ADMIN_PASSWORD    (super admin)
//   SEED_BURSARY_PASSWORD  (bursary staff)
//   SEED_STUDENT_PASSWORD  (demo students)
//
// Outside production a strong random password is generated and printed ONCE so
// local development stays usable. In production the script REFUSES to invent
// credentials — a predictable or accidentally-published default can never be
// seeded into a real deployment.
//
// Every seeded account is created with `mustChangePassword: true`, so even a
// bootstrap credential cannot be used against the application until the account
// holder rotates it.
// ---------------------------------------------------------------------------
function resolveSeedPassword(envVar: string, label: string): { value: string; generated: boolean } {
  const fromEnv = (process.env[envVar] || '').trim();
  if (fromEnv) {
    if (fromEnv.length < 12) {
      throw new Error(`${envVar} must be at least 12 characters long.`);
    }
    return { value: fromEnv, generated: false };
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `Refusing to seed the ${label} account with a generated password in production. ` +
        `Set ${envVar} explicitly before running the seed.`,
    );
  }
  return { value: crypto.randomBytes(18).toString('base64url'), generated: true };
}

async function main() {
  console.log('🌱 Seeding database...');

  const admin = resolveSeedPassword('SEED_ADMIN_PASSWORD', 'super admin');
  const bursary = resolveSeedPassword('SEED_BURSARY_PASSWORD', 'bursary staff');
  const student = resolveSeedPassword('SEED_STUDENT_PASSWORD', 'student');

  // 1. Create Admin
  const adminPassword = await bcrypt.hash(admin.value, 12);
  const createdAdmin = await prisma.user.upsert({
    where: { email: 'admin@university.edu.ng' },
    update: {},
    create: {
      email: 'admin@university.edu.ng',
      password: adminPassword,
      firstName: 'Super',
      lastName: 'Admin',
      role: Role.ADMIN,
      isSuperAdmin: true,
      mustChangePassword: true,
    },
  });
  console.log(`Created Admin: ${createdAdmin.email}`);

  // 2. Create Bursary Staff
  const bursaryPassword = await bcrypt.hash(bursary.value, 12);
  const createdBursary = await prisma.user.upsert({
    where: { email: 'finance@university.edu.ng' },
    update: {},
    create: {
      email: 'finance@university.edu.ng',
      password: bursaryPassword,
      firstName: 'Chief',
      lastName: 'Bursar',
      role: Role.BURSARY,
      mustChangePassword: true,
    },
  });
  console.log(`Created Bursary: ${createdBursary.email}`);

  // 3. Create Students
  const studentPassword = await bcrypt.hash(student.value, 12);
  for (let i = 1; i <= 5; i++) {
    const createdStudent = await prisma.user.upsert({
      where: { email: `student${i}@university.edu.ng` },
      update: {},
      create: {
        email: `student${i}@university.edu.ng`,
        password: studentPassword,
        firstName: 'Student',
        lastName: `${i}`,
        matricNumber: `2023/SCI/${1000 + i}`,
        college: 'College of Science',
        department: 'Computer Science',
        program: 'B.Sc. Computer Science',
        role: Role.STUDENT,
        mustChangePassword: true,
      },
    });
    console.log(`Created Student: ${createdStudent.email}`);
  }

  // Generated (non-production only) credentials are surfaced ONCE, clearly
  // labelled, so they are never confused with a durable secret. In production
  // `resolveSeedPassword` above has already refused to generate anything.
  const generated: string[] = [];
  if (admin.generated) generated.push(`  SEED_ADMIN_PASSWORD   = ${admin.value}`);
  if (bursary.generated) generated.push(`  SEED_BURSARY_PASSWORD = ${bursary.value}`);
  if (student.generated) generated.push(`  SEED_STUDENT_PASSWORD = ${student.value}`);
  if (generated.length > 0) {
    console.warn(
      [
        '',
        '⚠️  ONE-TIME GENERATED DEVELOPMENT CREDENTIALS (not stored anywhere):',
        ...generated,
        '   Every seeded account MUST change its password at first login.',
        '   Set the SEED_*_PASSWORD environment variables to choose your own.',
        '',
      ].join('\n'),
    );
  }

  console.log('✅ Seeding completed!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
