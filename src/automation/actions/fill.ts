import type { FillStep } from '../schema';
import { substitute } from '../schema';
import type { Page } from '../page';
import { defineAction } from './factory';

export const fillAction = defineAction<'fill', FillStep>({
  mode: 'fill',
  buildOpts: (step, ctx) => ({ value: substitute(step.value, ctx) }),
  buildLogMessage: (result) => `Filled "${result.value}" in ${result.frame}`,
});
