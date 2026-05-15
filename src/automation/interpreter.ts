/**
 * Interpreter — walks an AutomationScript and dispatches each step
 * through the action registry. Wraps each step in `runStepWithRetry` so the
 * Batch 2 retry policy (`retries` / `retryDelay` on locator-using steps)
 * applies uniformly without each action handler having to think about it.
 */

import type { AutomationScript, AutomationStep, ExecutionContext } from './schema';
import { FatalActionError, type FatalReason } from './page';
import type { Page } from './page';
import { resolveAction, type ActionHandler } from './actions';

/**
 * Which `FatalActionError` reasons trigger a retry. Stable states won't fix
 * themselves and shouldn't waste budget; `'covered'` is transient (toast
 * banners, loading scrims) and benefits from a retry after the overlay
 * self-dismisses. Anything not in this set short-circuits past the retry
 * loop and surfaces immediately to the caller.
 */
const RETRYABLE_FATAL_REASONS = new Set<FatalReason>(['covered']);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run `handler(step, ctx, page)` with the retry policy from `step.retries` /
 * `step.retryDelay`. Defaults: 0 retries, 500ms delay between attempts.
 *
 * Retry decision tree:
 *   - Success on any attempt → return; log "succeeded on retry N" when N > 0.
 *   - `FatalActionError` with non-retryable reason (disabled / read-only /
 *     no-match / not-a-select / unknown) → throw immediately, no retry.
 *   - `FatalActionError` with retryable reason (covered) → retry up to `max`.
 *   - Any other error → retry up to `max`.
 *
 * Worst-case wall-clock time per step ≈ (max + 1) × timeoutMs + max × delay.
 * The validator caps `retries` at 5 to keep that bound reasonable.
 */
export async function runStepWithRetry(
  step: AutomationStep,
  ctx: ExecutionContext,
  page: Page,
  handler: ActionHandler,
): Promise<void> {
  // Cast through `any` because not every step type carries retry fields
  // (e.g., `wait`, `goto`, `dialog`). The validator already rejected typo'd
  // retry/retryDelay on those, so reading undefined here is safe.
  const s = step as any;
  const max = typeof s.retries === 'number' ? s.retries : 0;
  const delay = typeof s.retryDelay === 'number' ? s.retryDelay : 500;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= max; attempt++) {
    try {
      await handler(step, ctx, page);
      if (attempt > 0) {
        ctx.log(
          'success',
          `Step ${step.action} succeeded on retry ${attempt}/${max}.`,
        );
      }
      return;
    } catch (err) {
      lastErr = err;
      // Fatal-and-non-retryable: don't waste budget, surface immediately.
      if (
        err instanceof FatalActionError &&
        !RETRYABLE_FATAL_REASONS.has(err.reason)
      ) {
        throw err;
      }
      const willRetry = attempt < max;
      if (willRetry) {
        const msg = (err as any)?.message ?? String(err);
        ctx.log(
          'info',
          `Attempt ${attempt + 1}/${max + 1} failed: ${msg}. Retrying in ${delay}ms…`,
        );
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

export async function runScript(
  script: AutomationScript,
  ctx: ExecutionContext,
  page: Page,
): Promise<ExecutionContext> {
  // Seed variables: defaults from the script unless the runtime already set them.
  for (const [k, v] of Object.entries(script.variables ?? {})) {
    if (!(k in ctx.variables)) ctx.variables[k] = v;
  }

  ctx.log(
    'info',
    `Running "${script.name}" (${script.steps.length} step${script.steps.length === 1 ? '' : 's'})…`,
  );

  for (let i = 0; i < script.steps.length; i++) {
    const step = script.steps[i];
    const handler = resolveAction(step.action);
    if (!handler) {
      throw new Error(`Unknown action "${step.action}" at step ${i + 1}`);
    }
    ctx.log('info', `→ Step ${i + 1}/${script.steps.length}: ${step.action}`);
    await runStepWithRetry(step, ctx, page, handler);
  }

  ctx.log('success', `Finished "${script.name}".`);
  return ctx;
}
