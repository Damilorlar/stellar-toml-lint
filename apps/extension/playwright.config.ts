import { defineConfig } from '@playwright/test';

/**
 * Extension e2e configuration.
 *
 * `testMatch` is `*.e2e.ts` on purpose: the repository's vitest run collects
 * `*.test.ts` and `*.spec.ts`, and these tests need a real browser with
 * extension support (and therefore a display — use `xvfb-run` in CI). Keeping
 * the two globs disjoint is what stops `npm test` from depending on Chrome.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
});
