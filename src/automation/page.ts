/**
 * Page — a thin CDP client bound to a Chrome tab.
 *
 * Wraps chrome.debugger.attach + Target.setAutoAttach (legacy flatten:false
 * mode) so that we can address out-of-process iframes (OOPIFs) via
 * Target.sendMessageToTarget / Target.receivedMessageFromTarget.
 *
 * Exposes high-level methods (`goto`, `fill`, `read`, `click`, `waitFor`)
 * that try the main frame first and fall back to every attached child
 * session. The first frame to match wins.
 */

import type { Locator, LogFn } from './schema';
import { buildActionExpression, type GetOptions } from './locator';

type Target = chrome.debugger.Debuggee;

const PROTOCOL_VERSION = '1.3';
const DEFAULT_SEARCH_TIMEOUT_MS = 20_000;
const CHILD_CMD_TIMEOUT_MS = 10_000;

export interface FrameResult {
  ok: boolean;
  value?: string;
  frame: string;
  tag?: string;
  name?: string;
  inputs?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Page {
  readonly tabId: number;
  private readonly tabTarget: Target;
  private readonly log: LogFn;
  private readonly childSessions = new Map<string, any>();
  private readonly pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();
  private nextMsgId = 1;
  private listener?: (
    source: chrome.debugger.Debuggee,
    method: string,
    params?: any,
  ) => void;
  private detached = false;

  private constructor(tabId: number, log: LogFn) {
    this.tabId = tabId;
    this.tabTarget = { tabId };
    this.log = log;
  }

  /** Attach the debugger and start listening for child target events. */
  static async create(tabId: number, log: LogFn): Promise<Page> {
    const page = new Page(tabId, log);
    await page.init();
    return page;
  }

  private async init() {
    this.log('info', 'Attaching debugger to tab…');
    await this.attach(this.tabTarget);

    // Register the event listener BEFORE setAutoAttach: Chrome fires
    // Target.attachedToTarget synchronously for existing child iframes, so a
    // late-registered listener misses them.
    this.listener = (source, method, params) => {
      if (source.tabId !== this.tabId) return;
      this.onEvent(method, params);
    };
    chrome.debugger.onEvent.addListener(this.listener);

    await this.sendCmd(this.tabTarget, 'Runtime.enable');
    // setAutoAttach is allowed from tab-level sessions (Target.setDiscoverTargets is not).
    // flatten:false uses Target.sendMessageToTarget routing, which chrome.debugger supports.
    await this.sendCmd(this.tabTarget, 'Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: false,
    });

    // Give Chrome a beat for any additional Target.attachedToTarget events.
    await sleep(800);
  }

