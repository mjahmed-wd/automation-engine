/**
 * Error helpers shared by action handlers.
 *
 * The big-picture problem: when a locator misses, the underlying `runUntilFound`
 * throws `Locator not found within Ns`. That's accurate but useless — the user
 * sees no action verb, no original `{{var}}` template, no resolved value, no
 * resolved xpath. Wrapping at the action-handler boundary lets us add that
 * context without polluting the page-level code with knowledge it doesn't need.
 *
 * FatalActionError messages (Phase 1's disabled / readonly / covered rejections)
 * are already self-describing — we pass those through unchanged so the wrapping
 * doesn't double-stamp the action verb.
 */

import { FatalActionError } from './page';

export interface LocatorContext {
  /** Verb from step.action, e.g. "fill", "click". */
  action: string;
  /** The xpath the user wrote — possibly containing `{{var}}` templates.
   *  Omit (or pass undefined) for actions where the user supplied no xpath. */
  original: string | undefined;
  /** The xpath after substituteXPath ran. May equal `original` if no vars. */
  resolved: string;
  /** The value the action was trying to use (fill value, etc.). Omitted from
   *  the message when undefined. */
  value?: unknown;
}

/**
 * Run `fn` and, if it throws anything other than FatalActionError, re-throw
 * a new Error whose message includes the step context.
 *
 *   Failed to fill //input[@name='{{field}}'] → "Md. jubair": Locator not found within 20s
 *     resolved xpath: //input[@name='firstName']
 *
 * The `resolved xpath:` line is only added when the template differs from the
 * resolved string — keeps the message clean for variable-free xpaths.
 */
export async function withLocatorContext<T>(
  ctx: LocatorContext,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    // Phase 1's FatalActionErrors already say "Cannot fill X: it is disabled"
    // etc. — don't wrap and double-stamp the action verb.
    if (err instanceof FatalActionError) throw err;

    const target = ctx.original ?? '(no xpath)';
    const valuePart =
      ctx.value !== undefined ? ` → ${JSON.stringify(String(ctx.value))}` : '';
    const tail =
      ctx.original && ctx.original !== ctx.resolved
        ? `\n  resolved xpath: ${ctx.resolved}`
        : '';
    const baseMessage = err?.message ?? String(err);

    throw new Error(
      `Failed to ${ctx.action} ${target}${valuePart}: ${baseMessage}${tail}`,
    );
  }
}
