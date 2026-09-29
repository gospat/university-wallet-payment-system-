// =============================================================================
// Pure production guardrails logic — SAFE IMPORT FROM ANYWHERE (including Jest).
// -----------------------------------------------------------------------------
// NO side effects at import time:
//   - does NOT call envSchema.parse(process.env)
//   - does NOT bootstrap the HTTP server
//   - does NOT connect to Redis / DB
//   - does NOT call process.exit()
//
// All functions accept a `env` argument and return typed results only.
// Side effects (banner printing, process.exit) are performed by the caller
// (applyProductionGuardrails() in server.ts for startup, or Jest unit tests).
// =============================================================================

export type PaystackMode = 'live' | 'test' | 'unknown' | 'missing';
export type AlatpayMode = 'prod' | 'sandbox' | 'unknown' | 'missing';
export type ProviderName = 'PAYSTACK' | 'ALATPAY/WEMA';

export interface GuardrailResult {
  /**
   * Fatal problems — operator MUST fix before real-money production traffic.
   * Startup IIFE in server.ts calls process.exit(2) when this is non-empty.
   * These are things that can't be silently degraded at runtime.
   */
  fatalProblems: string[];

  /**
   * Payment-mode warnings — non-fatal but MUST be loudly displayed on every
   * production boot so operators cannot miss that providers are not fully live.
   * The presence of warnings here alone MUST NEVER cause process.exit().
   */
  paymentModeWarnings: { provider: ProviderName; message: string }[];

  /**
   * Per-provider classification, reported independently. NEVER merge these into
   * a single "all live/sandbox" boolean — a mixed mode (Paystack live + Alatpay
   * sandbox) MUST show "live on Paystack possible".
   */
  paymentModes: {
    paystack: PaystackMode;
    alatpay: AlatpayMode;
  };

  /**
   * Categorized summary — banner helpers use these.
   *   - anyProviderLive: if true, at least one provider can make real charges.
   *   - allProvidersLive: true only if BOTH are confirmed live.
   *   - anyProviderIncomplete: missing/invalid config (provider safety blocked).
   */
  summary: {
    anyProviderLive: boolean;
    allProvidersLive: boolean;
    anyProviderIncomplete: boolean;
  };
}

// These are STRONG realistic fixtures exposed for tests (not weak dev values):
// 64 random-looking hex chars for enc, 72+ base64 for jwt.
export const STRONG_FIXTURES = {
  ENCRYPTION_KEY: '9f2c4a7e8b1d3056fea9275183c64ebd02af9371c5be8041d6e293fa74b0518c',
  JWT_SECRET:
    '6HvJd!wQz9mNxPs2K_vL7Yg8Rb-T5cW1eEo3XpUq0Sf4ArCjHB.n_8tJhDyVkMbE_p2Os9rNG6uZF3Wa40QIDSh',
} as const;

function strongJwt(sec: string): boolean {
  if (sec.length < 48) return false;
  if (/change.?me|admin123|password|secret|^dev-|^test-|^sample-/i.test(sec)) return false;
  return true;
}

function placeholderEnc(enc: string): boolean {
  return /0{16,}|a{16,}|b{16,}|fffff{4,}/i.test(enc);
}

function hasPrivateIpOrLocalhost(s: string): boolean {
  return /localhost|127\.0\.0\.1|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\./.test(s);
}

/**
 * Classify PAYSTACK_SECRET_KEY into strict categories.
 *   - missing           => EMPTY or undefined — FATAL — can't initiate payments
 *   - unknown           => non-empty but does NOT start with sk_live_ OR sk_test_
 *                          — do NOT treat like test; treat as potential
 *                          misconfiguration = FATAL unless NODE_ENV != prod.
 *   - test              => sk_test_ prefix — test env only, no real charges
 *   - live              => sk_live_ prefix — REAL NAIRA CHARGES possible
 * Classification NEVER mutates env, never auto-upgrades.
 */
