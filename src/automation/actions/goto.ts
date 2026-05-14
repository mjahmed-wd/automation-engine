import type { ExecutionContext, GotoStep } from '../schema';
import { substituteRaw, substituteXPath } from '../schema';
import type { Page } from '../page';

export async function gotoAction(step: GotoStep, ctx: ExecutionContext, page: Page) {
  const url = substituteRaw(step.url, ctx);
  // XPath-safe substitution for waitForXPath (handles quote-containing values
  // via concat() escaping) — matches how every other locator-using action
  // interpolates variables.
  const waitForXPath = step.waitForXPath
    ? substituteXPath(step.waitForXPath, ctx)
    : undefined;
  await page.goto(url, {
    waitForXPath,
    waitForTimeoutMs: step.waitForTimeoutMs,
  });
  ctx.log('success', `Navigated to ${url}`);
}
