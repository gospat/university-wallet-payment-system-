import prisma from '../config/database';

export type YearlyCounterKind = 'invoice' | 'receipt';

/**
 * Atomically increment + return the next yearly counter value for invoices or receipts.
 *
 *   - Counter keys: `invoice_seq_<YYYY>` and `receipt_seq_<YYYY>` stored in the `counters`
 *     table (Counter model, id=STRING, value=INT).
 *   - Upsert pattern (Prisma counter.upsert with {increment:1}) so concurrent
 *     verifyPayment / generate-invoice calls never race or duplicate.
 *   - Year resets automatically: start of new year, first upsert for `invoice_seq_2027`
 *     creates id with value=1 (next call = 2, etc.). Perfectly matches formal
 *     accounting convention where invoice numbers restart at 00001 every 1st Jan.
 *
 * @param kind   'invoice' or 'receipt' — selects which yearly counter to advance
 * @param year   4-digit year string (e.g. '2026'). Falls back to current year via
 *               new Date().getFullYear(). Use academic year START (e.g. session 2026/2027
 *               → pass '2026').
 * @returns next integer counter, guaranteed unique per (kind,year).
 */
export async function nextYearlyCounter(kind: YearlyCounterKind, year?: string): Promise<number> {
  const yr = year ?? String(new Date().getFullYear());
  const key = `${kind}_seq_${yr}`;
  const row = await (prisma as any).counter.upsert({
    where: { id: key },
    update: { value: { increment: 1 } },
    create: { id: key, value: 1 },
    select: { value: true },
  });
  return Number(row?.value ?? 1);
}

/**
 * Extract 4-digit fiscal year from a standard academic session string like
 * '2026/2027' → '2026'. Fallback = current calendar year.
 */
export function yearFromSession(sessionRaw: string | undefined | null): string {
  if (!sessionRaw) return String(new Date().getFullYear());
  const m = /^(\d{4})\/\d{4}$/.exec(String(sessionRaw).trim());
  if (m) return m[1];
  const m2 = /^(\d{4})/.exec(String(sessionRaw).trim());
  return m2 ? m2[1] : String(new Date().getFullYear());
}
