/**
 * Iterate over a list of items (Batch 4). Runs the `do` step array once per
 * item, exposing the current item as `ctx.variables[as]` for `{{var}}`
 * substitution inside the loop body.
 *
 * `items` accepts two shapes:
 *   - **String** — JSON5 string; resolved via `substituteRaw` (so it can
 *     reference a previous step's `saveAs` output), then split on `,` and
 *     each entry trimmed. Use this for "process this comma-separated list".
 *   - **JSON array of strings** — `["a", "b", "c"]` literal. Use this for
 *     small known-up-front lists.
 *
 * After the loop, `ctx.variables[as]` is removed so substitution outside
 * the loop doesn't see a stale value.
 *
 * Caveat: `saveAs` outputs from inside the loop COLLIDE across iterations
 * (last write wins). Most workflows don't need per-iteration outputs;
 * for those that do, save into the page DOM and read all values after.
 *
 *   { "action": "forEach",
 *     "items": ["C-1001", "C-1002", "C-1003"],
 *     "as": "id",
 *     "do": [
 *       { "action": "tab", "op": "open", "url": "/customers/{{id}}/edit" },
 *       { "action": "fill", "xpath": "//textarea[@name='note']",
 *         "value": "Processed {{id}}" },
 *       { "action": "click", "xpath": "//button[.='Save']" },
 *       { "action": "tab", "op": "close" }
 *     ] }
 */

import type { BaseStep } from '../base';
import type { AutomationStep } from '../union';

export interface ForEachStep extends BaseStep {
  action: 'forEach';
  items: string | string[];
  as: string;
  do: AutomationStep[];
}
