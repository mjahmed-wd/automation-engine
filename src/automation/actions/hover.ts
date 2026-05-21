import type { HoverStep } from '../schema';
import type { Page } from '../page';
import { defineAction } from './factory';

/**
 * Hover over an element. Used as a precondition for "hover reveals
 * button, then click it" flows. The trusted path triggers CSS `:hover`
 * natively; the iframe fallback fires JS hover handlers only.
 *
 *   { "action": "hover",  "xpath": "//div[@class='row'][1]" }
 *   { "action": "click",  "xpath": "//div[@class='row'][1]//button[normalize-space(.)='Edit']" }
 */
export const hoverAction = defineAction<'hover', HoverStep>({
  mode: 'hover',
  buildLogMessage: (result) => `Hovered ${result.tag ?? 'element'} in ${result.frame}`,
});
