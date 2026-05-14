/**
 * Helpers for driving the side-panel UI from Playwright tests.
 *
 * The selectors are the existing class names in App.tsx — no `data-testid`
 * attributes were added to the source. If those classes change, update here.
 */

import type { BrowserContext, Page } from '@playwright/test';

/**
 * Force the page to always report focused-state, even when it's not the OS
 * frontmost tab. Required for `document.execCommand('insertText')` based
 * contenteditable fills to fire their internal `beforeinput` event — without
 * focus, execCommand silently no-ops the event, which breaks listeners that
 * depend on beforeinput (Lexical / ProseMirror / Slate style editors).
 *
 * Uses CDP `Emulation.setFocusEmulationEnabled`. Playwright doesn't expose
 * this as a high-level API; we drop down to a raw CDP session.
 */
export async function forceFocus(context: BrowserContext, page: Page): Promise<void> {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
}

const ACTIVE_PANE = '.pane.active';
const JSON_EDITOR = `${ACTIVE_PANE} .json-editor`;
const RUN_BUTTON = `${ACTIVE_PANE} .run`;
const LOG_LINE = '.log .log-line .msg';

/**
 * Fill the JSON editor and trigger Run on the panel, while keeping `fixture`
 * the active tab so `chrome.tabs.query({active:true})` resolves to it.
 *
 * Critical: we use `panel.evaluate(...)` to click the Run button instead of
 * `locator.click()`. A regular click in Playwright would bring the panel
 * tab to the front, making it the active tab — and chrome.tabs.query would
 * then resolve to the side panel itself rather than the fixture page,
 * breaking the automation.
 */
export async function pasteAndRun(panel: Page, fixture: Page, json: object): Promise<void> {
  // Fill the textarea. `locator.fill` triggers React's onChange via the
  // input event, so the controlled state updates correctly.
  await panel.locator(JSON_EDITOR).fill(JSON.stringify(json, null, 2));

  // Make the fixture the active tab BEFORE triggering Run.
  await fixture.bringToFront();

  // Programmatic click — doesn't change focus, so the fixture stays active.
  await panel.evaluate((sel) => {
    const btn = document.querySelector<HTMLButtonElement>(sel);
    if (!btn) throw new Error(`Run button not found at selector: ${sel}`);
    btn.click();
  }, RUN_BUTTON);
}

/**
 * Wait until any log line contains `fragment`. Throws if not seen within
 * `timeoutMs`. Useful for waiting on the engine's "Finished" success log or
 * a specific fatal message.
 */
export async function waitForLog(
  panel: Page,
  fragment: string,
  timeoutMs = 30_000,
): Promise<void> {
  await panel
    .locator(LOG_LINE, { hasText: fragment })
    .first()
    .waitFor({ timeout: timeoutMs });
}

/** All log lines as text, in order. Useful for snapshot-style assertions. */
export async function readLog(panel: Page): Promise<string[]> {
  return panel.locator(LOG_LINE).allTextContents();
}

/** True if any log line contains the substring. Non-throwing variant of waitForLog. */
export async function logContains(panel: Page, fragment: string): Promise<boolean> {
  const count = await panel.locator(LOG_LINE, { hasText: fragment }).count();
  return count > 0;
}
