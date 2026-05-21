/**
 * Programmatically pick option(s) in a native `<select>`. Setting
 * `select.value` (single) or `option.selected` (multi) is much more reliable
 * than clicking — native select dropdowns render as an OS-level popup that
 * doesn't accept synthetic clicks.
 *
 * Match by exactly one of:
 *   - `value`: matches `option.value` (the value attribute / submitted value)
 *   - `label`: matches `option.label` (the visible text)
 *
 * Either can be a string (single match) or an array (multi-select).
 *
 * Multi-select semantics are "set to exactly these" — any option whose
 * value/label isn't in the wanted set gets unselected. (Playwright-style.)
 *
 *   { "action": "selectOption", "xpath": "//select[@id='country']", "label": "Bangladesh" }
 *   { "action": "selectOption", "xpath": "//select[@multiple]", "value": ["red", "blue"] }
 */

import type { BaseStep, RetryFields } from '../base';

export interface SelectOptionStep extends BaseStep, RetryFields {
  action: 'selectOption';
  xpath: string;
  value?: string | string[];
  label?: string | string[];
  /** Accepted for parity; `cdpResolveXPath` already pierces closed shadow. */
  pierceClosed?: boolean;
  /** How long to poll for the select to appear in the DOM. Default 20s. */
  timeoutMs?: number;
}
