import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  reporter: 'line',
  fullyParallel: false,
  workers: 1,
  use: {
    channel: 'chrome',
    headless: true,
    trace: 'on-first-retry',
  },
});