function classifyPaystack(key: string | undefined): { mode: PaystackMode; fatal?: string; warn?: { provider: ProviderName; message: string } } {
  if (!key || !String(key).trim()) {
    return {
      mode: 'missing',
      fatal: 'PROD_GUARD: PAYSTACK_SECRET_KEY is empty or missing. Student payments cannot be initiated. Populate PAYSTACK_SECRET_KEY in api/.env.',
    };
  }
  const k = String(key).trim();
  if (k.startsWith('sk_live_')) {
    return { mode: 'live' };
  }
  if (k.startsWith('sk_test_')) {
    return {
      mode: 'test',
      warn: {
        provider: 'PAYSTACK',
        message:
          'PAYSTACK_SECRET_KEY is prefixed sk_test_ — Paystack TEST MODE only. ' +
          'Paystack cannot charge real Naira. The Paystack service reads this key prefix ' +
          'directly; test/live separation is enforced upstream by Paystack, not inferred from ' +
          'NODE_ENV. To enable live, replace PAYSTACK_SECRET_KEY with sk_live_* in api/.env.',
      },
    };
  }
  // Neither prefix. This is a DEFCON misconfig. If we allowed this to continue on
  // prod infrastructure, we'd claim "test mode" silently and payments would fail
  // mysteriously at Paystack — so classify as unknown + FATAL.
  return {
    mode: 'unknown',
    fatal:
      'PROD_GUARD: PAYSTACK_SECRET_KEY is present but DOES NOT start with sk_live_ OR sk_test_. ' +
      'Refuse to start because classification is ambiguous — Paystack could reject every ' +
      'transaction or (worse) leak a mistaken upstream live key into banners claiming test. ' +
      'Fix api/.env PAYSTACK_SECRET_KEY to a value beginning with sk_test_ (sandbox) or ' +
      'sk_live_ (production).',
  };
}

/**
 * Classify AlatPay mode strictly.
 *   - prod   => confirmed real charges
 *   - sandbox => explicitly sandbox, or unset (zod default is 'sandbox')
 *   - unknown => non-empty, non-prod, non-sandbox => FATAL misspelling
 * Missing ALATPAY_MODE is explicitly allowed = sandbox (zod default).
 * Missing SECRET for the chosen mode is a RUNTIME check in alatpay util; we still
 * classify the MODE here without leaking secrets into banners.
 */
function classifyAlatpay(mode: string | undefined): { mode: AlatpayMode; fatal?: string; warn?: { provider: ProviderName; message: string } } {
  const clean = (mode ?? '').trim().toLowerCase();
  if (clean === '' || clean === 'sandbox') {
    return {
      mode: 'sandbox',
      warn: {
        provider: 'ALATPAY/WEMA',
        message:
          `ALATPAY_MODE is "${mode ?? 'sandbox'}" → SANDBOX / TEST MODE only. ` +
          'AlatPay base URL defaults to https://apibox.alatpay.ng (their sandbox API). ' +
          'getActiveAlatpaySecretKey() in utils/alatpay.ts reads ALATPAY_MODE directly; ' +
          'it never infers mode from NODE_ENV. To enable live, set ALATPAY_MODE=prod and ' +
          'populate ALATPAY_PROD_SECRET_KEY + ALATPAY_PUBLIC_KEY + ALATPAY_BUSINESS_ID + ' +
          'ALATPAY_WEBHOOK_SECRET in api/.env.',
      },
    };
  }
  if (clean === 'prod' || clean === 'production') {
    return { mode: 'prod' };
  }
  return {
    mode: 'unknown',
    fatal:
      `PROD_GUARD: ALATPAY_MODE is set to "${String(mode)}" which is not one of the allowed ` +
      'values (sandbox or prod). Check for typos; ALATPAY_MODE default is sandbox if unset.',
  };
}

/**
 * Public API — pure function, zero side effects.
 *
 * Accepts `env` argument (default process.env for convenience in the
 * server.ts IIFE caller, tests pass synthetic env objects).
 */
