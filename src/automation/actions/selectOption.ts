import type { ExecutionContext, SelectOptionStep } from '../schema';
import { resolveLocator, substituteRaw } from '../schema';
import type { Page } from '../page';
import { withLocatorContext } from '../errors';

/**
 * Pick option(s) in a native `<select>`. Match by exactly one of `value` or
 * `label`. Either field can be a string (single) or an array (multi).
 *
 * For multi-select the semantics are "set to exactly these" — any option
 * whose value/label isn't in the list gets unselected. To add to an
 * existing selection, read the current values first via `get` and merge.
 *
 *   { "action": "selectOption", "xpath": "//select[@id='country']", "label": "Bangladesh" }
 *   { "action": "selectOption", "xpath": "//select[@multiple]", "value": ["{{red}}", "blue"] }
 */
export async function selectOptionAction(
  step: SelectOptionStep,
  ctx: ExecutionContext,
  page: Page,
) {
  if (!step.xpath) {
    throw new Error('selectOption: "xpath" is required.');
  }
  const hasValue = step.value !== undefined && step.value !== null;
  const hasLabel = step.label !== undefined && step.label !== null;
  if (hasValue === hasLabel) {
    throw new Error('selectOption: provide exactly one of "value" or "label".');
  }
  const raw = hasValue ? (step.value as string | string[]) : (step.label as string | string[]);
  const wants = Array.isArray(raw) ? raw : [raw];
  if (wants.length === 0) {
    throw new Error('selectOption: must provide at least one value/label.');
  }
  const resolved = wants.map((w) => substituteRaw(String(w), ctx));
  const locator = resolveLocator(step, ctx);
  await withLocatorContext(
    {
      action: step.action,
      original: step.xpath,
      resolved: locator.xpath,
      value: resolved.length === 1 ? resolved[0] : resolved.join(', '),
    },
    () =>
      page.selectOption(locator, resolved, {
        useLabel: hasLabel,
        pierceClosed: step.pierceClosed,
        timeoutMs: step.timeoutMs,
      }),
  );
}
