/**
 * Navigator — Page navigation logic.
 *
 * Extracted from Page class during Phase 5 of architecture refactoring.
 * Owns URL navigation, load waiting, and SPA-aware waitForXPath logic.
 */

import type { LogFn, Locator } from './schema';
import type { FrameResult } from './page';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface NavigatorDeps {
  tabId: number;
  log: LogFn;
  navigate: (url: string) => Promise<void>;
  waitForLoad: (timeoutMs: number) => Promise<void>;
  getHasClosedShadow: () => boolean;
  setHasClosedShadow: (value: boolean) => void;
  detectClosedShadow: () => Promise<void>;
  waitFor: (locator: Locator, opts: { timeoutMs?: number }) => Promise<FrameResult>;
}

export class Navigator {
  private readonly deps: NavigatorDeps;

  constructor(deps: NavigatorDeps) {
    this.deps = deps;
  }

  /**
   * Navigate to a URL, with optional SPA-aware waitForXPath wait.
   * Short-circuits if already at the target URL.
   */
  async goto(
    url: string,
    opts: { waitForXPath?: string; waitForTimeoutMs?: number } = {},
  ): Promise<void> {
    // Check if already at target URL
    let alreadyThere = false;
    try {
      const current = await chrome.tabs.get(this.deps.tabId);
      alreadyThere = current.url === url && current.status === 'complete';
    } catch {
      /* tab gone — fall through to update, which will fail loudly */
    }

    if (alreadyThere) {
      this.deps.log('info', `Already at ${url}, skipping navigation.`);
    } else {
      this.deps.log('info', `Navigating to ${url}…`);
      await this.deps.navigate(url);
      await this.deps.waitForLoad(30_000);
      await sleep(500);
    }

    // Reset and re-detect closed shadow on both paths
    this.deps.setHasClosedShadow(false);
    await this.deps.detectClosedShadow();

    // SPA-aware wait for XPath
    if (opts.waitForXPath) {
      await this.deps.waitFor(
        { xpath: opts.waitForXPath },
        { timeoutMs: opts.waitForTimeoutMs },
      );
    }
  }
}
