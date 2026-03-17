import { PrismaClient, Role, TransactionType, TransactionStatus, LedgerType } from '@prisma/client';
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
        college: `College of Science`,
        department: `Computer Science`,
        program: `B.Sc. Computer Science`,
        role: Role.STUDENT,
        wallet: {
          create: {
            balance: 50000.00, // Pre-fund with 50k
          },
        },
      },
      include: { wallet: true },
    });
    students.push(student);
    console.log(`Created Student: ${student.email}`);
  }

  // 4. Create Transactions & Ledger Entries
  for (const student of students) {
    if (!student.wallet) continue;

    // A. Deposit
    const depositRef = `DEP_SEED_${student.id}`;
    const deposit = await prisma.transaction.create({
      data: {
        userId: student.id,
        reference: depositRef,
        amount: 50000.00,
        type: TransactionType.DEPOSIT,
        status: TransactionStatus.SUCCESS,
        description: 'Initial Seed Deposit',
      },
    });

    await prisma.walletLedger.create({
      data: {
        walletId: student.wallet.id,
        transactionId: deposit.id,
        type: LedgerType.CREDIT,
        amount: 50000.00,
        balanceBefore: 0,
        balanceAfter: 50000.00,
      },
    });

    // B. Pending Withdrawal Request (For Bursary to approve)
    if (student.email === 'student2@university.edu.ng') {
      await prisma.transaction.create({
        data: {
          userId: student.id,
          reference: `WD_SEED_1`,
          amount: 15000.00,
          type: TransactionType.WITHDRAWAL,
          status: TransactionStatus.PENDING,
          description: 'Withdrawal Request',
          metadata: { bank: 'First Bank', account: '3012345678' },
        },
      });
      console.log(`Created Pending Withdrawal for ${student.email}`);
    } else if (student.email === 'student4@university.edu.ng') {
      await prisma.transaction.create({
        data: {
          userId: student.id,
          reference: `WD_SEED_2`,
          amount: 25000.00,
          type: TransactionType.WITHDRAWAL,
          status: TransactionStatus.PENDING,
          description: 'Withdrawal Request',
          metadata: { bank: 'GTBank', account: '0123456789' },
        },
      });
      console.log(`Created Pending Withdrawal for ${student.email}`);
    }
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
