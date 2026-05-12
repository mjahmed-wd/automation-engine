import type { ExecutionContext, WaitForStep } from '../schema';
import { resolveLocator } from '../schema';
import type { Page } from '../page';

export async function waitForAction(step: WaitForStep, ctx: ExecutionContext, page: Page) {
  const locator = resolveLocator(step, ctx);
  const result = await page.waitFor(locator, {
    timeoutMs: step.timeoutMs,
    pierceClosed: step.pierceClosed,
  });
  ctx.log('success', `Element appeared in ${result.frame}`);
}
