/**
 * Interpreter — walks an AutomationScript and dispatches each step
 * through the action registry.
 */

import type { AutomationScript, ExecutionContext } from './schema';
import type { Page } from './page';
import { resolveAction } from './actions';

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
    await handler(step, ctx, page);
  }

  ctx.log('success', `Finished "${script.name}".`);
  return ctx;
}
