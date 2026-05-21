/**
 * Escape hatch for arbitrary JS evaluation in the main frame. Runs the
 * expression via `Runtime.evaluate` with `returnByValue:true` + `awaitPromise:true`,
 * so:
 *   - Expressions return their value (e.g. `document.title`).
 *   - Promises are awaited (e.g. `(async () => await fetch('/x').then(r => r.json()))()`).
 *   - Multiple statements need to be wrapped in an IIFE — `Runtime.evaluate` is
 *     script-mode, so a bare `var x = 5; x` returns undefined; write
 *     `(() => { var x = 5; return x; })()` instead.
 *
 * The returned value is JSON-serialized into `ctx.outputs[saveAs]`. Null /
 * undefined become "", numbers / booleans get `String()`, objects / arrays
 * get `JSON.stringify()`.
 *
 * Frame: main frame only in this iteration. For same-origin iframes, reach
 * across in your expression (`document.querySelector('iframe').contentWindow.…`).
 */

import type { BaseStep, RetryFields } from '../base';

export interface EvaluateStep extends BaseStep, RetryFields {
  action: 'evaluate';
  expression: string;
  saveAs?: string;
  /** Server-side timeout for `awaitPromise` cases. Omit for no timeout. */
  timeoutMs?: number;
}
