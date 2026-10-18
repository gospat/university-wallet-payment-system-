import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'happy-dom',
    globals: false,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // The React render suites are executed in a shared happy-dom environment;
    // the default 5s budget is too tight on slower/loaded CI runners. This only
    // relaxes timing — every assertion still has to pass.
    testTimeout: 15_000,
  },
});
