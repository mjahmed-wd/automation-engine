/**
 * Playwright configuration — E2E tests for the automation extension.
 *
 * Per WXT's testing docs, Playwright is the recommended tool for Chrome
 * Extension E2E. We launch a persistent Chromium context with the built
 * extension loaded from .output/chrome-mv3 and drive it like a real user.
 *
 * Key constraints:
 *   - `headless: false` — Chrome Extensions don't load in headless mode.
 *     CI on Linux needs xvfb-run wrapping `npm run test:e2e`.
 *   - `workers: 1` + `fullyParallel: false` — the extension's side panel
 *     state isn't reentrant-safe (one chrome.debugger session per tab).
 *     Serializing avoids cross-test contention. Slower but reliable.
 *
 * Run with `npm run test:e2e` (builds first) or `npx playwright test`
 * (assumes the build is current).
 */

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/specs',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
  ],
  use: {
    headless: false,
    actionTimeout: 15_000,
    trace: 'on-first-retry',
    video: 'retain-on-failure',
  },
});
