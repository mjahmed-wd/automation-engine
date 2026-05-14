import type { DialogStep, ExecutionContext } from '../schema';
import { substituteRaw } from '../schema';
import type { Page } from '../page';

/**
 * Pre-arm the response for the next native dialog. This step itself does
 * NOT trigger a dialog — place it immediately before the step whose
 * click/navigation/etc. will cause one to appear.
 *
 *   { "action": "dialog", "accept": false }              // cancel the next confirm
 *   { "action": "click",  "xpath": "//button[.='Delete']" }
 *
 *   { "action": "dialog", "accept": true, "promptText": "Jubair" }
 *   { "action": "click",  "xpath": "//button[.='Set name']" }
 *
 * The default behavior (when no dialog step has been used) is auto-accept
 * with an empty prompt response, so scripts never hang on a stray
 * confirm() the user didn't expect.
 */
export async function dialogAction(step: DialogStep, ctx: ExecutionContext, page: Page) {
  const accept = step.accept !== false; // default true
  const promptText = step.promptText ? substituteRaw(step.promptText, ctx) : '';
  page.setNextDialogResponse(accept, promptText);
}
