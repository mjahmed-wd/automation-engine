import type { ClickStep } from '../schema';
import type { Page } from '../page';
import { defineAction } from './factory';

export const clickAction = defineAction<'click', ClickStep>({
  mode: 'click',
  buildLogMessage: (result) => `Clicked ${result.tag ?? 'element'} in ${result.frame}`,
});
