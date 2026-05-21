import type { ExecutionContext, GetStep } from '../schema';
import { resolveLocator } from '../schema';
import type { Page } from '../page';

export async function getAction(step: GetStep, ctx: ExecutionContext, page: Page) {
  const locator = resolveLocator(step, ctx);
  const result = await page.executeAction({
    name: step.action,
    mode: 'get',
    locator,
    originalXPath: step.xpath,
    opts: {
      attribute: step.attribute,
      property: step.property,
      regex: step.regex,
      regexFlags: step.regexFlags,
    },
    timeoutMs: step.timeoutMs,
    pierceClosed: step.pierceClosed,
  });
  const value = result.value ?? '';
  if (step.saveAs) ctx.outputs[step.saveAs] = value;
  const shown = value === '' ? '(empty)' : `"${value}"`;
  const suffix = step.saveAs ? ` → ${step.saveAs}` : '';
  ctx.log('success', `Got ${shown}${suffix} from ${result.frame}`);
}