export function runProductionGuardrails(env: NodeJS.ProcessEnv = process.env): GuardrailResult {
  const fatalProblems: string[] = [];
  const paymentModeWarnings: GuardrailResult['paymentModeWarnings'] = [];

  const cors = (env.CORS_ORIGIN || '').toLowerCase();
  const fbu = (env.FRONTEND_BASE_URL || '').toLowerCase();
  const publicUrl = (env.PUBLIC_URL || '').toLowerCase();
  const appBase = (env.APP_BASE_URL || '').toLowerCase();

  // --- FATAL: URLs (infrastructure configuration) ---
  if (hasPrivateIpOrLocalhost(cors + fbu + publicUrl + appBase)) {
    fatalProblems.push(
      'PROD_GUARD: NODE_ENV=production but a URL env contains localhost / private IP. ' +
        'CORS_ORIGIN / FRONTEND_BASE_URL / PUBLIC_URL / APP_BASE_URL must only contain production origins.',
    );
  }
  if (!cors && !fbu) {
    fatalProblems.push(
      'PROD_GUARD: NODE_ENV=production but CORS_ORIGIN + FRONTEND_BASE_URL are both empty. ' +
        'Browser frontend will get CORS errors on authenticated and non-authenticated endpoints alike.',
    );
  }
  const urlHasBellsRefs =
    publicUrl.includes('//payment.') ||
    publicUrl.includes('//paymentapi.') ||
    fbu.includes('//payment.') ||
    cors.includes('payment.bellsuniversity');
  if (!urlHasBellsRefs) {
    fatalProblems.push(
      'PROD_GUARD: Expected PUBLIC_URL / FRONTEND_BASE_URL / CORS_ORIGIN to reference ' +
        'payment.bellsuniversity.edu.ng or paymentapi.bellsuniversity.edu.ng subdomains. ' +
        'Receipt QR / verify URLs will resolve to wrong hosts otherwise.',
    );
  }

  // --- FATAL: secrets quality ---
  if (!strongJwt(env.JWT_SECRET ?? '')) {
    fatalProblems.push(
      'PROD_GUARD: JWT_SECRET is too short (<48 chars) or looks weak / dev-flavored ' +
        '(change.me, admin123, password, secret*, dev-*, test-*, sample-*). ' +
        "Generate a strong one with node -e \"require('crypto').randomBytes(64).toString('hex')\" " +
        'and set JWT_SECRET in api/.env.',
    );
  }
  if (placeholderEnc(env.ENCRYPTION_KEY ?? '')) {
    fatalProblems.push(
      'PROD_GUARD: ENCRYPTION_KEY looks like a static dev placeholder ' +
        '(runs of 00000000, aaaaaaaa, ffffff etc.). Rotate it with a fresh 32-byte hex string.',
    );
  }
  // ENCRYPTION_KEY must also be 64 hex chars (zod check is in server.ts already;
  // but runProductionGuardrails can be imported without zod, so add soft check here too):
  const enc = env.ENCRYPTION_KEY ?? '';
  if (enc && !/^[0-9a-fA-F]{64}$/.test(enc)) {
    fatalProblems.push(
      'PROD_GUARD: ENCRYPTION_KEY must be exactly 64 hex characters ' +
        '(32 bytes of entropy, suitable for AES-256-GCM key derivation).',
    );
  }

  // --- FATAL: email required ---
  if (!env.RESEND_API_KEY && !env.SMTP_HOST) {
    fatalProblems.push(
      'PROD_GUARD: Neither RESEND_API_KEY nor SMTP_HOST are configured. ' +
        'Student welcome emails, password resets, and receipt emails will FAIL. ' +
        'Configure Resend (recommended) or SMTP credentials.',
    );
  }

  // --- CLASSIFY + FATAL for Paystack missing/unknown keys ---
  const paystack = classifyPaystack(env.PAYSTACK_SECRET_KEY);
  if (paystack.fatal) fatalProblems.push(paystack.fatal);
  if (paystack.warn) paymentModeWarnings.push(paystack.warn);

  // --- CLASSIFY + FATAL for Alatpay misspellings ---
  const alatpay = classifyAlatpay(env.ALATPAY_MODE);
  if (alatpay.fatal) fatalProblems.push(alatpay.fatal);
  if (alatpay.warn) paymentModeWarnings.push(alatpay.warn);

  // --- SUMMARY: explicit per-provider live flags (independent, never merged) ---
  const anyProviderLive = paystack.mode === 'live' || alatpay.mode === 'prod';
  const allProvidersLive = paystack.mode === 'live' && alatpay.mode === 'prod';
  const anyProviderIncomplete =
    paystack.mode === 'missing' ||
    paystack.mode === 'unknown' ||
    alatpay.mode === 'unknown' ||
    alatpay.mode === 'missing';

  return {
    fatalProblems,
    paymentModeWarnings,
    paymentModes: {
      paystack: paystack.mode,
      alatpay: alatpay.mode,
    },
    summary: { anyProviderLive, allProvidersLive, anyProviderIncomplete },
  };
}

