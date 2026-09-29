/**
 * @jest-environment node
 *
 * Production guardrails tests — SAFE: imports from config/productionGuardrails.ts
 * only, which is a PURE module (no side effects at import time). We deliberately
 * do NOT import server.ts because it calls bootstrap() unconditionally, which
 * starts the Express HTTP listener on port 3001/3333 and opens a DB connection
 * pool via Prisma (we don't need either to verify guardrails).
 */

import {
  runProductionGuardrails,
  STRONG_FIXTURES,
  type GuardrailResult,
} from '../config/productionGuardrails';

// -----------------------------------------------------------------------------
// Realistic strong fixtures.  These are NEVER real secrets — they are test
// values that pass the strength checks so we can isolate the specific case
// under test without failing for collateral reasons.  Real production secrets
// come from api/.env on the VPS.
// -----------------------------------------------------------------------------
const B = {
  JWT_SECRET: STRONG_FIXTURES.JWT_SECRET,
  ENCRYPTION_KEY: STRONG_FIXTURES.ENCRYPTION_KEY,
  CORS_ORIGIN: 'https://payment.bellsuniversity.edu.ng',
  FRONTEND_BASE_URL: 'https://payment.bellsuniversity.edu.ng',
  PUBLIC_URL: 'https://paymentapi.bellsuniversity.edu.ng/api/v1',
  APP_BASE_URL: 'https://payment.bellsuniversity.edu.ng',
  RESEND_API_KEY: 're_test_abcdef0123456789abcdef',
  DATABASE_URL: 'mysql://junk:junk@127.0.0.1:3306/junk',
} as const;

function buildEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return {
    ...B,
    NODE_ENV: 'production',
    PAYSTACK_SECRET_KEY: 'sk_test_abcdef01234567890',
    ALATPAY_MODE: 'sandbox',
    ALATPAY_SANDBOX_SECRET_KEY: 'sbox_test_abc',
    ALATPAY_PUBLIC_KEY: 'pk_test_abc',
    ALATPAY_BUSINESS_ID: 'bid_test_abc',
    ALATPAY_WEBHOOK_SECRET: 'whsec_test_abc',
    ...overrides,
  } as unknown as NodeJS.ProcessEnv;
}

// -----------------------------------------------------------------------------
// 1. Mode classification — SANDBOX config (what we're actually running on VPS)
//    → startup ALLOWED, 0 FATAL, modes [test/sandbox], warnings present
// -----------------------------------------------------------------------------
test('sandbox mode: paystack sk_test_ + alatpay sandbox => 0 fatal, 2 payment warnings', () => {
  const env = buildEnv();
  const r = runProductionGuardrails(env);

  expect(r.fatalProblems).toHaveLength(0);
  expect(r.paymentModes.paystack).toBe('test');
  expect(r.paymentModes.alatpay).toBe('sandbox');
  expect(r.summary.anyProviderLive).toBe(false);
  expect(r.summary.allProvidersLive).toBe(false);
  expect(r.summary.anyProviderIncomplete).toBe(false);
  expect(r.paymentModeWarnings.length).toBeGreaterThanOrEqual(2);
  expect(
    r.paymentModeWarnings.find((w) => w.provider === 'PAYSTACK')?.message.toLowerCase(),
  ).toMatch(/sk_test_|test mode/);
  expect(
    r.paymentModeWarnings.find((w) => w.provider === 'ALATPAY/WEMA')?.message.toLowerCase(),
  ).toMatch(/sandbox/);
});

// -----------------------------------------------------------------------------
// 2. LIVE config — both providers live, no warnings, both modes live,
//    anyProviderLive & allProvidersLive = true
// -----------------------------------------------------------------------------
test('live mode: sk_live_ paystack + alatpay prod => 0 fatal, 0 payment warnings', () => {
  const r = runProductionGuardrails(
    buildEnv({
      PAYSTACK_SECRET_KEY: 'sk_live_abcdef01234567890abcdef',
      ALATPAY_MODE: 'prod',
      ALATPAY_PROD_SECRET_KEY: 'prod_sec_abc',
    }),
  );

  expect(r.fatalProblems).toHaveLength(0);
  expect(r.paymentModes.paystack).toBe('live');
  expect(r.paymentModes.alatpay).toBe('prod');
  expect(r.summary.anyProviderLive).toBe(true);
  expect(r.summary.allProvidersLive).toBe(true);
  expect(r.summary.anyProviderIncomplete).toBe(false);
  // warnings for Paystack test + Alatpay sandbox must be empty
  expect(r.paymentModeWarnings.filter((w) => w.provider === 'PAYSTACK')).toHaveLength(0);
  expect(r.paymentModeWarnings.filter((w) => w.provider === 'ALATPAY/WEMA')).toHaveLength(0);
});

