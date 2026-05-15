/**
 * Unit tests for `runStepWithRetry` (Phase 5 Batch 2).
 *
 * These mock the action handler and `Page` so we can drive the retry loop
 * deterministically without spinning up a browser. The key invariants
 * pinned here are:
 *   - retries=0 (default) means single attempt, no loop.
 *   - retries=N means up to N+1 total attempts.
 *   - FatalActionError with retryable reason (covered) DOES retry.
 *   - FatalActionError with non-retryable reason (disabled, read-only,
 *     no-match, not-a-select, unknown) DOES NOT retry.
 *   - Sleep between attempts is honored via retryDelay.
 *   - Successful attempt after failures logs the retry success.
 */

import { describe, expect, it, vi } from 'vitest';
import { runStepWithRetry } from './interpreter';
import { FatalActionError } from './page';
import type { AutomationStep, ExecutionContext, LogLevel } from './schema';
import type { Page } from './page';

const makeCtx = (): ExecutionContext & { logs: Array<[string, string]> } => {
  const logs: Array<[string, string]> = [];
  return {
    variables: {},
    outputs: {},
    log: (level: LogLevel, message: string) => logs.push([level, message]),
    logs,
  } as any;
};

// Page is opaque to runStepWithRetry; the handler closes over whatever it
// needs. A bare cast works because no field is accessed.
const fakePage = {} as Page;

const stepClick = (extra: Record<string, unknown> = {}): AutomationStep =>
  ({ action: 'click', xpath: '//x', ...extra }) as any;

describe('runStepWithRetry', () => {
  it('runs once when retries is unset', async () => {
    const handler = vi.fn().mockResolvedValueOnce(undefined);
    const ctx = makeCtx();
    await runStepWithRetry(stepClick(), ctx, fakePage, handler);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('runs once when retries: 0', async () => {
    const handler = vi.fn().mockResolvedValueOnce(undefined);
    const ctx = makeCtx();
    await runStepWithRetry(stepClick({ retries: 0 }), ctx, fakePage, handler);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('retries up to N+1 times on non-fatal error then surfaces last error', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('Locator not found'));
    const ctx = makeCtx();
    await expect(
      runStepWithRetry(
        stepClick({ retries: 2, retryDelay: 0 }),
        ctx,
        fakePage,
        handler,
      ),
    ).rejects.toThrow(/Locator not found/);
    expect(handler).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('succeeds on retry and logs the retry success', async () => {
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new Error('flake 1'))
      .mockRejectedValueOnce(new Error('flake 2'))
      .mockResolvedValueOnce(undefined);
    const ctx = makeCtx();
    await runStepWithRetry(
      stepClick({ retries: 3, retryDelay: 0 }),
      ctx,
      fakePage,
      handler,
    );
    expect(handler).toHaveBeenCalledTimes(3); // initial + 2 retries before success
    // The success log should mention the retry count.
    const successLogs = ctx.logs.filter(([level]) => level === 'success');
    expect(successLogs.some(([, msg]) => /succeeded on retry 2\/3/.test(msg))).toBe(true);
  });

  it('does NOT retry a FatalActionError with reason "disabled"', async () => {
    const handler = vi
      .fn()
      .mockRejectedValue(
        new FatalActionError('Cannot fill: it is disabled', 'disabled'),
      );
    const ctx = makeCtx();
    await expect(
      runStepWithRetry(
        stepClick({ retries: 5, retryDelay: 0 }),
        ctx,
        fakePage,
        handler,
      ),
    ).rejects.toThrow(/disabled/);
    expect(handler).toHaveBeenCalledTimes(1); // no retries on fatal/disabled
  });

  it('does NOT retry a FatalActionError with reason "read-only"', async () => {
    const handler = vi
      .fn()
      .mockRejectedValue(
        new FatalActionError('Cannot fill: it is read-only', 'read-only'),
      );
    const ctx = makeCtx();
    await expect(
      runStepWithRetry(
        stepClick({ retries: 3, retryDelay: 0 }),
        ctx,
        fakePage,
        handler,
      ),
    ).rejects.toThrow();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a FatalActionError with reason "no-match"', async () => {
    const handler = vi
      .fn()
      .mockRejectedValue(
        new FatalActionError('selectOption: no option matched', 'no-match'),
      );
    const ctx = makeCtx();
    await expect(
      runStepWithRetry(
        stepClick({ retries: 3, retryDelay: 0 }),
        ctx,
        fakePage,
        handler,
      ),
    ).rejects.toThrow();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('DOES retry a FatalActionError with reason "covered" (transient overlay)', async () => {
    const handler = vi
      .fn()
      .mockRejectedValueOnce(
        new FatalActionError('Cannot click: covered by <div>', 'covered'),
      )
      .mockResolvedValueOnce(undefined);
    const ctx = makeCtx();
    await runStepWithRetry(
      stepClick({ retries: 3, retryDelay: 0 }),
      ctx,
      fakePage,
      handler,
    );
    expect(handler).toHaveBeenCalledTimes(2); // covered → retry → success
  });

  it('logs the attempt count and delay in the retry message', async () => {
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new Error('first fail'))
      .mockResolvedValueOnce(undefined);
    const ctx = makeCtx();
    await runStepWithRetry(
      stepClick({ retries: 2, retryDelay: 250 }),
      ctx,
      fakePage,
      handler,
    );
    const infoLogs = ctx.logs.filter(([level]) => level === 'info');
    expect(
      infoLogs.some(([, msg]) => /Attempt 1\/3 failed.*Retrying in 250ms/.test(msg)),
    ).toBe(true);
  });
});
