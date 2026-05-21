import type { BaseStep } from '../base';

export interface WaitStep extends BaseStep {
  action: 'wait';
  ms: number;
}
