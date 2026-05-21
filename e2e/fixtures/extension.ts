/**
 * Playwright fixture that launches a persistent Chromium context with the
 * built extension loaded. Exposes:
 *
 *   - `context`     — the persistent BrowserContext (auto-disposed)
 *   - `extensionId` — discovered from the registered service worker URL
 *   - `sidePanel`   — a Page navigated to the extension's sidepanel.html.
 *                     Functionally equivalent to the real chrome.sidePanel
 *                     UX for our purposes; React app initializes the same way.
 *
 * Notes:
 *   - The persistent-context launch uses --load-extension AND
 *     --disable-extensions-except so Chromium doesn't load any pre-installed
 *     extensions that could pollute the test environment.
 *   - --allow-file-access-from-files lets the extension's debugger attach to
 *     `file://` URLs (we use one for the mega-fixture).
 */

import { test as base, chromium, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// package.json has "type": "module" — Playwright runs these as ES modules,
// where CommonJS's __dirname is not defined. Derive it from import.meta.url.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const EXTENSION_PATH = path.join(PROJECT_ROOT, '.output', 'chrome-mv3');

export interface ExtensionFixtures {
  context: BrowserContext;
  extensionId: string;
  sidePanel: Page;
}

export const test = base.extend<ExtensionFixtures>({
  context: async ({}, use) => {
    const ctx = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--allow-file-access-from-files',
        '--no-first-run',
        '--no-default-browser-check',
        // file:// pages can't open popups by default even from a trusted
        // click handler — Chrome's popup blocker has additional restrictions
        // on local-file origins. Real users grant this via
        // chrome://settings/content/popups; Playwright's chromium doesn't
        // inherit that setting, so we pass the flag explicitly. Scopes only
        // to this test process.
        '--disable-popup-blocking',
      ],
    });

    // Playwright auto-dismisses dialogs when no listener is registered, which
    // races our extension's CDP Page.javascriptDialogOpening handler and
    // produces `confirmed: no` even when we asked for auto-accept. Registering
    // a no-op listener opts out of auto-dismissal; the extension's CDP session
    // then responds first and the dialog is handled the way the engine wants.
    const noopDialog = () => {
      /* deferred to extension's chrome.debugger session */
    };
    for (const existing of ctx.pages()) existing.on('dialog', noopDialog);
    ctx.on('page', (page) => page.on('dialog', noopDialog));

    await use(ctx);
    await ctx.close();
  },

  extensionId: async ({ context }, use) => {
    // The extension's service worker registers shortly after launch. It might
    // already be registered (existing[0]) or we may need to wait for the
    // 'serviceworker' event. Handle both.
    let worker = context.serviceWorkers()[0];
    if (!worker) {
      worker = await context.waitForEvent('serviceworker', { timeout: 10_000 });
    }
    // SW URL: chrome-extension://<id>/background.js
    const id = new URL(worker.url()).host;
    await use(id);
  },

  sidePanel: async ({ context, extensionId }, use) => {
    // Open the side panel HTML directly as a tab. The React app initializes
    // the same way as it would in the real side-panel UX; chrome.tabs.query
    // returns regular tabs (not the panel itself), so messages still route
    // to the fixture tab as expected.
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    // Wait for the App component to render (textarea + Run button visible).
    await panel.locator('textarea.json-editor').waitFor({ timeout: 10_000 });
    await use(panel);
    await panel.close().catch(() => {});
  },
});

export { expect } from '@playwright/test';
