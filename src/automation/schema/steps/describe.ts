/**
 * Side-effect-free diagnostic. Returns `{ matchCount, matches: [...] }` for
 * the xpath — the count of matching elements (across light DOM, open shadow,
 * and same-origin iframes) plus metadata for up to the first 5: frame URL,
 * tag, id, name, classes, and a 60-char snippet of innerText.
 *
 * No polling — `describe` reports the page's state *now*. Pair it with a
 * `waitFor` step beforehand if you need the element to render first.
 *
 * Closed-shadow caveat: when routed through the CDP path (via
 * `pierceClosed:true` or the auto-detected closed-shadow flag), the result
 * contains at most one match — extending the CDP DOM walk to enumerate every
 * match wasn't worth the complexity for the v1 diagnostic.
 *
 *   { "action": "describe", "xpath": "//button", "saveAs": "buttons" }
 */

import type { BaseStep, RetryFields } from '../base';

export interface DescribeStep extends BaseStep, RetryFields {
  action: 'describe';
  xpath: string;
  /** Save the result as a JSON string to ctx.outputs[saveAs]. */
  saveAs?: string;
  /** Force the CDP DOM walk (for closed-shadow content). Returns first match only. */
  pierceClosed?: boolean;
}
