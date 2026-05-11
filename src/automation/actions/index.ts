/**
 * Action registry — maps the `action` string from a step to its handler.
 *
 * Add a new action by creating a sibling file and registering it here.
 */

import type { AutomationStep, ExecutionContext } from '../schema';
import type { Page } from '../page';

import { gotoAction } from './goto';
import { fillAction } from './fill';
import { getAction } from './get';
import { clickAction } from './click';
import { waitAction } from './wait';
import { waitForAction } from './waitFor';

export type ActionHandler = (
  step: any,
  ctx: ExecutionContext,
  page: Page,
) => Promise<void>;

export const actions: Record<AutomationStep['action'], ActionHandler> = {
  goto: gotoAction,
  fill: fillAction,
  get: getAction,
  click: clickAction,
  wait: waitAction,
  waitFor: waitForAction,
};

export function resolveAction(name: string): ActionHandler | undefined {
  return actions[name as keyof typeof actions];
}
