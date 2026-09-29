/**
 * Production startup guardrails — runs runProductionGuardrails() against
 * synthetic env objects.
 *
 * Covers:
 *   - Sandbox/TEST PAYSTACK + sandbox ALATPAY mode => WARN ONLY (0 fatalProblems)
 *   - Live PAYSTACK + prod ALATPAY mode => 0 fatalProblems, 0 paymentModeWarnings
 *   - Invalid JWT/encryption secrets => fatalProblems contains both, STILL emits warnings correctly
 *   - CORS empty + localhost URL => fatalProblems (production URL hard checks preserved)
 *   - missing Resend + missing SMTP => fatalProblems (email configured? required always)
 *   - paystack key prefix detection (sk_live_ vs sk_test_)
 *   - alatpay mode detection (sandbox/prod)
 *   - No mutation of env (pure function)
 *
 * NOTE: the side-effectful IIFE (applyProductionGuardrails) is tested ONLY
 * indirectly here (it just calls our function, prints banners, exits on
 * fatal).  We don't run it because that would attach process.exit(2) in Jest.
 */
import { runProductionGuardrails, GuardrailResult } from '../server';

const STRONG_JWT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // 70 chars
const STRONG_ENC = 'c1a2f3e4d5b60718293afbecd4e5f60718293afbecd4e5f60718293afbecd4e5'; // 64 hex chars
const GOOD_URLS: Record<string, string> = {
  CORS_ORIGIN: 'https://payment.bellsuniversity.edu.ng',
  FRONTEND_BASE_URL: 'https://payment.bellsuniversity.edu.ng',
  PUBLIC_URL: 'https://paymentapi.bellsuniversity.edu.ng',
  APP_BASE_URL: 'https://payment.bellsuniversity.edu.ng',
  RESEND_API_KEY: 're_XXXXXXXXXXXXXXXXXXXXXXXXXX',
};

/** Paystack test + alatpay sandbox — EXACTLY the VPS go-live scenario */
function sandboxEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    PAYSTACK_SECRET_KEY: 'sk_test_abcdef123456789',
    ALATPAY_MODE: 'sandbox',
    JWT_SECRET: STRONG_JWT,
    ENCRYPTION_KEY: STRONG_ENC,
    ...GOOD_URLS,
  };
}

function liveEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    PAYSTACK_SECRET_KEY: 'sk_live_abcdef123456789',
    ALATPAY_MODE: 'prod',
    JWT_SECRET: STRONG_JWT,
    ENCRYPTION_KEY: STRONG_ENC,
    ...GOOD_URLS,
  };
}

