import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the admin-web e2e suite (Task 16).
 *
 * The suite drives the built Vite app against the live API + MySQL. The
 * `webServer` provision starts the Vite dev server (which proxies `/api` to
 * `http://localhost:3000` — see `vite.config.ts`) so the browser sees the real
 * admin SPA talking to the real backend. The API itself is NOT started here:
 * CI starts it as a separate process (or a service) and runs
 * `prisma migrate deploy` first so the DB is ready.
 *
 * Tests are tagged `@m1` and live in `e2e/`. We pin a single chromium project
 * to keep CI fast and deterministic.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: process.env.ADMIN_WEB_URL ?? 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
