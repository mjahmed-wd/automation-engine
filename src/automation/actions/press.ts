import type { ExecutionContext, Locator, PressStep } from '../schema';
import { substituteXPath } from '../schema';
import type { Page } from '../page';
import { withLocatorContext } from '../errors';

export async function pressAction(step: PressStep, ctx: ExecutionContext, page: Page) {
  const locator: Locator | null = step.xpath
    ? { xpath: substituteXPath(step.xpath, ctx) }
    : null;
  if (!step.key) {
    throw new Error('press: "key" is required (e.g. "Enter").');
  }
  // press.xpath is optional — when present, the input is focused first. We
  // pass the action context through so a focus-target miss surfaces with the
  // original template, but the key itself is included as "value" so the
  // error reads "Failed to press //input[...] → \"Enter\": ...".
  await withLocatorContext(
    {
      action: step.action,
      original: step.xpath,
      resolved: locator?.xpath ?? '(no xpath)',
      value: step.key,
    },
    () => page.press(locator, step.key, { pierceClosed: step.pierceClosed }),
  );
}
