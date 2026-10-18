/**
 * Africa/Lagos default-date derivation — UTC/Lagos boundary regression
 * =============================================================================
 * The bursary dashboard used `new Date().toISOString().slice(0, 10)` for its
 * default From/To dates. `toISOString()` is UTC, so between 00:00 and 00:59 WAT
 * (Lagos = UTC+1, no DST) it returns the PREVIOUS calendar day and the default
 * window silently started a day behind. These helpers derive the date in the
 * Africa/Lagos zone, independent of the host timezone.
 */

import { describe, it, expect } from 'vitest';
import { lagosDateOnly, shiftDateOnly, LAGOS_TIME_ZONE } from '../utils/lagosDate';

describe('lagosDateOnly — derives the Africa/Lagos calendar date', () => {
  it('is pinned to the Africa/Lagos zone', () => {
    expect(LAGOS_TIME_ZONE).toBe('Africa/Lagos');
  });

  it('returns the Lagos day, not the UTC day, just after Lagos midnight', () => {
    // 23:30 UTC on 2026-10-14 == 00:30 WAT on 2026-10-15.
    const at = new Date('2026-10-14T23:30:00Z');
    expect(at.toISOString().slice(0, 10)).toBe('2026-10-14'); // the old, wrong value
    expect(lagosDateOnly(at)).toBe('2026-10-15'); // the Lagos business date
  });

  it('matches the UTC date for the rest of the Lagos day', () => {
    expect(lagosDateOnly(new Date('2026-10-14T12:00:00Z'))).toBe('2026-10-14');
    // 22:59 UTC is still 2026-10-14 in Lagos.
    expect(lagosDateOnly(new Date('2026-10-14T22:59:00Z'))).toBe('2026-10-14');
    // 23:00 UTC is already 2026-10-15 in Lagos.
    expect(lagosDateOnly(new Date('2026-10-14T23:00:00Z'))).toBe('2026-10-15');
  });

  it('rolls the month and the year correctly across the boundary', () => {
    expect(lagosDateOnly(new Date('2026-10-31T23:30:00Z'))).toBe('2026-11-01');
    expect(lagosDateOnly(new Date('2026-12-31T23:30:00Z'))).toBe('2027-01-01');
  });

  it('defaults to now when called without an argument', () => {
    expect(lagosDateOnly()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('shiftDateOnly — DST-safe date-only arithmetic', () => {
  it('shifts by whole days, including negative shifts', () => {
    expect(shiftDateOnly('2026-10-15', -29)).toBe('2026-09-16');
    expect(shiftDateOnly('2026-10-15', 0)).toBe('2026-10-15');
    expect(shiftDateOnly('2026-10-15', 1)).toBe('2026-10-16');
  });

  it('crosses month and year boundaries', () => {
    expect(shiftDateOnly('2026-11-01', -1)).toBe('2026-10-31');
    expect(shiftDateOnly('2027-01-01', -1)).toBe('2026-12-31');
    expect(shiftDateOnly('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('dashboard default window (To = today, From = To − 29) at the UTC/Lagos boundary', () => {
  const windowAt = (iso: string) => {
    const to = lagosDateOnly(new Date(iso));
    return { from: shiftDateOnly(to, -29), to };
  };

  it('the window starts on the Lagos day just after Lagos midnight', () => {
    // The UTC date is still 2026-10-14, but the Lagos business date is 15.
    expect(windowAt('2026-10-14T23:30:00Z')).toEqual({ from: '2026-09-16', to: '2026-10-15' });
  });

  it('the window matches the UTC date for the rest of the Lagos day', () => {
    expect(windowAt('2026-10-14T12:00:00Z')).toEqual({ from: '2026-09-15', to: '2026-10-14' });
  });
});
