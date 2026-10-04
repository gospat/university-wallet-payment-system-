import type { Config } from 'jest';

const jestDefaults: Record<string, string> = {
  JWT_SECRET: 'test-jwt-secret-sufficient-length-32-chars-xyz',
  JWT_REFRESH_SECRET: 'test-jwt-refresh-secret-unique-32chars-xyz',
  NODE_ENV: 'test',
  PAYSTACK_SECRET_KEY: 'sk_test_dummy',
  PAYSTACK_PUBLIC_KEY: 'pk_test_dummy',
  ALATPAY_SECRET_KEY: 'sk_test_alat_dummy',
  ALATPAY_WEBHOOK_SECRET: 'wbhk_test_alat_dummy',
  PAYSTACK_WEBHOOK_SECRET: 'wbhk_test_paystack_dummy',
  REDIS_URL: '',
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
  setupFiles: ['dotenv/config'],
};

export default config;

