import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));
const pkg = (name: string) => resolve(root, 'packages', name, 'src');

export default defineConfig({
  // Tests run against source, so they never depend on a stale build.
  resolve: {
    alias: {
      '@transferhub/config': pkg('config'),
      '@transferhub/db': pkg('db'),
      '@transferhub/platform': pkg('platform'),
      '@transferhub/core': pkg('core'),
    },
  },
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/api/src/**/*.test.ts',
      'apps/worker/src/**/*.test.ts',
    ],
    globalSetup: ['./test/global-setup.ts'],
    // Database tests share one test database; run files one at a time so they cannot interfere.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
    env: {
      APP_ENV: 'test',
      LOG_LEVEL: 'silent',
    },
  },
});
