/**
 * Wait for a Network response event (Batch 3). Backed by CDP
 * `Network.responseReceived` via a per-tab `EventWaiter` ringbuffer, so
 * responses that landed up to ~30s before the await starts still resolve.
 *
 * URL matching mirrors `tab waitForNew`: plain string is a substring,
 * `/regex/flags` is a RegExp. Both support `{{var}}` substitution.
 *
 * Status filter accepts three shapes, in increasing flexibility:
 *   - `200`                        — exact match
 *   - `[200, 201, 204]`            — any-of
 *   - `{ ">=": 200, "<": 300 }`    — range (AND of comparisons)
 *
 * Method filter is an uppercase HTTP verb. Omit any filter to accept all.
 *
 * Body reading is opt-in via `saveBody`. When set, the engine calls
 * `Network.getResponseBody` after the event arrives and stores the response
 * body (decoded if base64) as `ctx.outputs[saveBody]`. Skipping this is one
 * fewer CDP roundtrip; only request it when you actually need the body.
 *
 *   { "action": "waitForResponse", "urlMatches": "/api/save/", "status": 200,
 *     "method": "POST", "saveBody": "saved" }
 *
 * Note: enabling the CDP Network domain (which `Page.init` does) disables
 * Chrome's disk cache for the attached debugger session — fine for
 * automation, but worth knowing if a script behaves differently with the
 * engine attached.
 */

import type { BaseStep, RetryFields } from '../base';

export interface WaitForResponseStep extends BaseStep, RetryFields {
  action: 'waitForResponse';
  /** URL substring or `/regex/flags`. Required. Supports `{{var}}`. */
  urlMatches: string;
  /** Status filter — exact, any-of, or range comparison. Omit to accept any. */
  status?: number | number[] | Record<'>=' | '>' | '<=' | '<' | '==', number>;
  /** HTTP method filter (case-insensitive in JSON, compared uppercase). */
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
  /** Wall-clock budget. Network is slower than DOM, so default is 30s. */
  timeoutMs?: number;
  /** Save the matched URL into ctx.outputs[saveUrl]. */
  saveUrl?: string;
  /** Save the matched status code (as a string) into ctx.outputs[saveStatus]. */
  saveStatus?: string;
  /** Read the response body via Network.getResponseBody and save to
   *  ctx.outputs[saveBody]. Skip when not needed (extra CDP roundtrip). */
  saveBody?: string;
}
