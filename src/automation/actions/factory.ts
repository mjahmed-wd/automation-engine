/**
 * Action factory — reduces boilerplate in simple action handlers.
 *
 * Captures the common pattern: resolveLocator → page.executeAction → ctx.log
 *
 * Usage:
 *   export const clickAction = defineAction<ClickStep>({
 *     mode: 'click',
 *     buildLogMessage: (result) => `Clicked ${result.tag ?? 'element'}`,
 *   });
 */

import type { Page } from '../page';
import type { ExecutionContext, BaseStep } from '../schema';
import { resolveLocator } from '../schema';
import type { ActionDescriptor, ActionResult } from '../action-descriptor';
import type { Mode } from '../locator';

/** Step constraint: actions using this factory must have xpath. */
type LocatorStep = BaseStep & { xpath?: string };

export interface ActionConfig<M extends Mode, S extends LocatorStep> {
  /** Execution mode — maps to buildActionExpression mode parameter. */
  mode: M;
  /** Build success log message from result and step. */
  buildLogMessage: (result: ActionResult, step: S) => string;
  /** Optionally build opts object (e.g., { value } for fill). */
  buildOpts?: (step: S, ctx: ExecutionContext) => Record<string, unknown>;
}

/**
 * Create an action handler from a config object.
 *
 * @example
 * export const fillAction = defineAction<FillStep>({
 *   mode: 'fill',
 *   buildOpts: (step, ctx) => ({ value: substitute(step.value, ctx) }),
 *   buildLogMessage: (result) => `Filled "${result.value}" in ${result.frame}`,
 * });
 */
export function defineAction<M extends Mode, S extends LocatorStep>(
  config: ActionConfig<M, S>,
) {
  return async function action(
    step: S,
    ctx: ExecutionContext,
    page: Page,
  ): Promise<void> {
    const locator = resolveLocator(step, ctx);
    const opts = config.buildOpts?.(step, ctx);

    const result = await page.executeAction({
      name: step.action,
      mode: config.mode,
      locator,
      originalXPath: step.xpath ?? '',
      timeoutMs: (step as { timeoutMs?: number }).timeoutMs,
      pierceClosed: (step as { pierceClosed?: boolean }).pierceClosed,
      opts,
    });

    ctx.log('success', config.buildLogMessage(result, step));
  };
}
