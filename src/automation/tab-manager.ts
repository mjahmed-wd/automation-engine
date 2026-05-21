/**
 * TabManager — Multi-tab orchestration and CDP attachment lifecycle.
 *
 * Extracted from Page class during Phase 2 of architecture refactoring.
 * Owns the attachments Map, origin stack, and per-tab state including
 * dialog arming. Delegates low-level CDP messaging to CDPPort.
 */

import type { LogFn } from './schema';
import { CDPPort, type Target } from './cdp-port';
import { waitForTabComplete } from './tabs';
import { EventWaiter } from './event-waiter';

/**
 * Per-tab CDP state.
 */
export interface TabAttachment {
  target: Target;
  childSessions: Map<string, any>;
  cdpReadyChildren: Set<string>;
  hasClosedShadow: boolean;
  nextDialogResponse: { accept: boolean; promptText: string } | null;
}

export interface TabManagerOptions {
  windowId: number | undefined;
  log: LogFn;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class TabManager {
  readonly windowId: number | undefined;
  private readonly log: LogFn;
  private readonly cdpPort: CDPPort;
  private readonly detectClosedShadow: () => Promise<void>;

  /** Every tab we've attached debugger to during this run. */
  readonly attachments = new Map<number, TabAttachment>();

  /** Origin stack for `tab close` — pushes previous tabId, pops on close. */
  private readonly originStack: number[] = [];

  /** Active tab pointer. */
  currentTabId!: number;

  /** Tab event waiter for race-tolerant waitForNewTab. */
  private readonly tabEventWaiter = new EventWaiter<chrome.tabs.Tab>({
    windowMs: 30_000,
    maxBufferSize: 50,
  });
  private tabCreatedListener?: (tab: chrome.tabs.Tab) => void;
  private tabUpdatedListener?: (
    tabId: number,
    info: chrome.tabs.TabChangeInfo,
    tab: chrome.tabs.Tab,
  ) => void;

  constructor(options: TabManagerOptions, cdpPort: CDPPort, detectClosedShadow: () => Promise<void>) {
    this.windowId = options.windowId;
    this.log = options.log;
    this.cdpPort = cdpPort;
    this.detectClosedShadow = detectClosedShadow;
    this.setupTabListeners();
  }

  /** Get current tab ID. */
  getCurrentTabId(): number {
    return this.currentTabId;
  }

  /** Get attachment for a tab, throws if not found. */
  getAttachment(tabId: number): TabAttachment {
    const a = this.attachments.get(tabId);
    if (!a) {
      throw new Error(
        `TabManager: no attachment for tab ${tabId}`,
      );
    }
    return a;
  }

  /** Get attachment for current tab. */
  get currentAttachment(): TabAttachment {
    return this.getAttachment(this.currentTabId);
  }

  /** Accessors for current tab's CDP state. */
  get tabTarget(): Target {
    return this.currentAttachment.target;
  }

  get childSessions(): Map<string, any> {
    return this.currentAttachment.childSessions;
  }

  get cdpReadyChildren(): Set<string> {
    return this.currentAttachment.cdpReadyChildren;
  }

  get hasClosedShadow(): boolean {
    return this.currentAttachment.hasClosedShadow;
  }

  set hasClosedShadow(v: boolean) {
    this.currentAttachment.hasClosedShadow = v;
  }

  /** Dialog handling — arm the next response. */
  armDialog(accept: boolean, promptText: string = ''): void {
    this.currentAttachment.nextDialogResponse = { accept, promptText };
    this.log(
      'info',
      `Next dialog armed → ${accept ? (promptText ? `accept with "${promptText}"` : 'accept') : 'cancel'}`,
    );
  }

  /** Consume the armed dialog response. Returns null if no response armed. */
  getDialogResponse(): { accept: boolean; promptText: string } | null {
    const attachment = this.currentAttachment;
    const armed = attachment.nextDialogResponse;
    attachment.nextDialogResponse = null;
    return armed;
  }

  /** Initialize with the first tab. */
  async init(initialTabId: number): Promise<void> {
    this.currentTabId = initialTabId;
    await this.attachTab(initialTabId);
  }

  /**
   * Attach debugger to tabId and register TabAttachment.
   * Idempotent: if already attached, just flips currentTabId.
   */
  async attachTab(tabId: number): Promise<void> {
    if (this.attachments.has(tabId)) {
      this.currentTabId = tabId;
      return;
    }
    const target: Target = { tabId };
    const attachment: TabAttachment = {
      target,
      childSessions: new Map(),
      cdpReadyChildren: new Set(),
      hasClosedShadow: false,
      nextDialogResponse: null,
    };
    this.attachments.set(tabId, attachment);
    this.currentTabId = tabId;

    this.log('info', `Attaching debugger to tab ${tabId}…`);
    try {
      await this.cdpPort.attach(target);
      await this.cdpPort.sendCommand(target, 'Runtime.enable');
      await this.cdpPort.sendCommand(target, 'DOM.enable').catch(() => {});
      await this.cdpPort.sendCommand(target, 'Page.enable').catch(() => {});

      await this.cdpPort.sendCommand(target, 'Network.enable').catch(() => {});

      await this.cdpPort.sendCommand(target, 'Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: false,
      });

      await sleep(800);

      await this.detectClosedShadow();
    } catch (err: any) {
      this.attachments.delete(tabId);
      this.log('error', `Attach failed: ${err?.message ?? err}`);
      throw err;
    }
  }

