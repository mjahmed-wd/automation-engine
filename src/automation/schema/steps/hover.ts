/**
 * Hover over an element. Used as a precondition for "hover-reveals-button →
 * click button" flows (Bootstrap dropdowns, table-row action menus, tooltip
 * triggers).
 *
 * Two paths internally:
 *   - **Trusted** (main frame OR closed-shadow CDP): one
 *     `Input.dispatchMouseEvent({type:'mouseMoved'})`. CSS `:hover` fires
 *     natively, plus all the pointer/mouse events. **Preferred.**
 *   - **Synthetic** (iframe-resolved targets where viewport coords don't
 *     map cleanly): in-page dispatch of `pointerover/pointerenter/mouseover/
 *     mouseenter/pointermove/mousemove`. JS hover handlers fire; CSS
 *     `:hover` does NOT.
 *
 *   { "action": "hover", "xpath": "//div[@class='row']" }
 */

import type { BaseStep, RetryFields } from '../base';

export interface HoverStep extends BaseStep, RetryFields {
  action: 'hover';
  xpath: string;
  pierceClosed?: boolean;
  /** How long the search loop polls before failing. Default 20s. */
  timeoutMs?: number;
}
