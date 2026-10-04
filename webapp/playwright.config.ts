import { defineConfig } from '@playwright/test';

/**
 * E2E smoke config — targets an ALREADY-RUNNING server (CI boots the fresh
 * Docker image; locally: `next start` or the compose stack).
 *
 * Browser strategy: never download Playwright browsers in CI.
 *  - PW_CHROMIUM_PATH set (local runs): use that system/browser binary.
 *  - otherwise: channel 'chrome' (Google Chrome is preinstalled on
 *    GitHub's ubuntu runners).
 *
 * timezoneId is pinned to America/Toronto: TOU categorization happens in the
 * browser and must match Ontario wall-clock regardless of runner TZ.
 */
const executablePath = process.env.PW_CHROMIUM_PATH;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.SMOKE_BASE_URL || 'http://localhost:3000',
    timezoneId: 'America/Toronto',
    locale: 'en-CA',
    ...(executablePath
      ? { launchOptions: { executablePath } }
      : { channel: 'chrome' }),
  },
});
