import { Request, Response, NextFunction } from 'express';
import { catchAsync } from '../utils/catchAsync';
import { AppError } from '../utils/AppError';
import prisma from '../config/database';
import { ReceiptService } from '../services/receipt';

const _isStaff = (role?: string) =>
  role === 'ADMIN' || role === 'BURSARY' || role === 'SUPER_ADMIN';

export const downloadReceipt = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { reference } = req.params;
  const userId = req.user!.id;

  const transaction = await prisma.transaction.findUnique({
    where: { reference },
    include: {
      user: true,
      invoice: { include: { fee: true } },
      receipts: true,
    },
  });

  if (!transaction) {
    return next(new AppError('Transaction not found', 404));
  }

  const userRole = (req.user as any)?.role;
  if (transaction.userId !== userId && !_isStaff(userRole)) {
    return next(new AppError('Unauthorized access to this receipt', 403));
  }

  if (transaction.status !== 'SUCCESS') {
    return next(new AppError('Receipts are only available for successful transactions', 400));
  }

  const pdfBuffer = await ReceiptService.generateReceipt(transaction);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=receipt_${reference}.pdf`);
  res.setHeader('Content-Length', pdfBuffer.length);

  res.send(pdfBuffer);
});

export const downloadStatement = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const userId = req.user!.id;

  const user = await prisma.user.findUnique({
    where: { id: userId },
  });

  if (!user) {
    return next(new AppError('User not found', 404));
  }

  const transactions = await prisma.transaction.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });

  const pdfBuffer = await ReceiptService.generateStatement(user, transactions, 0);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=statement_${user.matricNumber || userId}.pdf`);
  res.setHeader('Content-Length', pdfBuffer.length);

  res.send(pdfBuffer);
});

