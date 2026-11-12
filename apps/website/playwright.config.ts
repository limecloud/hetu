import { defineConfig } from '@playwright/test';

const origin = process.env.HETU_TEST_ORIGIN;
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  workers: 2,
  timeout: 30_000,
  use: {
    baseURL: origin || 'http://127.0.0.1:4351',
    headless: true,
    launchOptions: process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {},
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: origin ? undefined : {
    command: 'npm run preview -- --ignore-lock',
    url: 'http://127.0.0.1:4351',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
