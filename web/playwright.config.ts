import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
export const API_PORT = 3100;

export default defineConfig({
  testDir: './e2e',
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  // The tests share one API and database and run as one story, so they go one at a time.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
    timezoneId: 'Europe/Berlin',
  },
  projects: [{ name: 'phone', use: { ...devices['Pixel 7'] } }],
  webServer: [
    {
      // The real API on a throwaway database with a fake payment provider; see backend/test/e2e-server.ts.
      command: 'npm --prefix ../backend run e2e:server',
      url: `http://localhost:${API_PORT}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
    {
      command: `npm run build && npm run preview -- --port ${PORT} --strictPort`,
      url: `http://localhost:${PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: { VITE_API_BASE_URL: `http://localhost:${API_PORT}` },
    },
  ],
});
