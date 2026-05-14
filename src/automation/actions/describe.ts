import type { DescribeStep, ExecutionContext } from '../schema';
import { resolveLocator } from '../schema';
import type { Page } from '../page';
import { withLocatorContext } from '../errors';

/**
 * Side-effect-free diagnostic. Returns matchCount + metadata for the first 5
 * matches as JSON in `ctx.outputs[saveAs]`, plus a tight one-line summary in
 * the panel log. Useful for debugging an xpath without running a real action
 * against it.
 *
 *   { "action": "describe", "xpath": "//button", "saveAs": "buttons" }
 *   { "action": "describe", "xpath": "//*[@data-test-id='row-0']", "pierceClosed": true }
 *
 * `matchCount: 0` is a valid result — not a failure — so the action doesn't
 * throw on no-match. Wraps via withLocatorContext only to give xpath-syntax
 * errors the Phase 4 Batch 1 treatment.
 */
export async function describeAction(step: DescribeStep, ctx: ExecutionContext, page: Page) {
  if (!step.xpath) {
    throw new Error('describe: "xpath" is required.');
  }
  const locator = resolveLocator(step, ctx);
  const result = await withLocatorContext(
    { action: step.action, original: step.xpath, resolved: locator.xpath },
    () => page.describe(locator, { pierceClosed: step.pierceClosed }),
  );
  if (step.saveAs) ctx.outputs[step.saveAs] = JSON.stringify(result);

  // Tight summary: matchCount + first match's selector-ish descriptor + text snippet.
  // Full JSON is in saveAs for anyone who needs the structured data.
  const first = result.matches[0];
  let summary = `matchCount: ${result.matchCount}`;
  if (first) {
    const cls =
      first.classes.length > 0
        ? '.' + first.classes.slice(0, 2).join('.')
        : '';
    const idPart = first.id ? '#' + first.id : '';
    summary += `, first: <${first.tag.toLowerCase()}${idPart}${cls}>`;
    if (first.text) summary += ` — "${first.text}"`;
  }
  const suffix = step.saveAs ? ` → ${step.saveAs}` : '';
  ctx.log('success', `Described ${summary}${suffix}`);
}
