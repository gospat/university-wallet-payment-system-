// =============================================================================
// Student initial-password hardening — regression suite.
//
// Requirement 1 — the initial password is the student's SURNAME lower-cased.
//   • mixed-case surname "ADebayo" → "adebayo"
//   • blank / missing surname → a CLEAR validation error naming the field;
//     NO random (`crypto.randomBytes`) and NO matric-number fallback.
//   • every created / imported student has mustChangePassword = true.
//
// Requirement 5 — no separate plaintext temporary password is ever stored:
//   • the import runner never writes ImportRow.temporaryPassword;
//   • the credentials CSV derives the password from the surname at build time.
//
// Requirement 21 (part) — exported CSV cells cannot execute as formulas:
//   • every cell is neutralised against leading = + - @ (and DDE()).
//
// The database + email queue are mocked so this suite runs with DATABASE_URL
// unset, mirroring CI (no database available).
// =============================================================================

// ---- Mocked Prisma surface (only what these code paths touch) ---------------
type MockPrisma = {
  user: {
    findFirst: jest.Mock;
    findUnique: jest.Mock;
    findMany: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    count: jest.Mock;
  };
  programme: { findFirst: jest.Mock };
  level: { findFirst: jest.Mock };
  academicSession: { findFirst: jest.Mock };
  auditLog: { create: jest.Mock };
  importRun: { findUnique: jest.Mock; update: jest.Mock };
  importRow: { findMany: jest.Mock; update: jest.Mock; createMany: jest.Mock };
  $transaction: jest.Mock;
};

const mockPrisma: MockPrisma = {
  user: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
  },
  programme: { findFirst: jest.fn() },
  level: { findFirst: jest.fn() },
  academicSession: { findFirst: jest.fn() },
  auditLog: { create: jest.fn() },
  importRun: { findUnique: jest.fn(), update: jest.fn() },
  importRow: { findMany: jest.fn(), update: jest.fn(), createMany: jest.fn() },
  // Supports BOTH the callback form (StudentService.create) and the array form
  // (studentImportRunner persists a slice in one transaction).
  $transaction: jest.fn(async (arg: any) => (typeof arg === 'function' ? arg(mockPrisma) : Promise.all(arg))),
};

jest.mock('../config/database', () => ({ __esModule: true, default: mockPrisma }));
// Avoid real Redis/BullMQ connections; sendCredentialEmail is false everywhere
// in this suite so dispatchEmail must never actually run.
jest.mock('../queues/emailQueue', () => ({ __esModule: true, dispatchEmail: jest.fn() }));

import Papa from 'papaparse';
import { StudentService } from '../services/student';
import {
  runStudentImport,
  buildCredentialsCsv,
  deriveInitialPasswordFromSurname,
} from '../services/studentImportRunner';

const ADMIN_ID = 1;

function primeCreateMocks() {
  mockPrisma.user.findFirst.mockResolvedValue(null); // no duplicate
  mockPrisma.user.create.mockImplementation(async (args: any) => ({
    id: 501,
    email: args?.data?.email,
    firstName: args?.data?.firstName,
    lastName: args?.data?.lastName,
    matricNumber: args?.data?.matricNumber,
    role: 'STUDENT',
    mustChangePassword: args?.data?.mustChangePassword,
  }));
  mockPrisma.auditLog.create.mockResolvedValue({});
}

beforeEach(() => {
  mockPrisma.user.findFirst.mockReset();
  mockPrisma.user.create.mockReset();
  mockPrisma.auditLog.create.mockReset();
  mockPrisma.importRun.findUnique.mockReset();
  mockPrisma.importRun.update.mockReset();
  mockPrisma.importRow.findMany.mockReset();
  mockPrisma.importRow.update.mockReset();
});

