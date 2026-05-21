/**
 * Conditional branching (Batch 4). `xpathExists` is checked against the
 * current page; if it matches, the `then` step array runs, otherwise `else`
 * (if present) runs. Empty / missing `else` is a no-op on the else path.
 *
 * Timing — required, no defaults:
 *   - `timeoutMs: N`     — poll the page for up to N ms looking for the
 *                          xpath. Reliable but pays the wait on the else path.
 *   - `wait: false`      — instant DOM check, no polling. Cheap but flaky
 *                          if the element renders asynchronously.
 *
 * The validator rejects an `if` step that has neither. Forcing the choice
 * keeps scripts self-documenting (you can read the intent from the spec)
 * and avoids surprising default behavior.
 *
 *   { "action": "if", "xpathExists": "//div[@class='error-banner']",
 *     "timeoutMs": 1000,
 *     "then": [ { "action": "click", "xpath": "//button[.='Retry']" } ],
 *     "else": [ { "action": "wait", "ms": 100 } ] }
 *
 * `then` and `else` can contain any AutomationStep, including more `if`
 * and `forEach` — the interpreter's runStepArray is recursive. The
 * validator caps nesting at 20 levels deep to catch buggy generators.
 */

import type { BaseStep } from '../base';
import type { AutomationStep } from '../union';

export interface IfStep extends BaseStep {
  action: 'if';
  xpathExists: string;
  /** Poll the page for the xpath for up to this many ms. Required unless
   *  `wait: false` is set. */
  timeoutMs?: number;
  /** Instant DOM check, no polling. Required unless `timeoutMs` is set. */
  wait?: false;
  then: AutomationStep[];
  else?: AutomationStep[];
}
