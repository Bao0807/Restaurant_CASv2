import dotenv from 'dotenv';
import { defineConfig, devices } from '@playwright/test';

dotenv.config({ path: 'apps/api/.env' });

const useExternalServers = process.env.PLAYWRIGHT_EXTERNAL_SERVERS === 'true';

export default defineConfig({
  testDir: './e2e',
  globalSetup: useExternalServers ? undefined : './e2e/local-servers.ts',
  timeout: 30_000,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