// ===========================================================================
// Requirement 1 — surname-only initial password + mustChangePassword
// ===========================================================================
describe('R1 — initial password is the lower-cased surname', () => {
  it('assigns "adebayo" to a student whose surname is "ADebayo" (mixed case)', async () => {
    primeCreateMocks();

    const created: any = await StudentService.create(
      {
        email: 'adebayo@university.edu.ng',
        firstName: 'Ada',
        lastName: 'ADebayo',
        matricNumber: 'MAT-ADEB-1',
      } as any,
      ADMIN_ID,
      { sendCredentialEmail: false, returnPlaintextPassword: true },
    );

    expect(created.temporaryPasswordPlaintext).toBe('adebayo');
  });

  it('handles a hyphenated surname ("Okafor-Smith" → "okafor-smith")', () => {
    // Same rule exposed through the CSV derivation helper.
    expect(deriveInitialPasswordFromSurname('Okafor-Smith')).toBe('okafor-smith');
    expect(deriveInitialPasswordFromSurname('  OKAFOR  ')).toBe('okafor');
  });

  it('stores a bcrypt hash (never the plaintext) and forces mustChangePassword=true', async () => {
    primeCreateMocks();

    await StudentService.create(
      {
        email: 'adebayo@university.edu.ng',
        firstName: 'Ada',
        lastName: 'ADebayo',
        matricNumber: 'MAT-ADEB-2',
      } as any,
      ADMIN_ID,
      { sendCredentialEmail: false },
    );

    const createArgs = mockPrisma.user.create.mock.calls[0][0];
    expect(createArgs.data.mustChangePassword).toBe(true);
    expect(createArgs.data.password).not.toBe('adebayo');
    expect(String(createArgs.data.password)).toMatch(/^\$2[aby]\$/);
  });

  it('rejects a blank surname with a clear validation error and creates NO student', async () => {
    primeCreateMocks();

    await expect(
      StudentService.create(
        {
          email: 'blank@university.edu.ng',
          firstName: 'No',
          lastName: '   ',
          matricNumber: 'MAT-BLANK-1',
        } as any,
        ADMIN_ID,
        { sendCredentialEmail: false },
      ),
    ).rejects.toThrow(/surname|lastname/i);

    // No account was created and no transaction was opened — i.e. no random
    // password was silently minted.
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('treats a missing surname (undefined) the same way — no random fallback', async () => {
    primeCreateMocks();

    await expect(
      StudentService.create(
        {
          email: 'missing@university.edu.ng',
          firstName: 'No',
          matricNumber: 'MAT-BLANK-2',
        } as any,
        ADMIN_ID,
        { sendCredentialEmail: false },
      ),
    ).rejects.toThrow(/surname|lastname/i);

    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Requirement 5 — the import runner never persists a plaintext password
// ===========================================================================
describe('R5 — import runner does not store a plaintext temporary password', () => {
  it('never writes ImportRow.temporaryPassword and leaks no plaintext', async () => {
    const run = {
      id: 9001,
      uuid: 'hardening-run-1',
      status: 'PENDING',
      totalRows: 1,
      successCount: 0,
      failCount: 0,
      skippedCount: 0,
      finishedAt: null,
    };
    mockPrisma.importRun.findUnique.mockResolvedValue(run);
    const runState: any = { ...run };
    mockPrisma.importRun.update.mockImplementation(async (args: any) => {
      const data = args?.data ?? {};
      for (const key of ['successCount', 'failCount', 'skippedCount']) {
        const value = data[key];
        if (value && typeof value === 'object' && 'increment' in value) runState[key] += value.increment;
        else if (typeof value === 'number') runState[key] = value;
      }
      if (data.status) runState.status = data.status;
      if ('finishedAt' in data) runState.finishedAt = data.finishedAt;
      if (data.startedAt) runState.startedAt = data.startedAt;
      return { ...runState };
    });
    mockPrisma.importRow.findMany.mockResolvedValue([
      {
        id: 11,
        payload: {
          firstName: 'Ada',
          lastName: 'ADebayo',
          email: 'adebayo.import@university.edu.ng',
          matricNumber: 'MAT-IMP-1',
        },
      },
    ]);
    mockPrisma.importRow.update.mockResolvedValue({});
    primeCreateMocks();

    const result = await runStudentImport({
      importRunId: run.id,
      strategy: 'SKIP',
      actorId: ADMIN_ID,
      sendCredentialEmails: false,
    });

    expect(result).toMatchObject({ status: 'COMPLETED', successCount: 1 });

    expect(mockPrisma.importRow.update).toHaveBeenCalledTimes(1);
    const persisted = mockPrisma.importRow.update.mock.calls[0][0];
    // The column is never written at all.
    expect(Object.prototype.hasOwnProperty.call(persisted.data, 'temporaryPassword')).toBe(false);
    // And the derived plaintext never appears anywhere in the persisted row.
    expect(JSON.stringify(persisted).toLowerCase()).not.toContain('adebayo');
  });
});

// ===========================================================================
// Requirement 21 — CSV formula-injection neutralisation
// ===========================================================================
describe('R21 — credentials CSV neutralises spreadsheet formula injection', () => {
  it('prefixes every dangerous cell so it cannot execute as a formula', () => {
    const csv = buildCredentialsCsv([
      {
        rowNumber: 1,
        firstName: '=cmd|\' /C calc\'!A0',
        lastName: '+HYPERLINK("http://evil.example")',
        email: '-minus@university.edu.ng',
        matricNumber: '@SUM(A1:A9)',
        studentId: 1,
      },
      {
        rowNumber: 2,
        // The derived password itself begins with "=" for this surname.
        firstName: 'Ada',
        lastName: '=SUM(A1:A9)',
        email: 'ada@university.edu.ng',
        matricNumber: 'SCI/002',
        studentId: 2,
      },
    ]);

    // Parse the produced CSV the way a spreadsheet would and assert NO cell can
    // be interpreted as a formula.
    const parsed = Papa.parse<string[]>(csv.trim(), { header: false, skipEmptyLines: true });
    const cells = parsed.data.flat();
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(/^[=+\-@]/.test(String(cell))).toBe(false);
    }

    // Explicit spot-checks: the leading apostrophe (literal-text prefix) is present.
    expect(cells).toContain("'=cmd|' /C calc'!A0");
    expect(cells).toContain("'=sum(a1:a9)");
    expect(cells).toContain("'-minus@university.edu.ng");
    expect(cells).toContain("'@SUM(A1:A9)");
  });

  it('still emits the header row for an empty run', () => {
    expect(buildCredentialsCsv([])).toBe('row_number,matric_number,first_name,last_name,email,password');
  });
});
