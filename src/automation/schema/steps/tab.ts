/**
 * Multi-tab / multi-window orchestration. CRM-style flows often pivot through
 * new tabs (click a row → detail opens → fill → close → repeat) or sized
 * popup windows (open a lookup window → grab info → close → resume). Today
 * the engine is bound to one `tabId` at construction; this step lets a
 * script open new tabs and windows, switch among them, and close them.
 *
 * Ops:
 *   - `open`        — proactively open a new tab in the current window at
 *                     `url`. Pairs with `waitForXPath` / `waitForTimeoutMs`.
 *   - `openWindow`  — proactively open a new BROWSER WINDOW at `url`. Use
 *                     `windowType: 'popup'` + `width` / `height` / `left` /
 *                     `top` for a sized lookup window; default is a regular
 *                     Chrome window. Pairs with `waitForXPath` /
 *                     `waitForTimeoutMs` like `open`.
 *   - `switchTo`    — focus a tab matching `urlMatches` (substring or
 *                     `/regex/flags`) or `index` (0-based, within the window).
 *                     Exactly one of `urlMatches` or `index` must be supplied.
 *   - `waitForNew`  — wait for a new tab opened by the previous step's side
 *                     effect (e.g., `click` on a `target="_blank"` link).
 *                     Optional `urlMatches` to disambiguate.
 *   - `close`       — close the current tab and pop back to the previous one.
 *                     The engine maintains an internal origin stack: every
 *                     `open` / `openWindow` / `switchTo` / `waitForNew` pushes
 *                     the prior tab; `close` pops + reactivates whatever's on
 *                     top. Closing the only tab in a popup window also closes
 *                     the window (Chrome default).
 *   - `next`/`previous` — cycle to the adjacent tab in the same window.
 *
 *   { "action": "tab", "op": "open", "url": "https://lookup.internal/sku/{{sku}}",
 *     "waitForXPath": "//span[@id='price']" }
 *   { "action": "tab", "op": "openWindow", "url": "https://en.wikipedia.org/wiki/Foo",
 *     "windowType": "popup", "width": 700, "height": 500,
 *     "waitForXPath": "//h1[@id='firstHeading']" }
 *   { "action": "tab", "op": "waitForNew", "urlMatches": "/customers/" }
 *   { "action": "tab", "op": "close" }
 */

import type { BaseStep, RetryFields } from '../base';

export interface TabStep extends BaseStep, RetryFields {
  action: 'tab';
  op:
    | 'open'
    | 'openWindow'
    | 'switchTo'
    | 'waitForNew'
    | 'close'
    | 'next'
    | 'previous';
  /** For `open` / `openWindow`: the URL to navigate the new tab/window to.
   *  Supports `{{var}}`. */
  url?: string;
  /** For `open` / `openWindow`: optional xpath to wait for after the tab
   *  signals 'complete'. */
  waitForXPath?: string;
  /** For `open` / `openWindow`: override for the post-load waitFor timeout
   *  (default 20s). */
  waitForTimeoutMs?: number;
  /** For `openWindow`: Chrome window type. `'normal'` is a regular window
   *  with full chrome; `'popup'` is a minimal window without tabs / address
   *  bar (good for sized lookup/auth dialogs). Default `'normal'`. */
  windowType?: 'normal' | 'popup';
  /** For `openWindow`: dimensions + position in CSS pixels. Omitted →
   *  Chrome picks defaults. */
  width?: number;
  height?: number;
  left?: number;
  top?: number;
  /** For `switchTo` / `waitForNew`: URL pattern to match. Plain string is a
   *  substring match; `/regex/flags` is a RegExp. Supports `{{var}}`. */
  urlMatches?: string;
  /** For `switchTo`: 0-based index in the window's tab strip. Mutex with `urlMatches`. */
  index?: number;
  /** For `waitForNew`: how long to wait for the new tab to appear. Default 10s. */
  timeoutMs?: number;
}