// -----------------------------------------------------------------------------
// 3. MIXED MODE A — PAYSTACK live + ALATPAY sandbox => anyProviderLive=true,
//    banner should warn "real Naira charges POSSIBLE on Paystack even if
//    Alatpay is sandbox".
// -----------------------------------------------------------------------------
test('mixed mode A: paystack live + alatpay sandbox => one live provider + sandbox warning', () => {
  const r = runProductionGuardrails(
    buildEnv({
      PAYSTACK_SECRET_KEY: 'sk_live_abcdef01234567890abcdef',
      ALATPAY_MODE: 'sandbox',
    }),
  );

  expect(r.fatalProblems).toHaveLength(0);
  expect(r.paymentModes.paystack).toBe('live');
  expect(r.paymentModes.alatpay).toBe('sandbox');
  expect(r.summary.anyProviderLive).toBe(true);
  expect(r.summary.allProvidersLive).toBe(false);
  // CRITICAL: alatpay warning STILL present even though paystack is live
  const alat = r.paymentModeWarnings.find((w) => w.provider === 'ALATPAY/WEMA');
  expect(alat).toBeDefined();
  expect(alat!.message.toLowerCase()).toMatch(/sandbox/);
});

// -----------------------------------------------------------------------------
// 4. MIXED MODE B — PAYSTACK test + ALATPAY prod => anyProviderLive=true,
//    banner: "ALATPAY LIVE — real-money WEMA/ALAT charges POSSIBLE even if
//    Paystack is test".
// -----------------------------------------------------------------------------
test('mixed mode B: paystack test + alatpay prod => one live provider + paystack warning', () => {
  const r = runProductionGuardrails(
    buildEnv({
      PAYSTACK_SECRET_KEY: 'sk_test_abc',
      ALATPAY_MODE: 'prod',
      ALATPAY_PROD_SECRET_KEY: 'prod_sec_abc',
    }),
  );

  expect(r.fatalProblems).toHaveLength(0);
  expect(r.paymentModes.paystack).toBe('test');
  expect(r.paymentModes.alatpay).toBe('prod');
  expect(r.summary.anyProviderLive).toBe(true);
  expect(r.summary.allProvidersLive).toBe(false);
  const pay = r.paymentModeWarnings.find((w) => w.provider === 'PAYSTACK');
  expect(pay).toBeDefined();
  expect(pay!.message.toLowerCase()).toMatch(/sk_test_|test mode/);
});

// -----------------------------------------------------------------------------
// 5. Missing PAYSTACK_SECRET_KEY → FATAL (do NOT silently claim unknown mode).
// -----------------------------------------------------------------------------
test('missing PAYSTACK_SECRET_KEY => fatal; NOT reported as confirmed payment mode', () => {
  const env = buildEnv();
  delete (env as any).PAYSTACK_SECRET_KEY;
  const r = runProductionGuardrails(env);

  // MUST be in fatalProblems, not just a warning
  const paystackFatal = r.fatalProblems.find((p) => /PAYSTACK_SECRET_KEY.*empty|missing/i.test(p));
  expect(paystackFatal).toBeDefined();

  // paymentModes.paystack MUST NOT be 'live' or 'test' — must be 'missing'
  expect(r.paymentModes.paystack).toBe('missing');
  expect(r.summary.anyProviderIncomplete).toBe(true);
  // anyProviderLive must be false regardless of alatpay
  expect(r.summary.anyProviderLive).toBe(r.paymentModes.alatpay === 'prod');
});

