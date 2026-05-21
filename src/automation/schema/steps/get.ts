/**
 * `get` reads any value from the matched element: input value, text content,
 * an attribute, or a regex extract over any of those.
 *
 * Default property when neither `attribute` nor `property` is set:
 *   - `<input>` / `<textarea>` / `<select>`  → "value"
 *   - everything else                        → "innerText"
 *
 * `attribute` takes precedence over `property` if both are provided.
 * If `regex` matches, the first capture group is returned; otherwise the
 * full match. No match → empty string.
 */

import type { BaseStep, RetryFields } from '../base';

export interface GetStep extends BaseStep, RetryFields {
  action: 'get';
  xpath: string;
  attribute?: string;
  property?: string;
  regex?: string;
  regexFlags?: string;
  saveAs?: string;
  pierceClosed?: boolean;
  /** Cap how long the locator-search loop polls before failing. Default 20s. */
  timeoutMs?: number;
}
