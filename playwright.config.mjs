import { defineConfig } from '@playwright/test';

// Runs the production build (API serving web/dist) against the seeded demo centre.
// Set E2E_CHANNEL=msedge or chrome to use an installed browser instead of Playwright's Chromium.
const port = Number(process.env.E2E_PORT ?? 4180);

export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.spec.mjs',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    channel: process.env.E2E_CHANNEL || undefined,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node server/src/index.js',
    url: `http://localhost:${port}/api/health`,
    env: { PORT: String(port), ENABLE_SIMULATOR: 'true' },
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
