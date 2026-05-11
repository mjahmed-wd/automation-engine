import type { ExecutionContext, GetStep } from '../schema';
import { resolveLocator } from '../schema';
import type { Page } from '../page';

export async function getAction(step: GetStep, ctx: ExecutionContext, page: Page) {
  const locator = resolveLocator(step, ctx);
  const result = await page.get(locator, {
    attribute: step.attribute,
    property: step.property,
    regex: step.regex,
    regexFlags: step.regexFlags,
  });
  const value = result.value ?? '';
  if (step.saveAs) ctx.outputs[step.saveAs] = value;
  const shown = value === '' ? '(empty)' : `"${value}"`;
  const suffix = step.saveAs ? ` → ${step.saveAs}` : '';
  ctx.log('success', `Got ${shown}${suffix} from ${result.frame}`);
}
