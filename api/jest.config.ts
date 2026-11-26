import type { Config } from 'jest';

const jestDefaults: Record<string, string> = {
  JWT_SECRET: 'test-jwt-secret-sufficient-length-32-chars-xyz',
  JWT_REFRESH_SECRET: 'test-jwt-refresh-secret-unique-32chars-xyz',
  NODE_ENV: 'test',
  PAYSTACK_SECRET_KEY: 'sk_test_dummy',
  PAYSTACK_PUBLIC_KEY: 'pk_test_dummy',
  ALATPAY_SECRET_KEY: 'sk_test_alat_dummy',
  ALATPAY_PUBLIC_KEY: 'pk_test_alat_dummy',
  ALATPAY_BUSINESS_ID: 'test-alat-business-id',
  ALATPAY_WEBHOOK_SECRET: 'wbhk_test_alat_dummy',
  PAYSTACK_WEBHOOK_SECRET: 'wbhk_test_paystack_dummy',
  // AES-256-CBC key consumed by `utils/encryption.ts` (must be 32 bytes / 64
  // hex). A deterministic TEST-ONLY value so suites that exercise encryption at
  // import time (e.g. the MFA suite) run in CI, where no `api/.env` is present —
  // exactly like the dummy JWT/payment secrets above.
  ENCRYPTION_KEY: '3f8a1c9e5d2b7046af93e1c5b8d24076fa1c3e9072b4d6581e9f0a3c7b2d5146',
  REDIS_URL: '',
  REDIS_LAZY_CONNECT: 'true',
  // MFA ENROLMENT ENFORCEMENT is OFF for the existing suite so that the new
  // `protect()` MFA_ENROLLMENT_REQUIRED gate never alters the behaviour the
  // pre-existing tests assert. The dedicated MFA suite
  // (`src/__tests__/mfa-hardening.test.ts`) turns the policy ON per-test to
  // exercise the gate explicitly. Production default remains `staff`.
  MFA_ENFORCEMENT: 'off',
};
for (const [k, v] of Object.entries(jestDefaults)) {
  if (!process.env[k]) process.env[k] = v;
}

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  clearMocks: true,
  maxWorkers: 1,
  setupFiles: ['dotenv/config'],
};

export default config;

