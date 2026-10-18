import type { Request } from 'express';

type ReqLike = Pick<Request, 'headers' | 'ip'>;

/**
 * Authoritative client IP.
 *
 * SECURITY: never read `X-Forwarded-For` directly here. The left-most XFF entry
 * is fully client-controlled (an attacker can prepend any value), so trusting it
 * lets a caller spoof their source IP and thereby evade/reshape IP-based rate
 * limiting and poison audit logs / security alerts.
 *
 * `req.ip` is derived by Express from the socket address plus the configured
 * `trust proxy` setting (see app.ts — exactly one trusted Nginx hop). Nginx is
 * configured to OVERWRITE `X-Real-IP` / `X-Forwarded-For` with `$remote_addr`,
 * so `req.ip` resolves to the real client address and any forged values the
 * client prepended are ignored.
 */
export function reqIp(req: ReqLike): string | undefined {
  return req.ip || undefined;
}

export function reqUa(req: ReqLike): string | undefined {
  const ua = req.headers['user-agent'];
  return typeof ua === 'string' ? ua : undefined;
}
