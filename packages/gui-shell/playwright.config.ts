import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 1 : 0,
  workers: 1,
  reporter: process.env['CI'] ? 'dot' : 'line',
  outputDir: '../../output/playwright/gui-shell',
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  use: {
    trace: 'retain-on-failure',
  },
});
