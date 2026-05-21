/**
 * Pre-arm the response for the next native dialog (`alert()`, `confirm()`,
 * `prompt()`, `beforeunload`). This step does NOT itself trigger a dialog —
 * place it immediately before the step whose click/navigation/etc. will
 * cause one to appear.
 *
 * Default behavior when no `dialog` step has been used: every dialog is
 * auto-accepted with an empty prompt response, so scripts never hang on a
 * stray `confirm("Are you sure?")`. Use this step to override that for a
 * specific dialog — e.g., to test a "Cancel" path, or to supply a prompt
 * response.
 *
 * The arming is one-shot: after a dialog consumes the response, subsequent
 * dialogs go back to auto-accept until armed again.
 *
 *   { "action": "dialog", "accept": false },               // arm: cancel the next confirm
 *   { "action": "click",  "xpath": "//button[.='Delete']" } // triggers it
 *
 *   { "action": "dialog", "accept": true, "promptText": "Jubair" },
 *   { "action": "click",  "xpath": "//button[.='Set name']" }
 */

import type { BaseStep } from '../base';

export interface DialogStep extends BaseStep {
  action: 'dialog';
  /** Whether to click OK (true) or Cancel (false) on the next dialog. Default true. */
  accept?: boolean;
  /** Text to return from a prompt(). Ignored for alert/confirm. */
  promptText?: string;
}
