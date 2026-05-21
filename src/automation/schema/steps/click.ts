import type { BaseStep, RetryFields } from '../base';

export interface ClickStep extends BaseStep, RetryFields {
  action: 'click';
  xpath: string;
  pierceClosed?: boolean;
  /** Cap how long the locator-search loop polls before failing. Default 20s. */
  timeoutMs?: number;
}
