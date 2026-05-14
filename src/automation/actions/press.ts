import type { ExecutionContext, Locator, PressStep } from '../schema';
import { substituteXPath } from '../schema';
import type { Page } from '../page';

export async function pressAction(step: PressStep, ctx: ExecutionContext, page: Page) {
  const locator: Locator | null = step.xpath
    ? { xpath: substituteXPath(step.xpath, ctx) }
    : null;
  if (!step.key) {
    throw new Error('press: "key" is required (e.g. "Enter").');
  }
  await page.press(locator, step.key, { pierceClosed: step.pierceClosed });
}