// -----------------------------------------------------------------------------
// 6. Unrecognized PAYSTACK_SECRET_KEY (no sk_ prefix at all) → FATAL
//    unknown mode. This case previously caused an incorrect "WARN-only no
//    prefix" — now it's fatal because claiming an unknown prefix as a
//    TEST-only mode is a real-money safety hazard.
// -----------------------------------------------------------------------------
test('unrecognized paystack key (no sk_ prefix) => FATAL unknown mode', () => {
  const r = runProductionGuardrails(
    buildEnv({
      PAYSTACK_SECRET_KEY: 'Bearer my-secret-token-without-prefix',
    }),
  );

  const paystackFatal = r.fatalProblems.find((p) => /DOES NOT start with sk_live_ OR sk_test_/.test(p));
  expect(paystackFatal).toBeDefined();
  expect(r.paymentModes.paystack).toBe('unknown');
  expect(r.summary.anyProviderIncomplete).toBe(true);
});

// -----------------------------------------------------------------------------
// 7. Alatpay mode typo "SANDBOXx" or "production-old" → FATAL unknown mode
// -----------------------------------------------------------------------------
test('alatpay mode typo => FATAL unknown mode, alatpay:unknown', () => {
  const r = runProductionGuardrails(buildEnv({ ALATPAY_MODE: 'sandboxxx' }));
  const fatal = r.fatalProblems.find((p) => /ALATPAY_MODE.*not one of the allowed/.test(p));
  expect(fatal).toBeDefined();
  expect(r.paymentModes.alatpay).toBe('unknown');
  expect(r.summary.anyProviderIncomplete).toBe(true);
});

// -----------------------------------------------------------------------------
// 8. Weak JWT + placeholder enc = both FATAL.  Modes still reported correctly.
// -----------------------------------------------------------------------------
test('weak JWT + placeholder ENC => 2+ fatal preserved, modes still correct', () => {
  const r = runProductionGuardrails(
    buildEnv({
      JWT_SECRET: 'admin123',
      ENCRYPTION_KEY: '0000000000000000000000000000000000000000000000000000000000000000',
    }),
  );
  expect(r.fatalProblems.length).toBeGreaterThanOrEqual(2);
  const j = r.fatalProblems.find((p) => /JWT_SECRET/.test(p));
  const e = r.fatalProblems.find((p) => /ENCRYPTION_KEY/.test(p));
  expect(j).toBeDefined();
  expect(e).toBeDefined();
  // modes still correctly reported even in a failing configuration
  expect(r.paymentModes.paystack).toBe('test');
  expect(r.paymentModes.alatpay).toBe('sandbox');
  expect(r.paymentModeWarnings.length).toBeGreaterThanOrEqual(2);
});

// -----------------------------------------------------------------------------
// 9. localhost + 192.168 private IP URLs => 2 URL fatals preserved
// -----------------------------------------------------------------------------
test('localhost cors + private ip public url => private-ip refs in fatal', () => {
  const r = runProductionGuardrails(
    buildEnv({
      CORS_ORIGIN: 'http://localhost:5173',
      PUBLIC_URL: 'http://192.168.1.10:3001',
    }),
  );
  expect(r.fatalProblems.length).toBeGreaterThanOrEqual(1);
  const urlFatal = r.fatalProblems.find((p) => /localhost.*private IP/i.test(p));
  expect(urlFatal).toBeDefined();
});

// -----------------------------------------------------------------------------
// 10. CORS_ORIGIN + FRONTEND_BASE_URL both empty => CORS empty FATAL preserved
// -----------------------------------------------------------------------------
test('empty cors + empty frontend base url => CORS empty fatal preserved', () => {
  const env = buildEnv();
  delete (env as any).CORS_ORIGIN;
  delete (env as any).FRONTEND_BASE_URL;
  const r = runProductionGuardrails(env);
  const corsFatal = r.fatalProblems.find((p) => /CORS_ORIGIN \+ FRONTEND_BASE_URL are both empty/i.test(p));
  expect(corsFatal).toBeDefined();
});

// -----------------------------------------------------------------------------
// 11. No RESEND + no SMTP => email-config fatal preserved
// -----------------------------------------------------------------------------
test('absent RESEND + absent SMTP => email fatal preserved', () => {
  const env = buildEnv();
  delete (env as any).RESEND_API_KEY;
  delete (env as any).SMTP_HOST;
  delete (env as any).SMTP_PORT;
  const r = runProductionGuardrails(env);
  const em = r.fatalProblems.find((p) => /Neither RESEND_API_KEY nor SMTP_HOST/i.test(p));
  expect(em).toBeDefined();
});

