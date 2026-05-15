/**
 * `waitForResponse` action — block until the engine sees a
 * `Network.responseReceived` event matching the supplied filters, then
 * optionally read the response body. See WaitForResponseStep in schema.ts
 * for the full field reference.
 *
 * No locator, so we don't wrap in `withLocatorContext`. The error messages
 * from `EventWaiter.await` and `fetchResponseBody` are descriptive enough
 * on their own ("Timed out after Ns waiting for network response (URL
 * matching '/api/save/', status 200)").
 */

import type { ExecutionContext, WaitForResponseStep } from '../schema';
import { substituteRaw } from '../schema';
import type { Page } from '../page';

export async function waitForResponseAction(
  step: WaitForResponseStep,
  ctx: ExecutionContext,
  page: Page,
) {
  const urlMatches = substituteRaw(step.urlMatches, ctx);
  const matched = await page.waitForResponse({
    urlMatches,
    status: step.status,
    method: step.method,
    timeoutMs: step.timeoutMs,
    saveBody: !!step.saveBody,
  });

  if (step.saveUrl) ctx.outputs[step.saveUrl] = matched.url;
  if (step.saveStatus) ctx.outputs[step.saveStatus] = String(matched.status);
  if (step.saveBody && matched.body !== undefined) {
    ctx.outputs[step.saveBody] = matched.body;
  }

  const bodyNote =
    step.saveBody && matched.body !== undefined
      ? ` (${matched.body.length} bytes saved → ${step.saveBody})`
      : '';
  ctx.log(
    'success',
    `Got response ${matched.status} ${matched.method || '?'} ${matched.url}${bodyNote}`,
  );
}
