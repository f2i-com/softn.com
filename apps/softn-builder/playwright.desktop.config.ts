import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test-desktop',
  outputDir: '../../../ecosystem-audit/softn-builder-desktop-tests',
  timeout: 60_000,
  workers: 1,
  use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 900 } },
});
