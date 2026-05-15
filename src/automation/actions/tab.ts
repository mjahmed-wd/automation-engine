/**
 * Tab orchestration action — dispatches on `step.op` into the matching
 * `page.*` method. No xpath here, so no `withLocatorContext` wrapping; we
 * surface the underlying error message verbatim. URL substitution mirrors
 * `goto` — `urlMatches` and `url` both run through `substituteRaw`.
 */

import type { ExecutionContext, TabStep } from '../schema';
import { substituteRaw } from '../schema';
import type { Page } from '../page';

export async function tabAction(step: TabStep, ctx: ExecutionContext, page: Page) {
  switch (step.op) {
    case 'open': {
      if (!step.url) throw new Error('tab open: missing "url".');
      const url = substituteRaw(step.url, ctx);
      await page.openTab(url, {
        waitForXPath: step.waitForXPath
          ? substituteRaw(step.waitForXPath, ctx)
          : undefined,
        waitForTimeoutMs: step.waitForTimeoutMs,
      });
      return;
    }
    case 'switchTo': {
      const urlMatches = step.urlMatches
        ? substituteRaw(step.urlMatches, ctx)
        : undefined;
      await page.switchToTab({ urlMatches, index: step.index });
      return;
    }
    case 'waitForNew': {
      const urlMatches = step.urlMatches
        ? substituteRaw(step.urlMatches, ctx)
        : undefined;
      await page.waitForNewTab({ urlMatches, timeoutMs: step.timeoutMs });
      return;
    }
    case 'close': {
      await page.closeTab();
      return;
    }
    case 'next':
    case 'previous': {
      await page.cycleTab(step.op);
      return;
    }
    default: {
      // Validator should have caught this, but keep an explicit guard so a
      // schema/registry skew surfaces clearly.
      const op = (step as any).op;
      throw new Error(`tab: unsupported op "${op}".`);
    }
  }
}
