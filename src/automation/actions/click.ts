import type { ClickStep, ExecutionContext } from '../schema';
import { resolveLocator } from '../schema';
import type { Page } from '../page';

export async function clickAction(step: ClickStep, ctx: ExecutionContext, page: Page) {
  const locator = resolveLocator(step, ctx);
  const result = await page.click(locator, { pierceClosed: step.pierceClosed });
  ctx.log('success', `Clicked ${result.tag ?? 'element'} in ${result.frame}`);
}
