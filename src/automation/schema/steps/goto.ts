/**
 * Navigate the active tab. The default behavior waits for `tabs.onUpdated`
 * to report `'complete'` — but on modern SPAs that fires when the HTML
 * shell loads, not when the framework has mounted the page content. For
 * those, set `waitForXPath` so the goto only resolves once an element
 * matching that xpath actually appears (uses the same `waitFor`
 * infrastructure as the standalone action).
 *
 *   { "action": "goto", "url": "https://example.com/dashboard",
 *     "waitForXPath": "//h1[normalize-space(.)='Dashboard']",
 *     "waitForTimeoutMs": 10000 }
 */

import type { BaseStep } from '../base';

export interface GotoStep extends BaseStep {
  action: 'goto';
  url: string;
  /** XPath to wait for after the tab signals 'complete'. Default 20s. */
  waitForXPath?: string;
  /** Override for the waitFor timeout. Only meaningful with waitForXPath. */
  waitForTimeoutMs?: number;
}