/**
 * Banner-printing helpers (console writes = side effects).
 *
 * Usage rules:
 *   - Never assume an empty warnings array means "all live". Always read
 *     result.summary.* and result.paymentModes independently.
 *   - Banner MUST list every provider's mode on EVERY production boot.
 */
export function printStartupGuardrailBanners(result: GuardrailResult): void {
  const width = 78;
  const sep = (ch: string) => ch.repeat(Math.max(4, Math.ceil(width / ch.length))).slice(0, width);
  const banner = (edge: string, lines: string[], style: 'fatal' | 'warn' | 'info' = 'warn') => {
    const s = sep(edge);
    const stream: (...a: any[]) => void = style === 'fatal' ? console.error : console.warn;
    stream('');
    stream(s);
    for (const rawLine of lines) {
      const line = String(rawLine);
      const wrapped = line.length > width - 4 ? line.slice(0, width - 4) : line;
      stream(`${edge} ${wrapped.padEnd(width - 4)} ${edge}`);
    }
    stream(s);
    stream('');
  };

  // (1) Per-provider mode summary line (EVERY prod boot)
  const modeLine = [
    `PAYSTACK = ${String(result.paymentModes.paystack).toUpperCase()}`,
    `ALATPAY  = ${String(result.paymentModes.alatpay).toUpperCase()}`,
  ].join('   |   ');

  const header = [
    `UNIVERSITY BURSARY PAYMENT PORTAL — STARTUP PAYMENT MODES`,
    modeLine,
    '',
  ];

  // (2) Mixed / live / test cases
  if (result.summary.anyProviderIncomplete) {
    header.push('⚠️  ONE OR MORE PROVIDERS ARE INCOMPLETE / MISCONFIGURED.');
    header.push('    Scroll up for FATAL problems list (below this banner process will exit).');
  } else if (result.summary.allProvidersLive) {
    header.push('✅  BOTH providers LIVE — real-money transactions possible via Paystack AND Alatpay.');
    header.push('    Ops team: verify Bursary sign-off and transaction reconciliation are in place.');
  } else if (result.summary.anyProviderLive) {
    // CRITICAL: explicitly identify WHICH provider is live
    if (result.paymentModes.paystack === 'live') {
      header.push('⚠️  PAYSTACK = LIVE — real-money Naira charges POSSIBLE on Paystack even if Alatpay is sandbox.');
    }
    if (result.paymentModes.alatpay === 'prod') {
      header.push('⚠️  ALATPAY = LIVE — real-money WEMA/ALAT charges POSSIBLE even if Paystack is test.');
    }
    header.push('    Treat this as a live-capable deployment; confirm ops sign-off before opening to traffic.');
  } else {
    header.push('🔒  NO REAL-MONEY POSSIBLE on any provider in this configuration.');
    header.push('    Paystack uses sk_test_ prefix (Paystack upstream enforces test sandbox).');
    header.push('    Alatpay uses sandbox base URL https://apibox.alatpay.ng explicitly.');
  }
  banner(result.summary.anyProviderLive ? '🔴' : '🔒', header, result.summary.anyProviderIncomplete ? 'fatal' : 'warn');

  // (3) Warn-only payment warnings (Paystack test, Alatpay sandbox, or non-prod keys)
  if (result.paymentModeWarnings.length > 0) {
    const warnLines: string[] = [
      'PAYMENT-PROVIDER WARN-ONLY (not fatal — startup is ALLOWED for prod testing):',
      '',
    ];
    for (const w of result.paymentModeWarnings) {
      warnLines.push(`[${w.provider}]`);
      warnLines.push(`  ${w.message.slice(0, 240)}`);
      warnLines.push('');
    }
    warnLines.push('Ops team: swap env vars + restart only when Bursary go-live is approved.');
    banner('🟡', warnLines, 'warn');
  }
}
