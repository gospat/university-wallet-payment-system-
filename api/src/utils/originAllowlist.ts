// ---------------------------------------------------------------------------
// SHARED CORS ORIGIN ALLOWLIST
// ---------------------------------------------------------------------------
// The exact-match origin allowlist used by the CORS middleware (app.ts) is
// exported here so that other security controls (e.g. the CSRF origin guard
// for the cookie-based refresh path) can reuse the SAME source of truth instead
// of duplicating the list and drifting out of sync.
//
// SECURITY: there is NO wildcard origin and NO arbitrary origin reflection — an
// origin is only accepted when it is an exact member of the allowlist (or, only
// OUTSIDE production, a local dev origin).
// ---------------------------------------------------------------------------

export function buildCorsOrigins(): string[] {
  const fromEnv = (process.env.CORS_ORIGIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const isProduction = process.env.NODE_ENV === 'production';
  const defaults = [
    // Local dev origins are permitted ONLY outside production. A production
    // deployment must provide an explicit CORS_ORIGIN / FRONTEND_BASE_URL.
    ...(isProduction ? [] : ['http://localhost:5173', 'http://localhost:5174']),
    process.env.FRONTEND_BASE_URL,
  ].filter((v): v is string => Boolean(v));
  return Array.from(new Set([...defaults, ...fromEnv]));
}

export const localOriginPatterns: RegExp[] = [
  /^https?:\/\/localhost(:\d+)?(\/|$)/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?(\/|$)/,
  /^https?:\/\/0\.0\.0\.0(:\d+)?(\/|$)/,
  // Anchored to the scheme+host position so a crafted origin that merely
  // CONTAINS ".localtest.me" elsewhere cannot match.
  /^https?:\/\/[a-z0-9.-]+\.localtest\.me(:\d+)?(\/|$)/i,
];

/**
 * True when `origin` is an allowed browser origin.
 *
 * A MISSING origin (server-to-server callers / same-origin non-browser clients
 * that do not send an Origin header) is treated as allowed — Origin is a
 * browser-only header and its absence is not a signal of a cross-site request.
 */
export function isAllowedOrigin(origin: string | undefined | null): boolean {
  if (!origin) return true;
  if (buildCorsOrigins().includes(origin)) return true;
  if (process.env.NODE_ENV !== 'production' && localOriginPatterns.some((re) => re.test(origin))) {
    return true;
  }
  return false;
}
