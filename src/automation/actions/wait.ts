import type { ExecutionContext, WaitStep } from '../schema';

export async function waitAction(step: WaitStep, ctx: ExecutionContext) {
  ctx.log('info', `Waiting ${step.ms}ms…`);
  await new Promise<void>((r) => setTimeout(r, step.ms));
}
