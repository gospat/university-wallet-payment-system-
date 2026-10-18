import { Request, Response, NextFunction } from 'express';
import { isAllowedOrigin } from '../utils/originAllowlist';

/**
 * DEFENCE-IN-DEPTH CSRF GUARD for the cookie-based refresh path.
 *
 * The refresh token travels in an `HttpOnly; SameSite=Lax` cookie, so a
 * cross-site POST cannot even deliver the cookie (SameSite=Lax blocks it). This
 * middleware adds belt-and-braces protection: when the browser supplies an
 * `Origin` header it MUST be on the same exact-match allowlist used by the CORS
 * middleware — otherwise the request is rejected with a generic 403.
 *
 * A MISSING `Origin` header is intentionally allowed: it is a browser-only
 * header and its absence signals a server-to-server or same-origin non-browser
 * caller (e.g. the DB-free test harness), which SameSite already protects.
 */
export const csrfOriginGuard = (req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (origin && !isAllowedOrigin(String(origin))) {
    return res.status(403).json({ status: 'fail', message: 'Request blocked.' });
  }
  next();
};
