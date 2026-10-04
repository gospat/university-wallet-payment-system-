import { PrismaClient, Role } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // 1. Create Admin
  const adminPassword = await bcrypt.hash('admin123', 12);
  const admin = await prisma.user.upsert({
    where: { email: 'admin@university.edu.ng' },
    update: {},
    create: {
      email: 'admin@university.edu.ng',
      password: adminPassword,
      firstName: 'Super',
      lastName: 'Admin',
      role: Role.ADMIN,
    },
  });
  console.log(`Created Admin: ${admin.email}`);

  // 2. Create Bursary Staff
  const bursaryPassword = await bcrypt.hash('bursary123', 12);
  const bursary = await prisma.user.upsert({
    where: { email: 'finance@university.edu.ng' },
    update: {},
    create: {
      email: 'finance@university.edu.ng',
      password: bursaryPassword,
      firstName: 'Chief',
      lastName: 'Bursar',
      role: Role.BURSARY,
    },
  });
  console.log(`Created Bursary: ${bursary.email}`);

  // 3. Create Students
  const studentPassword = await bcrypt.hash('student123', 12);
  const students = [];

  for (let i = 1; i <= 5; i++) {
    const student = await prisma.user.upsert({
      where: { email: `student${i}@university.edu.ng` },
      update: {},
      create: {
        email: `student${i}@university.edu.ng`,
        password: studentPassword,
        firstName: `Student`,
        lastName: `${i}`,
        matricNumber: `2023/SCI/${1000 + i}`,
        college: 'College of Science',
        department: 'Computer Science',
        program: 'B.Sc. Computer Science',
        role: Role.STUDENT,
      },
    });
    students.push(student);
    console.log(`Created Student: ${student.email}`);
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
