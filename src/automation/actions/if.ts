/**
 * `if` action — branching on whether an XPath matches the page.
 *
 * Timing semantics (set at parse time, validator enforces):
 *   - `timeoutMs: N`     poll the page for up to N ms looking for the xpath
 *   - `wait: false`      instant DOM check, no polling
 *
 * On match → run `step.then` via `runStepArray`. On miss (timeout or
 * instant negative) → run `step.else` if present, else no-op.
 *
 * Implementation note: we reuse `page.waitFor` for the polling path and a
 * direct `Runtime.evaluate` for the instant path. The instant path
 * intentionally swallows errors so a bad xpath doesn't blow up the script
 * — it's treated as "doesn't match", which matches the user's likely
 * intent better than a hard fail.
 */

import type { ExecutionContext, IfStep } from '../schema';
import { substituteXPath } from '../schema';
import { runStepArray } from '../interpreter';
import type { Page } from '../page';

export async function ifAction(step: IfStep, ctx: ExecutionContext, page: Page) {
  const xpath = substituteXPath(step.xpathExists, ctx);

  let matched = false;
  if (step.wait === false) {
    // Instant DOM check via Runtime.evaluate — main frame only for v1.
    // (Same scope as the `evaluate` action; if a user needs same-origin
    // iframe checks they can reach across in their xpath via
    // `(//iframe//...)` once the engine resolves through frames.)
    // Returns the string "true" or "false" because evaluate serializes.
    const expr =
      `(() => { try { const r = document.evaluate(` +
      JSON.stringify(xpath) +
      `, document, null, 9, null); return !!(r && r.singleNodeValue); }` +
      ` catch (e) { return false; } })()`;
    const out = await page.evaluate(expr).catch(() => 'false');
    matched = out === 'true';
  } else {
    // Poll for the xpath up to the supplied timeoutMs. waitFor throws on
    // miss; we map that to matched=false. Re-throw "Bad XPath" because
    // that's a script bug, not a missing element.
    try {
      await page.waitFor({ xpath }, { timeoutMs: step.timeoutMs });
      matched = true;
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (msg.startsWith('Bad XPath')) throw err;
      matched = false;
    }
  }

  const branch = matched ? step.then : step.else;
  ctx.log(
    'info',
    `  if (${xpath}) → ${matched ? 'then' : 'else'}` +
      (branch ? ` (${branch.length} step${branch.length === 1 ? '' : 's'})` : ' (no-op)'),
  );
  if (branch && branch.length > 0) {
    await runStepArray(branch, ctx, page, '  ');
  }
}
