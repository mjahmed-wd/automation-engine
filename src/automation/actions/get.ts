import type { ExecutionContext, GetStep } from '../schema';
import { resolveLocator } from '../schema';
import type { Page } from '../page';
import { withLocatorContext } from '../errors';

export async function getAction(step: GetStep, ctx: ExecutionContext, page: Page) {
  const locator = resolveLocator(step, ctx);
  const result = await withLocatorContext(
    { action: step.action, original: step.xpath, resolved: locator.xpath },
    () =>
      page.get(locator, {
        attribute: step.attribute,
        property: step.property,
        regex: step.regex,
        regexFlags: step.regexFlags,
        pierceClosed: step.pierceClosed,
        timeoutMs: step.timeoutMs,
      }),
  );
  const value = result.value ?? '';
  if (step.saveAs) ctx.outputs[step.saveAs] = value;
  const shown = value === '' ? '(empty)' : `"${value}"`;
  const suffix = step.saveAs ? ` → ${step.saveAs}` : '';
  ctx.log('success', `Got ${shown}${suffix} from ${result.frame}`);
}