export const downloadFormalReceipt = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const idParam = req.params.id;
  if (!/^\d+$/.test(idParam)) {
    return next(new AppError('Invalid receipt id', 400));
  }
  const id = Number(idParam);
  const userId = req.user!.id;
  const userRole = (req.user as any)?.role;

  const row = await prisma.receipt.findUnique({
    where: { id },
    include: {
      student: { select: { firstName: true, lastName: true, email: true, matricNumber: true } },
      invoice: { include: { fee: { select: { name: true } } } },
      transaction: true,
    },
  });
  if (!row) return next(new AppError('Receipt not found', 404));
  if (row.studentId !== userId && !_isStaff(userRole)) {
    return next(new AppError('Unauthorized access to this receipt', 403));
  }
  if (row.isVoided && !_isStaff(userRole)) {
    return next(new AppError('This receipt has been voided', 410));
  }

  const pdfBuffer = await ReceiptService.generateFormalReceipt({
    receiptNumber: row.receiptNumber,
    paidAmount: Number(row.paidAmount),
    paidAt: row.paidAt,
    isVoided: row.isVoided,
    voidedAt: row.voidedAt,
    paymentChannel: row.paymentChannel,
    paymentMethodDetail: row.paymentMethodDetail,
    paystackReference: row.paystackReference,
    qrUrl: row.qrCodeData || `${process.env.APP_BASE_URL || 'http://localhost:3001'}/public/verify-receipt/${row.verificationToken}`,
    student: row.student as any,
    invoice: row.invoice ? {
      invoiceNumber: (row.invoice as any).invoiceNumber || null,
      dueDate: (row.invoice as any).dueDate || null,
      session: (row.invoice as any).session || null,
      semester: (row.invoice as any).semester || null,
      fee: row.invoice.fee ? { name: row.invoice.fee.name || null } : null,
    } : null,
  });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=receipt_${row.receiptNumber}.pdf`);
  res.setHeader('Content-Length', pdfBuffer.length);
  res.send(pdfBuffer);
});

export const listMyReceipts = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const userId = req.user!.id;
  const page = Math.max(1, Number((req.query as any).page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number((req.query as any).pageSize) || 25));
  const skip = (page - 1) * pageSize;

  const where: any = { studentId: userId };
  if ((req.query as any).isVoided === 'true') where.isVoided = true;
  if ((req.query as any).isVoided === 'false') where.isVoided = false;

  const [items, total] = await Promise.all([
    prisma.receipt.findMany({
      where,
      orderBy: { paidAt: 'desc' },
      skip,
      take: pageSize,
      include: {
        invoice: { include: { fee: { select: { name: true } } } },
        transaction: { select: { reference: true, paystackChannel: true, type: true } },
      },
    }),
    prisma.receipt.count({ where }),
  ]);

  res.status(200).json({
    status: 'success',
    data: {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    },
  });
});

export const publicVerifyReceipt = catchAsync(async (req: Request, res: Response) => {
  const token = String(req.params.token || '').trim();
  const row = await prisma.receipt.findUnique({
    where: { verificationToken: token },
    include: {
      student: { select: { id: true, firstName: true, lastName: true, matricNumber: true } },
      invoice: { include: { fee: { select: { id: true, name: true } } } },
    },
  });
  if (!row) {
    res.status(404).json({
      status: 'fail',
      verified: false,
      message: 'Receipt not found or verification token invalid',
      branding: {
        name: process.env.UNIVERSITY_NAME || 'University Payment Platform',
        address: process.env.UNIVERSITY_ADDRESS || '',
        phone: process.env.UNIVERSITY_PHONE || '',
        website: process.env.UNIVERSITY_WEBSITE || '',
      },
    });
    return;
  }

  const feeId = row.invoice?.fee?.id;
  const studentId = row.student?.id;
  let chargeSource: { origin: 'DIRECT_BILL' | 'CATALOGUE'; assignmentId: number | null; matricNumber: string | null } = {
    origin: 'CATALOGUE',
    assignmentId: null,
    matricNumber: row.student?.matricNumber ?? null,
  };
  if (studentId && feeId) {
    const asg = await prisma.feeAssignment.findFirst({
      where: {
        assignmentType: 'STUDENT' as any,
        targetStudentId: studentId,
        feeId,
        isActive: true,
      },
      select: { id: true },
    });
    if (asg) {
      chargeSource = { origin: 'DIRECT_BILL', assignmentId: asg.id, matricNumber: row.student?.matricNumber ?? null };
    }
  }

  const brand = {
    name: process.env.UNIVERSITY_NAME || 'University Payment Platform',
    address: process.env.UNIVERSITY_ADDRESS || '',
    phone: process.env.UNIVERSITY_PHONE || '',
    website: process.env.UNIVERSITY_WEBSITE || '',
    bankName: process.env.UNIVERSITY_BANK_NAME || '',
    bankAccount: process.env.UNIVERSITY_BANK_ACCOUNT || '',
  };

  res.status(200).json({
    status: 'success',
    verified: !row.isVoided,
    data: {
      receiptNumber: row.receiptNumber,
      verificationToken: row.verificationToken,
      paidAmount: Number(row.paidAmount),
      paidAt: row.paidAt,
      generatedAt: row.generatedAt,
      paymentChannel: row.paymentChannel || null,
      isVoided: row.isVoided,
      voidedAt: row.voidedAt || null,
      qrUrl: row.qrCodeData || `${process.env.APP_BASE_URL || ''}/public/verify-receipt/${row.verificationToken}`,
      student: row.student ? {
        firstName: row.student.firstName,
        lastName: row.student.lastName,
        matricNumber: row.student.matricNumber,
        fullName: `${row.student.firstName} ${row.student.lastName}`,
      } : null,
      invoice: row.invoice ? {
        invoiceNumber: (row.invoice as any).invoiceNumber || null,
        session: (row.invoice as any).session || null,
        semester: (row.invoice as any).semester || null,
        feeName: row.invoice.fee?.name || null,
        feeId: row.invoice.fee?.id ?? null,
      } : null,
      chargeSource,
    },
    branding: brand,
  });
});

