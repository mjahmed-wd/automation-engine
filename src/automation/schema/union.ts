/**
 * Union type for all automation steps.
 *
 * Uses `WithRetry<T>` utility type to make retry support explicit in the union.
 * Steps that don't support retry (goto, wait, dialog, if, forEach) are included directly.
 * Steps that support retry are wrapped with `WithRetry<T>`.
 */

import type { BaseStep, RetryFields } from './base';
import type { GotoStep } from './steps/goto';
import type { FillStep } from './steps/fill';
import type { GetStep } from './steps/get';
import type { ClickStep } from './steps/click';
import type { WaitStep } from './steps/wait';
import type { WaitForStep } from './steps/waitFor';
import type { PressStep } from './steps/press';
import type { EvaluateStep } from './steps/evaluate';
import type { UploadStep } from './steps/upload';
import type { SelectOptionStep } from './steps/selectOption';
import type { HoverStep } from './steps/hover';
import type { DialogStep } from './steps/dialog';
import type { DescribeStep } from './steps/describe';
import type { TabStep } from './steps/tab';
import type { WaitForResponseStep } from './steps/waitForResponse';
import type { IfStep } from './steps/if';
import type { ForEachStep } from './steps/forEach';

/**
 * Utility type to add retry fields to a step type.
 * Makes it explicit which steps support retry in the union below.
 */
export type WithRetry<T extends BaseStep> = T & RetryFields;

export type AutomationStep =
  | GotoStep // no retry
  | WithRetry<FillStep>
  | WithRetry<GetStep>
  | WithRetry<ClickStep>
  | WaitStep // no retry
  | WithRetry<WaitForStep>
  | WithRetry<PressStep>
  | WithRetry<EvaluateStep>
  | WithRetry<UploadStep>
  | WithRetry<SelectOptionStep>
  | WithRetry<HoverStep>
  | DialogStep // no retry
  | WithRetry<DescribeStep>
  | WithRetry<TabStep>
  | WithRetry<WaitForResponseStep>
  | IfStep // no retry
  | ForEachStep; // no retry

/** Tag identifies which sidepanel tab a script's example belongs in. */
export type AutomationTag = 'action' | 'get';

export interface AutomationScript {
  name: string;
  description?: string;
  tag?: AutomationTag;
  variables?: Record<string, string>;
  steps: AutomationStep[];
}