describe('runProductionGuardrails (sandbox/live/fatal categories)', () => {
  test('sandbox mode: paystack sk_test_ + alatpay sandbox => 0 fatal, warns ONLY (startup allowed)', () => {
    const res: GuardrailResult = runProductionGuardrails(sandboxEnv());
    expect(res.fatalProblems).toEqual([]);
    expect(res.paymentModes.paystack).toBe('test');
    expect(res.paymentModes.alatpay).toBe('sandbox');
    expect(res.paymentModeWarnings.length).toBeGreaterThanOrEqual(2);
    expect(res.paymentModeWarnings.map(w => w.provider)).toEqual(expect.arrayContaining(['PAYSTACK', 'ALATPAY/WEMA']));
    // Must never silently "upgrade" to live — warnings should reference NO swap to sk_live_
    const joinedMsgs = res.paymentModeWarnings.map(w => w.message).join('\n');
    expect(joinedMsgs).toMatch(/sk_test_/);
    expect(joinedMsgs).toMatch(/sandbox/i);
    expect(joinedMsgs).not.toMatch(/we have auto.*live/i);
  });

  test('live mode: paystack sk_live_ + alatpay prod => 0 fatal, 0 warn-ONLY payment warnings, modes LIVE/PROD', () => {
    const res: GuardrailResult = runProductionGuardrails(liveEnv());
    expect(res.fatalProblems).toEqual([]);
    expect(res.paymentModes.paystack).toBe('live');
    expect(res.paymentModes.alatpay).toBe('prod');
    const paymentWarnPaystackOrAlat = res.paymentModeWarnings.filter(
      w => w.provider === 'PAYSTACK' || w.provider === 'ALATPAY/WEMA',
    );
    expect(paymentWarnPaystackOrAlat).toEqual([]);
  });

  test('weak JWT + placeholder encryption => fatal regardless of payment modes; modes still reported', () => {
    const env = sandboxEnv();
    env.JWT_SECRET = 'admin123'; // short + weak pattern
    env.ENCRYPTION_KEY = '0000000000000000000000000000000000000000000000000000000000000000';
    const res = runProductionGuardrails(env);
    expect(res.fatalProblems.some(s => /JWT_SECRET/i.test(s))).toBe(true);
    expect(res.fatalProblems.some(s => /ENCRYPTION_KEY/i.test(s))).toBe(true);
    // Payment warnings + modes still reported correctly
    expect(res.paymentModes.paystack).toBe('test');
    expect(res.paymentModes.alatpay).toBe('sandbox');
    expect(res.paymentModeWarnings.length).toBeGreaterThanOrEqual(2);
  });

  test('localhost CORS + no bellsuni ref => fatal (URL guards preserved; production-hardening still enforced)', () => {
    const env = sandboxEnv();
    env.CORS_ORIGIN = 'http://localhost:5173';
    env.PUBLIC_URL = 'http://192.168.1.1:3001';
    env.FRONTEND_BASE_URL = '';
    env.APP_BASE_URL = '';
    const res = runProductionGuardrails(env);
    expect(res.fatalProblems.some(s => /localhost|private IP/i.test(s))).toBe(true);
    expect(res.fatalProblems.some(s => /payment\.bellsuniversity|paymentapi\.bellsuniversity/i.test(s))).toBe(true);
  });

  test('empty CORS_ORIGIN + empty FRONTEND_BASE_URL => fatal CORS check preserved', () => {
    const env = sandboxEnv();
    env.CORS_ORIGIN = '';
    env.FRONTEND_BASE_URL = '';
    const res = runProductionGuardrails(env);
    expect(res.fatalProblems.some(s => /CORS_ORIGIN \+ FRONTEND_BASE_URL.*both empty/i.test(s))).toBe(true);
  });

  test('neither RESEND_API_KEY nor SMTP_HOST configured => FATAL (student emails would fail) — preserved strict', () => {
    const env = sandboxEnv();
    delete env.RESEND_API_KEY;
    env.SMTP_HOST = '';
    const res = runProductionGuardrails(env);
    expect(res.fatalProblems.some(s => /RESEND_API_KEY.*SMTP_HOST/i.test(s))).toBe(true);
  });

  test('paystack key with NO prefix => unknown mode + generic warning; alatpay default undefined => sandbox (zod DEFAULT)', () => {
    const env = sandboxEnv();
    env.PAYSTACK_SECRET_KEY = 'not-a-real-prefix-key';
    delete env.ALATPAY_MODE; // undefined -> our code defaults to sandbox like zod default
    const res = runProductionGuardrails(env);
    expect(res.paymentModes.paystack).toBe('unknown');
    expect(res.paymentModes.alatpay).toBe('sandbox');
    expect(res.paymentModeWarnings.some(w => /not start with sk_live_|sk_test_/i.test(w.message))).toBe(true);
  });

  test('pure function: does not mutate input env', () => {
    const env = sandboxEnv();
    const frozenJwt = env.JWT_SECRET;
    const frozenPay = env.PAYSTACK_SECRET_KEY;
    runProductionGuardrails(env);
    expect(env.JWT_SECRET).toBe(frozenJwt);
    expect(env.PAYSTACK_SECRET_KEY).toBe(frozenPay); // NEVER silently upgrade -> real-money safety
  });
});
