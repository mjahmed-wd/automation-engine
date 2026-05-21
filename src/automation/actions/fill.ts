import type { ExecutionContext, FillStep } from '../schema';
import { resolveLocator, substitute } from '../schema';
import type { Page } from '../page';

export async function fillAction(step: FillStep, ctx: ExecutionContext, page: Page) {
  const locator = resolveLocator(step, ctx);
  const value = substitute(step.value, ctx);
  const result = await page.executeAction({
    name: step.action,
    mode: 'fill',
    locator,
    originalXPath: step.xpath,
    opts: { value },
    timeoutMs: step.timeoutMs,
    pierceClosed: step.pierceClosed,
  });
  ctx.log('success', `Filled "${result.value}" in ${result.frame}`);
}
