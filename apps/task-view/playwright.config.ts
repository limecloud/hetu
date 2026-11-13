import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  workers: 1,
  timeout: 20000,
  outputDir: "../../build/task-view/test-results",
  use: {
    headless: true,
    launchOptions: process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {},
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
