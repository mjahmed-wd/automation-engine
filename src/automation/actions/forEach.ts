/**
 * `forEach` action — iterate over a list of items, running `step.do` once
 * per item with `ctx.variables[step.as]` set to the current value.
 *
 * `items` accepts two shapes:
 *   - **String** — resolved via substituteRaw (so it can reference a
 *     previous step's saveAs output), then split on `,` and each part
 *     trimmed.
 *   - **JSON array of strings** — used directly.
 *
 * After the loop body completes for the last item, the loop variable is
 * REMOVED from `ctx.variables`. This keeps `{{var}}` substitution outside
 * the loop from seeing stale state, and matches the user's likely mental
 * model ("the variable only exists inside the loop").
 *
 * Caveat: outputs saved inside the loop via `saveAs` collide across
 * iterations (last write wins). Document loudly; for per-iteration data,
 * write into the page DOM and read all values back after the loop.
 */

import type { ExecutionContext, ForEachStep } from '../schema';
import { substituteRaw } from '../schema';
import { runStepArray } from '../interpreter';
import type { Page } from '../page';

export async function forEachAction(
  step: ForEachStep,
  ctx: ExecutionContext,
  page: Page,
) {
  const items = resolveItems(step.items, ctx);
  const prior = step.as in ctx.variables ? ctx.variables[step.as] : undefined;

  ctx.log(
    'info',
    `  forEach (${items.length} item${items.length === 1 ? '' : 's'}, as="${step.as}")`,
  );

  try {
    for (let i = 0; i < items.length; i++) {
      ctx.variables[step.as] = items[i];
      ctx.log('info', `  → Iteration ${i + 1}/${items.length}: ${step.as}="${items[i]}"`);
      await runStepArray(step.do, ctx, page, '    ');
    }
  } finally {
    // Restore the prior value (if any) or remove the variable entirely so
    // substitutions outside the loop don't see stale state. Runs in finally
    // so an exception mid-loop still cleans up.
    if (prior === undefined) {
      delete ctx.variables[step.as];
    } else {
      ctx.variables[step.as] = prior;
    }
  }
}

/** Resolve `items` (string with `{{var}}` + comma-split, or array) into a
 *  string[] for iteration. Empty entries (extra commas, leading/trailing)
 *  are trimmed away — a comma-separated string like " a , b ,, c " yields
 *  `["a", "b", "c"]`. */
function resolveItems(
  items: string | string[],
  ctx: ExecutionContext,
): string[] {
  if (Array.isArray(items)) return items.map((s) => String(s));
  const resolved = substituteRaw(items, ctx);
  return resolved
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
