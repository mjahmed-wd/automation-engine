import type { ExecutionContext, GotoStep } from '../schema';
import { substitute } from '../schema';
import type { Page } from '../page';

export async function gotoAction(step: GotoStep, ctx: ExecutionContext, page: Page) {
  const url = substitute(step.url, ctx);
  await page.goto(url);
  ctx.log('success', `Navigated to ${url}`);
}
