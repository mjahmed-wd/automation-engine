import type { ExecutionContext, FillStep } from '../schema';
import { resolveLocator, substitute } from '../schema';
import type { Page } from '../page';
import { withLocatorContext } from '../errors';

export async function fillAction(step: FillStep, ctx: ExecutionContext, page: Page) {
  const locator = resolveLocator(step, ctx);
  const value = substitute(step.value, ctx);
  const result = await withLocatorContext(
    { action: step.action, original: step.xpath, resolved: locator.xpath, value },
    () => page.fill(locator, value, { pierceClosed: step.pierceClosed, timeoutMs: step.timeoutMs }),
  );
  ctx.log('success', `Filled "${result.value}" in ${result.frame}`);
}
