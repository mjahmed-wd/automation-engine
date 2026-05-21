import { describe, it, expect, vi } from 'vitest';
import { defineAction } from './factory';
import type { Mode } from '../locator';

describe('defineAction', () => {
  it('creates action that calls page.executeAction with correct params', async () => {
    const mockPage = { executeAction: vi.fn().mockResolvedValue({ frame: 'test', tag: 'button' }) };
    const mockCtx = { log: vi.fn(), variables: {}, outputs: {} };
    const mockStep = { action: 'test', xpath: '//button' };

    const action = defineAction<'click', typeof mockStep>({
      mode: 'click',
      buildLogMessage: () => 'done',
    });

    await action(mockStep, mockCtx, mockPage as any);

    expect(mockPage.executeAction).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'click' })
    );
    expect(mockCtx.log).toHaveBeenCalledWith('success', 'done');
  });

  it('passes opts from buildOpts to executeAction', async () => {
    const mockPage = { executeAction: vi.fn().mockResolvedValue({ frame: 'test', value: 'hello' }) };
    const mockCtx = { log: vi.fn(), variables: {}, outputs: {} };
    const mockStep = { action: 'fill', xpath: '//input', value: 'hello' };

    const action = defineAction<'fill', typeof mockStep>({
      mode: 'fill',
      buildOpts: (step) => ({ value: step.value }),
      buildLogMessage: (result) => `Filled ${result.value}`,
    });

    await action(mockStep, mockCtx, mockPage as any);

    expect(mockPage.executeAction).toHaveBeenCalledWith(
      expect.objectContaining({ opts: { value: 'hello' } })
    );
  });

  it('uses buildLogMessage with step context', async () => {
    const mockPage = { executeAction: vi.fn().mockResolvedValue({ frame: 'test', tag: 'button' }) };
    const mockCtx = { log: vi.fn(), variables: {}, outputs: {} };
    const mockStep = { action: 'click', xpath: '//button', foo: 'bar' };

    const action = defineAction<'click', typeof mockStep>({
      mode: 'click',
      buildLogMessage: (result, step) => `Clicked with ${step.foo}`,
    });

    await action(mockStep, mockCtx, mockPage as any);

    expect(mockCtx.log).toHaveBeenCalledWith('success', 'Clicked with bar');
  });
});
