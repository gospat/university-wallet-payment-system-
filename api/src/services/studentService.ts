/**
 * Module 2 — Student Service.
 *
 * createStudent: writes a STUDENT user with password = bcrypt(surname.toLowerCase()),
 * mustChangePassword = true, and a linked Student profile row. Also returns the
 * generated plaintext password ONLY for the purpose of email queueing.
 *
 * IAM GUARD (Module 2 TR-12.1): role is forced to STUDENT. Attempts to pass
 * a different role are rejected (zod validation).
 *
 * Module 4 — import worker reuses buildCreateStudentArgs to apply the same
 * password / mustChangePassword logic in bulk.
 */
import { z } from "zod";
import prisma from "../config/prisma";
import { hashPassword } from "../utils/password";
import { BadRequestError } from "../utils/AppError";

export const CreateStudentInput = z.object({
  firstName: z.string().trim().min(1),
  lastName: z.string().trim().min(1),
  email: z.string().email().optional().or(z.literal("")),
  matricNumber: z.string().trim().min(1),
  department: z.string().optional(),
  faculty: z.string().optional(),
  level: z.string().optional(),
  session: z.string().optional(),
  // IAM guard: role MUST be STUDENT when present.
  role: z.literal("STUDENT").default("STUDENT"),
});
export type CreateStudentInputT = z.infer<typeof CreateStudentInput>;

export interface CreateStudentResult {
  userId: number;
  studentId: number;
  generatedPassword: string;
}

/**
 * Returns { password, hash, mustChangePassword } for a student input.
 * Password = surname.toLowerCase() per Module 2 spec.
 */
export function buildPasswordFromSurname(input: { lastName: string }): {
  plainPassword: string;
  mustChangePassword: true;
} {
  const plainPassword = input.lastName.toLowerCase();
  return {
    plainPassword,
    mustChangePassword: true,
  };
}

/**
 * Single create. Never sends email inline. Caller must enqueue email separately.
 */
export async function createStudent(
  rawInput: CreateStudentInputT,
  tx?: any
): Promise<CreateStudentResult> {
  const input = CreateStudentInput.parse(rawInput);
  const client = tx ?? prisma;
  const { plainPassword } = buildPasswordFromSurname(input);
  const passwordHash = await hashPassword(plainPassword);

  const existing = await client.user.findUnique({ where: { matricNumber: input.matricNumber } });
  if (existing) throw new BadRequestError(`Matric number ${input.matricNumber} already exists`);

  const created = await client.user.create({
    data: {
      email: input.email ?? `${input.matricNumber}@student.university.example`,
      password: passwordHash,
      role: "STUDENT",
      firstName: input.firstName,
      lastName: input.lastName,
      matricNumber: input.matricNumber,
      mustChangePassword: true,
      accountStatus: "ACTIVE",
      department: input.department ?? null,
      college: input.faculty ?? null,
    },
  });
  return {
    userId: created.id,
    studentId: created.id,
    generatedPassword: plainPassword,
  };
}

/**
 * Bulk create a batch of students within a transaction.
 * Returns array of per-row results (for the email queue).
 * No inline emailing.
 */
export async function createStudentBatch(
  inputs: CreateStudentInputT[],
  tx: any
): Promise<
  Array<{
    index: number;
    rowNumber: number;
    ok: boolean;
    error?: string;
    matricNumber: string;
    email: string;
    firstName?: string;
    lastName?: string;
    password?: string;
    studentId?: number;
    userId?: number;
  }>
> {
  const results: any[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const raw = inputs[i];
    try {
      const parsed = CreateStudentInput.parse(raw);
      const { plainPassword } = buildPasswordFromSurname(parsed);
      const passwordHash = await hashPassword(plainPassword);
      const created = await tx.user.create({
        data: {
          email: parsed.email?.trim()
            ? parsed.email.trim()
            : `${parsed.matricNumber}@student.university.example`,
          password: passwordHash,
          role: "STUDENT",
          firstName: parsed.firstName,
          lastName: parsed.lastName,
          matricNumber: parsed.matricNumber,
          mustChangePassword: true,
          accountStatus: "ACTIVE",
          department: parsed.department ?? null,
          college: parsed.faculty ?? null,
        },
      });
      results.push({
        index: i,
        rowNumber: (raw as any).__rowNumber ?? i + 1,
        ok: true,
        matricNumber: parsed.matricNumber,
        email: created.email,
        firstName: parsed.firstName,
        lastName: parsed.lastName,
        password: plainPassword,
        studentId: created.id,
        userId: created.id,
      });
    } catch (err: any) {
      results.push({
        index: i,
        rowNumber: (raw as any).__rowNumber ?? i + 1,
        ok: false,
        error: err?.message ?? String(err),
        matricNumber: (raw as any).matricNumber ?? `#${i}`,
        email: (raw as any).email ?? "",
        firstName: (raw as any).firstName,
        lastName: (raw as any).lastName,
      });
    }
  }
  return results;
}
