import type { Response } from 'express';
import { SessionTiming } from '../services/auth';

// ---------------------------------------------------------------------------
// REFRESH-TOKEN COOKIE (security-hardening requirement 10)
// ---------------------------------------------------------------------------
// The refresh token is delivered to the browser ONLY as an `HttpOnly`,
// `SameSite=Lax` cookie so frontend JavaScript can never read it. The access
// token stays in memory on the client and is NEVER placed in a cookie.
//
// Scope is intentionally the NARROWEST path that still covers the endpoints
// that need it: `POST /api/v1/auth/refresh` and `POST /api/v1/auth/logout`.
// The cookie is therefore not sent on any other API call.
// ---------------------------------------------------------------------------

export const REFRESH_COOKIE_NAME = 'refresh_token';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

/**
 * Base cookie options. `secure` is enabled ONLY in production so local/dev/test
 * over plain HTTP keeps working; `sameSite` is always `lax` (never `none`).
 * `maxAge` matches the real refresh-token lifetime constant used when signing
 * the refresh JWT / persisting the refresh-token row (`SessionTiming.REFRESH_EXPIRES_MS`,
 * sourced from `JWT_REFRESH_EXPIRES_IN`, default `7d`).
 */
export function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: REFRESH_COOKIE_PATH,
    maxAge: SessionTiming.REFRESH_EXPIRES_MS,
  };
}

export function setRefreshCookie(res: Response, refreshToken: string): void {
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions());
}

export function clearRefreshCookie(res: Response): void {
  // The removal options (path/httpOnly/secure/sameSite) must match those used
  // when setting the cookie for browsers to actually delete it. `maxAge` is
  // intentionally omitted so the cookie is cleared immediately.
  const { maxAge: _maxAge, ...opts } = refreshCookieOptions();
  res.clearCookie(REFRESH_COOKIE_NAME, opts);
}