  /** Open a new tab and attach to it. */
  async openTab(
    url: string,
    opts: { waitForXPath?: string; waitForTimeoutMs?: number },
    waitForFn: (locator: any, opts: any) => Promise<any>,
  ): Promise<number> {
    const targetWindowId = this.windowId;
    const created = await chrome.tabs.create({
      url,
      windowId: targetWindowId,
    });
    if (created.id === undefined) {
      throw new Error('tab open: chrome.tabs.create returned no tab id.');
    }
    this.originStack.push(this.currentTabId);
    await waitForTabComplete(created.id, 30_000);
    await this.attachTab(created.id);
    this.log('info', `Opened new tab ${created.id} → ${url}`);
    if (opts.waitForXPath) {
      await waitForFn(
        { xpath: opts.waitForXPath },
        { timeoutMs: opts.waitForTimeoutMs },
      );
    }
    return created.id;
  }

  /** Open a new browser window and attach to its tab. */
  async openWindow(
    url: string,
    opts: {
      windowType?: 'normal' | 'popup';
      width?: number;
      height?: number;
      left?: number;
      top?: number;
      waitForXPath?: string;
      waitForTimeoutMs?: number;
    },
    waitForFn: (locator: any, opts: any) => Promise<any>,
  ): Promise<number> {
    const createInfo: chrome.windows.CreateData = {
      url,
      focused: true,
      type: opts.windowType ?? 'normal',
    };
    if (opts.width !== undefined) createInfo.width = opts.width;
    if (opts.height !== undefined) createInfo.height = opts.height;
    if (opts.left !== undefined) createInfo.left = opts.left;
    if (opts.top !== undefined) createInfo.top = opts.top;

    const win = await chrome.windows.create(createInfo);
    const newTab = win?.tabs?.[0];
    if (!newTab?.id) {
      throw new Error(
        'tab openWindow: chrome.windows.create returned no tab.',
      );
    }
    this.originStack.push(this.currentTabId);
    await waitForTabComplete(newTab.id, 30_000);
    await this.attachTab(newTab.id);
    this.log(
      'info',
      `Opened new ${createInfo.type} window ${win.id} → ${url} (tab ${newTab.id}).`,
    );
    if (opts.waitForXPath) {
      await waitForFn(
        { xpath: opts.waitForXPath },
        { timeoutMs: opts.waitForTimeoutMs },
      );
    }
    return newTab.id;
  }

  /** Switch to a different tab. */
  async switchToTab(
    spec: { urlMatches?: string; index?: number },
    opts: { noStack?: boolean } = {},
  ): Promise<number> {
    const tabs = await chrome.tabs.query(
      this.windowId !== undefined ? { windowId: this.windowId } : {},
    );
    let target: chrome.tabs.Tab | undefined;
    if (typeof spec.index === 'number') {
      target = tabs.find((t) => t.index === spec.index);
    } else if (spec.urlMatches) {
      const matcher = (urlPattern: string) => {
        const regex = new RegExp(urlPattern);
        return (url: string) => regex.test(url);
      };
      const matcherFn = matcher(spec.urlMatches);
      target = tabs.find((t) => matcherFn(t.url ?? t.pendingUrl ?? ''));
    }
    if (!target?.id) {
      throw new Error(
        `tab switchTo: no tab matched ${
          spec.urlMatches ? `'${spec.urlMatches}'` : `index ${spec.index}`
        }`,
      );
    }
    if (target.id === this.currentTabId) {
      this.log('info', `tab switchTo: already on tab ${target.id}.`);
      return target.id;
    }
    if (!opts.noStack) this.originStack.push(this.currentTabId);
    await chrome.tabs.update(target.id, { active: true });
    await this.attachTab(target.id);
    this.log('info', `Switched to tab ${target.id} (${target.url ?? ''}).`);
    return target.id;
  }

  /** Wait for a new tab to appear and attach to it. */
  async waitForNewTab(
    opts: { urlMatches?: string; timeoutMs?: number } = {},
  ): Promise<number> {
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const matcher = opts.urlMatches
      ? ((urlPattern: string) => {
          const regex = new RegExp(urlPattern);
          return (url: string) => regex.test(url);
        })(opts.urlMatches)
      : () => true;

    const predicate = (tab: chrome.tabs.Tab): boolean => {
      if (tab.id === undefined) return false;
      if (tab.id === this.currentTabId) return false;
      if (this.attachments.has(tab.id)) return false;
      const url = tab.url ?? tab.pendingUrl ?? '';
      if (!url) return false;
      return matcher(url);
    };

    const matched = await this.tabEventWaiter.await(
      predicate,
      timeoutMs,
      `new tab${opts.urlMatches ? ` matching '${opts.urlMatches}'` : ''}`,
    );
    if (matched.id === undefined) {
      throw new Error('waitForNewTab: matched tab has no id (unexpected).');
    }
    const id = matched.id;

    this.originStack.push(this.currentTabId);
    await chrome.tabs.update(id, { active: true }).catch(() => {});
    await waitForTabComplete(id, 30_000);
    await this.attachTab(id);
    this.log('info', `New tab ${id} ready; engine attached.`);
    return id;
  }

