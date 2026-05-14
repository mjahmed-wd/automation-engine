import type { ExecutionContext, WaitForStep } from '../schema';
import { resolveLocator } from '../schema';
import type { Page } from '../page';
import { withLocatorContext } from '../errors';

export async function waitForAction(step: WaitForStep, ctx: ExecutionContext, page: Page) {
  const locator = resolveLocator(step, ctx);
  const result = await withLocatorContext(
    { action: step.action, original: step.xpath, resolved: locator.xpath },
    () =>
      page.waitFor(locator, {
        timeoutMs: step.timeoutMs,
        pierceClosed: step.pierceClosed,
      }),
  );
  ctx.log('success', `Element appeared in ${result.frame}`);
}
