import type { EvaluateStep, ExecutionContext } from '../schema';
import { substituteRaw } from '../schema';
import type { Page } from '../page';

/**
 * Arbitrary JS escape hatch. Runs `step.expression` (with `{{var}}`
 * substitution applied) via `Runtime.evaluate` and optionally saves the
 * serialised result to `ctx.outputs[step.saveAs]`.
 *
 * Expressions are script-mode — they must evaluate to a single value, or be
 * wrapped in an IIFE if multiple statements are needed:
 *
 *   { "action": "evaluate", "expression": "document.title", "saveAs": "t" }
 *   { "action": "evaluate", "expression": "(() => { let n = 0; for (const r of document.querySelectorAll('tr')) n++; return n; })()", "saveAs": "rowCount" }
 *
 * `{{var}}` interpolation in the expression is raw text substitution — be
 * mindful of escaping if a saved output contains quotes.
 */
export async function evaluateAction(step: EvaluateStep, ctx: ExecutionContext, page: Page) {
  if (!step.expression || typeof step.expression !== 'string') {
    throw new Error('evaluate: "expression" is required and must be a string.');
  }
  const expression = substituteRaw(step.expression, ctx);
  const value = await page.evaluate(expression, { timeoutMs: step.timeoutMs });
  if (step.saveAs) ctx.outputs[step.saveAs] = value;
  // Keep log output bounded so a large JSON blob doesn't drown the panel.
  const preview =
    value === ''
      ? '(empty)'
      : value.length > 120
        ? `"${value.slice(0, 120)}…"`
        : `"${value}"`;
  const suffix = step.saveAs ? ` → ${step.saveAs}` : '';
  ctx.log('success', `Evaluated ${preview}${suffix}`);
}