// -----------------------------------------------------------------------------
// 12. ENCRYPTION_KEY not 64 hex => fatal (new check, zod in server.ts already
//     requires 64 hex but we want a guardrail error before that parse runs).
// -----------------------------------------------------------------------------
test('non 64-hex ENCRYPTION_KEY => fatal', () => {
  const r = runProductionGuardrails(
    buildEnv({ ENCRYPTION_KEY: 'not-a-hex-string-and-not-64-chars' }),
  );
  const enc = r.fatalProblems.find((p) => /ENCRYPTION_KEY must be exactly 64 hex/i.test(p));
  expect(enc).toBeDefined();
});

// -----------------------------------------------------------------------------
// 13. ALATPAY_MODE undefined → defaults to sandbox (matches zod schema default
//     in server.ts — intentional).
// -----------------------------------------------------------------------------
test('alatpay_mode undefined => defaults to sandbox mode with warning', () => {
  const env = buildEnv();
  delete (env as any).ALATPAY_MODE;
  const r = runProductionGuardrails(env);
  expect(r.paymentModes.alatpay).toBe('sandbox');
  const alat = r.paymentModeWarnings.find((w) => w.provider === 'ALATPAY/WEMA');
  expect(alat).toBeDefined();
  expect(alat!.message.toLowerCase()).toMatch(/sandbox/);
});

// -----------------------------------------------------------------------------
// 14. PURE FUNCTION: input env object is never mutated.
// -----------------------------------------------------------------------------
test('pure function: does not mutate env input (no silent live upgrade)', () => {
  const env = buildEnv({ PAYSTACK_SECRET_KEY: 'sk_test_MUTATECHECK' });
  const frozen: Record<string, unknown> = {};
  Object.keys(env).forEach((k) => (frozen[k] = (env as any)[k]));
  // Deep freeze-ish — we only need shallow for our simple values
  Object.freeze(env);

  const r = runProductionGuardrails(env);
  expect(r).toBeDefined();
  Object.keys(frozen).forEach((k) => {
    expect((env as any)[k]).toStrictEqual(frozen[k]);
  });
  // explicitly verify we did not swap PAYSTACK to live (safety invariant for
  // the real-money claim: guardrails NEVER modify env values)
  expect((env as any).PAYSTACK_SECRET_KEY).toBe('sk_test_MUTATECHECK');
});

// -----------------------------------------------------------------------------
// 15. MODE INDEPENDENCE: warnings array empty DOES NOT IMPLY live.
//     Build a case where we REMOVE Paystack fatal first, but then try to
//     mislead by claiming "all live".  Summary flags must be independent of
//     warnings array length.
// -----------------------------------------------------------------------------
test('summary.anyProviderLive independent of warnings.length', () => {
  // Case: all live (0 warnings)
  const live: GuardrailResult = runProductionGuardrails(
    buildEnv({
      PAYSTACK_SECRET_KEY: 'sk_live_xxx',
      ALATPAY_MODE: 'prod',
      ALATPAY_PROD_SECRET_KEY: 'prod_x',
    }),
  );
  expect(live.summary.anyProviderLive).toBe(true);
  expect(live.summary.allProvidersLive).toBe(true);

  // Case: paystack live + alatpay sandbox (1 warning, ANY provider still live)
  const mixed: GuardrailResult = runProductionGuardrails(
    buildEnv({
      PAYSTACK_SECRET_KEY: 'sk_live_xxx',
      ALATPAY_MODE: 'sandbox',
    }),
  );
  expect(mixed.paymentModeWarnings.length).toBeGreaterThanOrEqual(1);
  expect(mixed.summary.anyProviderLive).toBe(true);
  expect(mixed.summary.allProvidersLive).toBe(false);

  // Case: all sandbox/test (warnings.length 2+ but no live provider)
  const test: GuardrailResult = runProductionGuardrails(buildEnv());
  expect(test.paymentModeWarnings.length).toBeGreaterThanOrEqual(2);
  expect(test.summary.anyProviderLive).toBe(false);
});
