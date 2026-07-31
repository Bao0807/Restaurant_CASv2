import dotenv from 'dotenv';
import { defineConfig, devices } from '@playwright/test';

dotenv.config({ path: 'apps/api/.env' });

const useExternalServers = process.env.PLAYWRIGHT_EXTERNAL_SERVERS === 'true';

export default defineConfig({
  testDir: './e2e',
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
  webServer: useExternalServers
    ? undefined
    : [
        {
          command: 'npm run start:api',
          url: 'http://127.0.0.1:4100/api/health',
          reuseExistingServer: true,
          timeout: 30_000,
        },
        {
          command: 'npm run dev:web -- --host 127.0.0.1',
          url: 'http://127.0.0.1:5173',
          reuseExistingServer: true,
          timeout: 30_000,
        },
      ],
});
