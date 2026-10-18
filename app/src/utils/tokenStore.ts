// ---------------------------------------------------------------------------
// IN-MEMORY ACCESS-TOKEN STORE (security-hardening requirement 10)
// ---------------------------------------------------------------------------
// The access token is held ONLY in a module-scoped variable for the lifetime of
// the page — it is NEVER written to `localStorage` / `sessionStorage`, so an
// XSS payload cannot read it back out of persisted storage. The long-lived
// refresh token is not kept here either: it lives exclusively in an HttpOnly
// cookie the browser sends automatically and JavaScript can never read.
//
// Safe when `window` is undefined (SSR / non-browser test environments).
// ---------------------------------------------------------------------------

let accessToken: string | null = null;

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = typeof token === 'string' && token.length > 0 ? token : null;
}

export function clearAccessToken(): void {
  accessToken = null;
}
