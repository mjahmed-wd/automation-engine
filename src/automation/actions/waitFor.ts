import type { WaitForStep } from '../schema';
import type { Page } from '../page';
import { defineAction } from './factory';

export const waitForAction = defineAction<'find', WaitForStep>({
  mode: 'find',
  buildLogMessage: () => `Element appeared`,
});
