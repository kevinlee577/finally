import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8000';

export default defineConfig({
  testDir: './e2e',
  globalSetup: './global-setup.ts',

  // --- Serial execution is REQUIRED, not a performance preference. ---
  // FinAlly is a single-user app: one SQLite file, one hardcoded user_id
  // ("default"), one shared cash balance and watchlist (PLAN.md §7). Running
  // specs in parallel would have workers trading against each other's cash and
  // mutating each other's watchlist, producing failures that look like product
  // bugs but are really harness bugs. Keep workers at 1.
  workers: 1,
  fullyParallel: false,

  // No retries on purpose. The deliverable for this suite is a findings report
  // (planning/E2E_REPORT.md); silently passing on a second attempt would hide
  // exactly the intermittent races (SSE, snapshot timing, quote_unavailable)
  // that are most worth reporting. A flake here is a finding.
  retries: 0,

  // Fail the run if someone leaves a test.only in a spec.
  forbidOnly: !!process.env.CI,

  timeout: 45_000,
  expect: {
    // Live price data arrives on a stream; give assertions room to settle
    // without resorting to hard sleeps in the specs.
    timeout: 10_000,
  },

  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    // Machine-readable results, used to compile planning/E2E_REPORT.md.
    ['json', { outputFile: 'results.json' }],
  ],

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
