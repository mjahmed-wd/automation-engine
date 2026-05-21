import type { BaseStep, RetryFields } from '../base';

export interface WaitForStep extends BaseStep, RetryFields {
  action: 'waitFor';
  xpath: string;
  timeoutMs?: number;
  pierceClosed?: boolean;
}
