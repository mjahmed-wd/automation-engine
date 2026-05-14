import type { ClickStep, ExecutionContext } from '../schema';
import { resolveLocator } from '../schema';
import type { Page } from '../page';
import { withLocatorContext } from '../errors';

export async function clickAction(step: ClickStep, ctx: ExecutionContext, page: Page) {
  const locator = resolveLocator(step, ctx);
  const result = await withLocatorContext(
    { action: step.action, original: step.xpath, resolved: locator.xpath },
    () => page.click(locator, { pierceClosed: step.pierceClosed, timeoutMs: step.timeoutMs }),
  );
  ctx.log('success', `Clicked ${result.tag ?? 'element'} in ${result.frame}`);
}
