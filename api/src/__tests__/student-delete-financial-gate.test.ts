import request from 'supertest';
import express from 'express';

type MockPrisma = {
  user: { findUnique: jest.Mock; delete: jest.Mock };
  invoice: { count: jest.Mock };
  receipt: { count: jest.Mock };
  transaction: { count: jest.Mock };
  refund: { count: jest.Mock };
  feeAssignment: { count: jest.Mock };
  generalLedger: { count: jest.Mock };
  auditLog: { updateMany: jest.Mock; create: jest.Mock };
  refreshToken: { deleteMany: jest.Mock };
  $transaction: jest.Mock;
};

const mockPrisma: MockPrisma = {
  user: { findUnique: jest.fn(), delete: jest.fn() },
  invoice: { count: jest.fn() },
  receipt: { count: jest.fn() },
  transaction: { count: jest.fn() },
  refund: { count: jest.fn() },
  feeAssignment: { count: jest.fn() },
  generalLedger: { count: jest.fn() },
  auditLog: { updateMany: jest.fn(), create: jest.fn() },
  refreshToken: { deleteMany: jest.fn() },
  $transaction: jest.fn(async (fn: (tx: MockPrisma) => Promise<void>) => fn(mockPrisma)),
};

jest.mock('../config/database', () => ({
  __esModule: true,
  default: mockPrisma,
}));

jest.mock('../middlewares/auth', () => ({
  protect: (req: any, _res: any, next: any) => {
    req.user = { id: 999, role: 'ADMIN', permissions: ['MANAGE_USERS'] };
    next();
  },
  restrictTo: (..._roles: any[]) => (_req: any, _res: any, next: any) => next(),
  requirePermission: (..._perms: any[]) => (_req: any, _res: any, next: any) => next(),
  bumpRolePermsVersion: jest.fn(),
}));

jest.mock('../utils/catchAsync', () => ({
  catchAsync: (fn: any) => (req: any, res: any, next: any) =>
    Promise.resolve(fn(req, res, next)).catch(next),
}));

jest.mock('../services/fee', () => ({ FeeService: {}, FeeQuerySchema: {} }));
jest.mock('../services/payment', () => ({ PaymentService: {}, InitiatePaymentSchema: {} }));
jest.mock('../controllers/receipt', () => ({
  downloadFormalReceipt: jest.fn(),
  downloadStatement: jest.fn(),
  listMyReceipts: jest.fn(),
}));

import { Role } from '@prisma/client';
import studentsRouter from '../routes/students';

const app = express();
app.use(express.json());
app.use('/api/v1/students', studentsRouter);

const baseStudent = (id: number, role: Role = Role.STUDENT) => ({
  id,
  role,
  email: `student${id}@uni.edu.ng`,
  firstName: 'Test',
  lastName: `Student${id}`,
  matricNumber: `MAT${id}`,
  accountStatus: 'ACTIVE',
});

const zeroCounts = () => {
  mockPrisma.invoice.count.mockResolvedValue(0);
  mockPrisma.receipt.count.mockResolvedValue(0);
  mockPrisma.transaction.count.mockResolvedValue(0);
  mockPrisma.refund.count.mockResolvedValue(0);
  mockPrisma.feeAssignment.count.mockResolvedValue(0);
  mockPrisma.generalLedger.count.mockResolvedValue(0);
};

describe('DELETE /students/:id — financial-integrity gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    zeroCounts();
    mockPrisma.user.delete.mockResolvedValue({ id: 1 });
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
  });

  it('1. STUDENT with no financial records: deletion succeeds', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseStudent(500));
    const res = await request(app).delete('/api/v1/students/500');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(mockPrisma.user.delete).toHaveBeenCalledWith({ where: { id: 500 } });
  });

  it('2. STUDENT with numeric ID 1: deletion succeeds when eligible', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseStudent(1));
    const res = await request(app).delete('/api/v1/students/1');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
  });

  it('3. STUDENT with numeric ID 2: deletion succeeds when eligible', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseStudent(2));
    const res = await request(app).delete('/api/v1/students/2');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
  });

  it('4. STUDENT with invoice: deletion rejected with 409', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseStudent(501));
    mockPrisma.invoice.count.mockResolvedValue(3);
    const res = await request(app).delete('/api/v1/students/501');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('STUDENT_HAS_FINANCIAL_RECORDS');
    expect(mockPrisma.user.delete).not.toHaveBeenCalled();
  });

  it('5. STUDENT with receipt: deletion rejected with 409', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseStudent(502));
    mockPrisma.receipt.count.mockResolvedValue(1);
    const res = await request(app).delete('/api/v1/students/502');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('STUDENT_HAS_FINANCIAL_RECORDS');
  });

  it('6. STUDENT with transaction: deletion rejected with 409', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseStudent(503));
    mockPrisma.transaction.count.mockResolvedValue(2);
    const res = await request(app).delete('/api/v1/students/503');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('STUDENT_HAS_FINANCIAL_RECORDS');
  });

  it('7. STUDENT with refund dependency: deletion rejected with 409', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseStudent(504));
    mockPrisma.refund.count.mockResolvedValue(1);
    const res = await request(app).delete('/api/v1/students/504');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('STUDENT_HAS_FINANCIAL_RECORDS');
  });

  it('8. STUDENT with FeeAssignment / direct bill: deletion rejected with 409', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseStudent(505));
    mockPrisma.feeAssignment.count.mockResolvedValue(1);
    const res = await request(app).delete('/api/v1/students/505');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('STUDENT_HAS_FINANCIAL_RECORDS');
  });

  it('8b. STUDENT with GeneralLedger entry: deletion rejected with 409', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseStudent(506));
    mockPrisma.generalLedger.count.mockResolvedValue(1);
    const res = await request(app).delete('/api/v1/students/506');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('STUDENT_HAS_FINANCIAL_RECORDS');
  });

  it('9. ADMIN account passed to student delete endpoint: rejected', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseStudent(700, Role.ADMIN));
    const res = await request(app).delete('/api/v1/students/700');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('WRONG_ROLE_FOR_ENDPOINT');
    expect(mockPrisma.user.delete).not.toHaveBeenCalled();
  });

  it('10. Foreign-key / dependency failure: controlled 409, no partial deletion', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseStudent(507));
    const fkError = { code: 'P2003', message: 'Foreign key constraint fails' };
    mockPrisma.$transaction.mockRejectedValue(fkError);
    const res = await request(app).delete('/api/v1/students/507');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('STUDENT_HAS_FINANCIAL_RECORDS');
  });

  it('11. Successful deletion creates audit evidence with id, matric, name, admin', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseStudent(508));
    await request(app).delete('/api/v1/students/508');
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'DELETE_STUDENT',
          entityId: '508',
          userId: 999,
          oldValue: expect.objectContaining({
            id: 508,
            matricNumber: 'MAT508',
            firstName: 'Test',
            lastName: 'Student508',
          }),
        }),
      }),
    );
    const auditCall = mockPrisma.auditLog.create.mock.calls[0][0] as any;
    expect(auditCall.data.oldValue.password).toBeUndefined();
  });
});