  /** Close the current tab and return to origin. */
  async closeTab(): Promise<number> {
    const closingId = this.currentTabId;
    if (this.attachments.size === 1 && this.originStack.length === 0) {
      throw new Error(
        'tab close: refusing to close the only attached tab.',
      );
    }
    const attachment = this.attachments.get(closingId);
    if (!attachment) {
      throw new Error(`tab close: no attachment for tab ${closingId}`);
    }
    const target = attachment.target;

    try {
      await this.cdpPort.sendCommand(target, 'Target.setAutoAttach', {
        autoAttach: false,
        waitForDebuggerOnStart: false,
        flatten: false,
      });
    } catch {}
    await new Promise<void>((r) =>
      chrome.debugger.detach(target, () => {
        void chrome.runtime.lastError;
        r();
      }),
    );
    this.attachments.delete(closingId);

    try {
      await chrome.tabs.remove(closingId);
    } catch (err: any) {
      this.log('info', `tab close: chrome.tabs.remove non-fatal: ${err?.message ?? err}`);
    }

    const previous = this.originStack.pop();
    if (previous !== undefined && this.attachments.has(previous)) {
      this.currentTabId = previous;
      await chrome.tabs.update(previous, { active: true }).catch(() => {});
      this.log('info', `Closed tab ${closingId}; back on tab ${previous}.`);
    } else {
      const fallback = this.attachments.keys().next().value;
      if (fallback === undefined) {
        throw new Error('tab close: no remaining attached tabs.');
      }
      this.currentTabId = fallback;
      await chrome.tabs.update(fallback, { active: true }).catch(() => {});
      this.log('info', `Closed tab ${closingId}; fell back to tab ${fallback}.`);
    }

    return this.currentTabId;
  }

  /** Cycle to next or previous tab in the strip. */
  async cycleTab(direction: 'next' | 'previous'): Promise<number> {
    const tabs = await chrome.tabs.query(
      this.windowId !== undefined ? { windowId: this.windowId } : {},
    );
    if (tabs.length === 0) {
      throw new Error(`tab ${direction}: no tabs found in window.`);
    }
    tabs.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const i = tabs.findIndex((t) => t.id === this.currentTabId);
    const step = direction === 'next' ? 1 : -1;
    const target = tabs[(i + step + tabs.length) % tabs.length];
    if (!target?.id || target.id === this.currentTabId) {
      throw new Error(`tab ${direction}: nowhere to cycle to.`);
    }
    this.originStack.push(this.currentTabId);
    await chrome.tabs.update(target.id, { active: true });
    await this.attachTab(target.id);
    this.log(
      'info',
      `Cycled ${direction} → tab ${target.id} (${target.url ?? ''}).`,
    );
    return target.id;
  }

  /** Detach all tabs and clean up listeners. */
  async detachAll(): Promise<void> {
    if (this.tabCreatedListener) {
      chrome.tabs.onCreated.removeListener(this.tabCreatedListener);
    }
    if (this.tabUpdatedListener) {
      chrome.tabs.onUpdated.removeListener(this.tabUpdatedListener);
    }
    this.tabEventWaiter.clear('TabManager detached');

    const targets = [...this.attachments.values()].map((a) => a.target);
    this.log('info', `Detaching ${targets.length} tab(s)...`);
    this.attachments.clear();
    for (const i in targets) {
      const target = targets[i];
      try {
        await this.cdpPort.sendCommand(target, 'Target.setAutoAttach', {
          autoAttach: false,
          waitForDebuggerOnStart: false,
          flatten: false,
        });
      } catch (e) {
        this.log('error', `Target.setAutoAttach failed: ${(e as Error).message}`);
      }
      await new Promise<void>((r) =>
        chrome.debugger.detach(target, () => {
          const err = chrome.runtime.lastError;
          if (err) {
            this.log('error', `chrome.debugger.detach error: ${err.message}`);
          } else {
            this.log('info', `Detached tab ${target.tabId}`);
          }
          r();
        }),
      );
    }
  }

  /** Setup chrome.tabs listeners for race-tolerant tab event handling. */
  private setupTabListeners(): void {
    this.tabCreatedListener = (tab) => {
      this.tabEventWaiter.emit(tab);
    };
    this.tabUpdatedListener = (_tabId, _info, tab) => {
      this.tabEventWaiter.emit(tab);
    };
    chrome.tabs.onCreated.addListener(this.tabCreatedListener);
    chrome.tabs.onUpdated.addListener(this.tabUpdatedListener);
  }
}
