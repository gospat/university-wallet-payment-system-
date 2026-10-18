/**
 * Africa/Lagos business-date helpers.
 * =============================================================================
 * The backend owns every financial business-day window in Africa/Lagos
 * (UTC+1, no DST) and accepts date-only `YYYY-MM-DD` parameters.
 *
 * `new Date().toISOString().slice(0, 10)` derives the UTC calendar date, which
 * between 00:00 and 00:59 WAT is still the PREVIOUS Lagos day — so a user
 * opening the dashboard just after Lagos midnight would default to a window
 * one day behind. These helpers derive the calendar date explicitly in the
 * Africa/Lagos zone, independent of the browser/system timezone.
 */

export const LAGOS_TIME_ZONE = 'Africa/Lagos';

/**
 * The Africa/Lagos calendar date as a date-only `YYYY-MM-DD` string.
 * Timezone-independent: the result depends only on the instant `at`.
 */
export function lagosDateOnly(at: Date = new Date()): string {
  // 'en-CA' yields the ISO-like `YYYY-MM-DD` ordering.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: LAGOS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/**
 * Shift a date-only `YYYY-MM-DD` value by `days` (may be negative) using UTC
 * arithmetic, which is DST-safe for a fixed-offset business calendar.
 */
export function shiftDateOnly(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d) + days * 86_400_000);
  const yy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(shifted.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}
