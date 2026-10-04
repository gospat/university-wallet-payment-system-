import { validateHierarchy } from '../services/academic';
import prisma from '../config/database';

jest.mock('../config/database', () => ({
  __esModule: true,
  default: {
    faculty: { findFirst: jest.fn() },
    department: { findFirst: jest.fn() },
    programme: { findFirst: jest.fn() },
    level: { findFirst: jest.fn() },
    academicSession: { findFirst: jest.fn() },
  },
}));

const mockPrisma = prisma as jest.Mocked<typeof prisma>;

beforeEach(() => {
  jest.clearAllMocks();
});

/**
 * AC-C2: Hierarchy cross-structure validation tests
 * §92 Dept∈Faculty / Programme∈Dept / Level∈Prog
 */
describe('validateHierarchy — §92 cross-structure validation (AC-C2)', () => {
  // --------------------------------------------------------------
  // Test (a): Dept ∉ Faculty rejects
  // Seed: Faculty "Science" has only Department "Computer Science".
  // Row:  faculty="Science" + department="Mass Communication"
  // => validateHierarchy errors.length >= 1, message ~ "does not belong"
  // --------------------------------------------------------------
  it('Dept∉Faculty import rejects (AC-C2)', async () => {
    const facultyName = 'Science';
    const departmentName = 'Mass Communication';

    (mockPrisma.faculty.findFirst as jest.Mock).mockImplementation((opts: any) => {
      if (opts.where?.name?.equals?.toLowerCase() === facultyName.toLowerCase()) {
        return Promise.resolve({ id: 1, name: facultyName });
      }
      return Promise.resolve(null);
    });

    (mockPrisma.department.findFirst as jest.Mock).mockImplementation((opts: any) => {
      const deptName: string = opts.where?.name?.equals ?? '';
      if (deptName.toLowerCase() === departmentName.toLowerCase()) {
        return Promise.resolve({
          id: 99,
          name: departmentName,
          facultyId: 2,
          faculty: { id: 2, name: 'Arts' },
        });
      }
      if (deptName.toLowerCase() === 'computer science') {
        return Promise.resolve({
          id: 10,
          name: 'Computer Science',
          facultyId: 1,
          faculty: { id: 1, name: facultyName },
        });
      }
      return Promise.resolve(null);
    });

    (mockPrisma.programme.findFirst as jest.Mock).mockResolvedValue(null);
    (mockPrisma.level.findFirst as jest.Mock).mockResolvedValue(null);
    (mockPrisma.academicSession.findFirst as jest.Mock).mockResolvedValue(null);

    const result = await validateHierarchy({
      facultyName,
      departmentName,
    });

    expect(result.valid).toBe(false);
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);

    const mismatch = result.errors.find((e) => e.code === 'HIERARCHY_MISMATCH');
    expect(mismatch).toBeDefined();
    expect(mismatch!.message).toMatch(/does not belong/i);
    expect(mismatch!.field).toBe('department');
  });

  // --------------------------------------------------------------
  // Test (b): Valid Dept ∈ Faculty passes
  // Seed: Same as (a)
  // Row:  faculty="Science" + department="Computer Science"
  // => valid = true, errors = []
  // --------------------------------------------------------------
  it('Valid Dept∈Faculty passes', async () => {
    const facultyName = 'Science';
    const departmentName = 'Computer Science';

    (mockPrisma.faculty.findFirst as jest.Mock).mockImplementation((opts: any) => {
      if (opts.where?.name?.equals?.toLowerCase() === facultyName.toLowerCase()) {
        return Promise.resolve({ id: 1, name: facultyName });
      }
      return Promise.resolve(null);
    });

    (mockPrisma.department.findFirst as jest.Mock).mockImplementation((opts: any) => {
      const deptName: string = opts.where?.name?.equals ?? '';
      if (deptName.toLowerCase() === departmentName.toLowerCase()) {
        return Promise.resolve({
          id: 10,
          name: departmentName,
          facultyId: 1,
          faculty: { id: 1, name: facultyName },
        });
      }
      return Promise.resolve(null);
    });

    (mockPrisma.programme.findFirst as jest.Mock).mockResolvedValue(null);
    (mockPrisma.level.findFirst as jest.Mock).mockResolvedValue(null);
    (mockPrisma.academicSession.findFirst as jest.Mock).mockResolvedValue(null);

    const result = await validateHierarchy({
      facultyName,
      departmentName,
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  // --------------------------------------------------------------
  // Test (c): Legacy mode — NO master rows exist
  // Seed: 0 faculty, 0 department, 0 programme, 0 level, 0 session rows
  // Row:  Any arbitrary names
  // => valid = true (no false errors).  Backwards compat C3 rule.
  // --------------------------------------------------------------
  it('Legacy mode no master rows → bypass validation', async () => {
    (mockPrisma.faculty.findFirst as jest.Mock).mockResolvedValue(null);
    (mockPrisma.department.findFirst as jest.Mock).mockResolvedValue(null);
    (mockPrisma.programme.findFirst as jest.Mock).mockResolvedValue(null);
    (mockPrisma.level.findFirst as jest.Mock).mockResolvedValue(null);
    (mockPrisma.academicSession.findFirst as jest.Mock).mockResolvedValue(null);

    const result = await validateHierarchy({
      facultyName: 'Random Faculty',
      departmentName: 'Random Dept',
      programmeName: 'Random Programme',
      levelName: '999',
      sessionName: '3000/3001',
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  // --------------------------------------------------------------
  // Test (d): Programme ∉ Department rejects
  // Seed: Dept=Computer Science under Faculty=Science has
  //       only Programme "BSc Computer Science".
  // Row:  department="Computer Science" + programme="MIS"
  // => errors array non-empty, message ~ "does not belong".
  // --------------------------------------------------------------
  it('Programme∉Department rejects', async () => {
    const facultyName = 'Science';
    const departmentName = 'Computer Science';
    const programmeName = 'MIS';

    (mockPrisma.faculty.findFirst as jest.Mock).mockImplementation((opts: any) => {
      if (opts.where?.name?.equals?.toLowerCase() === facultyName.toLowerCase()) {
        return Promise.resolve({ id: 1, name: facultyName });
      }
      return Promise.resolve(null);
    });

    (mockPrisma.department.findFirst as jest.Mock).mockImplementation((opts: any) => {
      const deptName: string = opts.where?.name?.equals ?? '';
      if (deptName.toLowerCase() === departmentName.toLowerCase()) {
        return Promise.resolve({
          id: 10,
          name: departmentName,
          facultyId: 1,
          faculty: { id: 1, name: facultyName },
        });
      }
      return Promise.resolve(null);
    });

    (mockPrisma.programme.findFirst as jest.Mock).mockImplementation((opts: any) => {
      const progName: string = opts.where?.name?.equals ?? '';
      if (progName.toLowerCase() === programmeName.toLowerCase()) {
        return Promise.resolve({
          id: 500,
          name: programmeName,
          departmentId: 99,
          department: {
            id: 99,
            name: 'Business Administration',
            facultyId: 5,
            faculty: { id: 5, name: 'Management Sciences' },
          },
        });
      }
      if (progName.toLowerCase() === 'bsc computer science') {
        return Promise.resolve({
          id: 100,
          name: 'BSc Computer Science',
          departmentId: 10,
          department: {
            id: 10,
            name: departmentName,
            facultyId: 1,
            faculty: { id: 1, name: facultyName },
          },
        });
      }
      return Promise.resolve(null);
    });

    (mockPrisma.level.findFirst as jest.Mock).mockResolvedValue(null);
    (mockPrisma.academicSession.findFirst as jest.Mock).mockResolvedValue(null);

    const result = await validateHierarchy({
      facultyName,
      departmentName,
      programmeName,
    });

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);

    const mismatch = result.errors.find(
      (e) => e.code === 'HIERARCHY_MISMATCH' && e.field === 'programme'
    );
    expect(mismatch).toBeDefined();
    expect(mismatch!.message).toMatch(/does not belong/i);
  });
});