  private onEvent(method: string, params: any) {
    if (method === 'Target.attachedToTarget') {
      this.childSessions.set(params.sessionId, params.targetInfo);
      this.log('info', `Auto-attached ${params.targetInfo.type}: ${params.targetInfo.url}`);
    } else if (method === 'Target.detachedFromTarget') {
      this.childSessions.delete(params.sessionId);
    } else if (method === 'Target.receivedMessageFromTarget') {
      let msg: any;
      try {
        msg = JSON.parse(params.message);
      } catch {
        return;
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const slot = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) slot.reject(new Error(msg.error.message ?? `code ${msg.error.code}`));
        else slot.resolve(msg.result);
      }
    }
  }

  async detach() {
    if (this.detached) return;
    this.detached = true;
    if (this.listener) chrome.debugger.onEvent.removeListener(this.listener);
    try {
      await this.sendCmd(this.tabTarget, 'Target.setAutoAttach', {
        autoAttach: false,
        waitForDebuggerOnStart: false,
        flatten: false,
      });
    } catch {
      /* may already be detached */
    }
    await new Promise<void>((r) =>
      chrome.debugger.detach(this.tabTarget, () => {
        void chrome.runtime.lastError;
        r();
      }),
    );
    this.log('info', 'Debugger detached.');
  }

  // ---------- high-level actions ----------

  async goto(url: string): Promise<void> {
    this.log('info', `Navigating to ${url}…`);
    await chrome.tabs.update(this.tabId, { url, active: true });
    await this.waitForLoad(30_000);
    // Iframes (esp. OOPIFs) need a beat to register as child targets.
    await sleep(500);
  }

  async fill(locator: Locator, value: string): Promise<FrameResult> {
    return this.runUntilFound(buildActionExpression(locator, 'fill', { value }));
  }

  async get(locator: Locator, opts: GetOptions = {}): Promise<FrameResult> {
    return this.runUntilFound(buildActionExpression(locator, 'get', opts));
  }

  async click(locator: Locator): Promise<FrameResult> {
    return this.runUntilFound(buildActionExpression(locator, 'click'));
  }

  async waitFor(locator: Locator, timeoutMs?: number): Promise<FrameResult> {
    return this.runUntilFound(
      buildActionExpression(locator, 'find'),
      timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS,
    );
  }

  // ---------- frame fan-out ----------

  /** Run the same expression in main + every attached iframe until one succeeds. */
  private async runUntilFound(
    expression: string,
    timeoutMs = DEFAULT_SEARCH_TIMEOUT_MS,
  ): Promise<FrameResult> {
    const start = Date.now();
    const runtimeEnabled = new Set<string>();
    let maxInputs = 0;

    while (Date.now() - start < timeoutMs) {
      // 1) Main frame
      const main = await this.evalSafe(this.tabTarget, expression);
      if (main?.ok) return main;
      if (typeof main?.inputs === 'number') maxInputs = Math.max(maxInputs, main.inputs);

      // 2) Each child session
      for (const [sessionId, info] of this.childSessions) {
        if (!runtimeEnabled.has(sessionId)) {
          try {
            await this.sendToChild(sessionId, 'Runtime.enable');
            runtimeEnabled.add(sessionId);
          } catch {
            /* swallow — page may still be loading */
          }
        }
        try {
          const res = await this.sendToChild<any>(sessionId, 'Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true,
          });
          const value = res.result?.value as FrameResult | undefined;
          if (value?.ok) return value;
          if (typeof value?.inputs === 'number') maxInputs = Math.max(maxInputs, value.inputs);
        } catch (err: any) {
          this.log('info', `Frame ${info?.url ?? sessionId}: ${err?.message ?? err}`);
        }
      }

      await sleep(500);
    }

    throw new Error(
      `Locator not found within ${timeoutMs / 1000}s (max inputs seen in any frame: ${maxInputs})`,
    );
  }

  private async evalSafe(target: Target, expression: string): Promise<FrameResult | null> {
    try {
      const res = await this.sendCmd<any>(target, 'Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      return res.result?.value ?? null;
    } catch {
      return null;
    }
  }

  // ---------- chrome.debugger plumbing ----------

  private attach(target: Target): Promise<void> {
    return new Promise((resolve, reject) => {
      chrome.debugger.attach(target, PROTOCOL_VERSION, () => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve();
      });
    });
  }

  private sendCmd<T = any>(
    target: Target,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      chrome.debugger.sendCommand(target, method, params, (result) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(`${method}: ${err.message}`));
        else resolve(result as T);
      });
    });
  }

  /** Send a CDP command to a child session via the legacy envelope. */
  private sendToChild<T = any>(
    sessionId: string,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextMsgId++;
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} (child) timed out`));
        }
      }, CHILD_CMD_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v: any) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.sendCmd(this.tabTarget, 'Target.sendMessageToTarget', {
        sessionId,
        message: JSON.stringify({ id, method, params }),
      }).catch((err) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      });
    });
  }

  private waitForLoad(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error('Timed out waiting for tab to load'));
      }, timeoutMs);
      const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
        if (id === this.tabId && info.status === 'complete') {
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      chrome.tabs.get(this.tabId).then((t) => {
        if (t.status === 'complete') {
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      });
    });
  }
}
