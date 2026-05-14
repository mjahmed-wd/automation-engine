import type { ExecutionContext, HoverStep } from '../schema';
import { resolveLocator } from '../schema';
import type { Page } from '../page';
import { withLocatorContext } from '../errors';

/**
 * Hover over an element. Used as a precondition for "hover reveals
 * button, then click it" flows. The trusted path triggers CSS `:hover`
 * natively; the iframe fallback fires JS hover handlers only.
 *
 *   { "action": "hover",  "xpath": "//div[@class='row'][1]" }
 *   { "action": "click",  "xpath": "//div[@class='row'][1]//button[normalize-space(.)='Edit']" }
 */
export async function hoverAction(step: HoverStep, ctx: ExecutionContext, page: Page) {
  const locator = resolveLocator(step, ctx);
  const result = await withLocatorContext(
    { action: step.action, original: step.xpath, resolved: locator.xpath },
    () => page.hover(locator, { pierceClosed: step.pierceClosed, timeoutMs: step.timeoutMs }),
  );
  ctx.log('success', `Hovered ${result.tag ?? 'element'} in ${result.frame}`);
}
