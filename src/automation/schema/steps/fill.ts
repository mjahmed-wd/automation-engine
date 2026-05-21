import type { BaseStep, RetryFields } from '../base';

export interface FillStep extends BaseStep, RetryFields {
  action: 'fill';
  xpath: string;
  value: string;
  /** Skip the Runtime.evaluate fast path and go straight to the CDP DOM walk
   *  (needed for elements inside `attachShadow({mode:'closed'})` roots). */
  pierceClosed?: boolean;
  /** Cap how long the locator-search loop polls before failing. Default 20s. */
  timeoutMs?: number;
}
