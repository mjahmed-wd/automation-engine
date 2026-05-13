/**
 * Page — a thin CDP client bound to a Chrome tab.
 *
 * Wraps chrome.debugger.attach + Target.setAutoAttach (legacy flatten:false
 * mode) so that we can address out-of-process iframes via
 * Target.sendMessageToTarget / Target.receivedMessageFromTarget.
 *
 * Exposes high-level methods (`goto`, `fill`, `get`, `click`, `waitFor`).
 * Each action runs in two phases:
 *
 *   1. Fast path — a single `Runtime.evaluate` that finds + acts atomically.
 *      Walks the document via document.evaluate and recurses into open
 *      shadow roots. Runs on the main page first, then each attached iframe.
 *
 *   2. CDP fallback — `DOM.performSearch` understands XPath natively and
 *      traverses every shadow root including closed ones. We get a nodeId,
 *      `DOM.resolveNode` for a Runtime.RemoteObject, then
 *      `Runtime.callFunctionOn` to perform the action. Triggered when the
 *      fast path turns up nothing, or eagerly when `pierceClosed: true`.
 */

import type { Locator, LogFn } from './schema';
import {
  buildActionExpression,
  buildCallFunctionExpression,
  buildResolveExpression,
  type GetOptions,
  type Mode,
} from './locator';

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
  private readonly cdpReadyChildren = new Set<string>();
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

  static async create(tabId: number, log: LogFn): Promise<Page> {
    const page = new Page(tabId, log);
    await page.init();
    return page;
  }

  private async init() {
    this.log('info', 'Attaching debugger to tab…');
    await this.attach(this.tabTarget);

    this.listener = (source, method, params) => {
      if (source.tabId !== this.tabId) return;
      this.onEvent(method, params);
    };
    chrome.debugger.onEvent.addListener(this.listener);

    await this.sendCmd(this.tabTarget, 'Runtime.enable');
    await this.sendCmd(this.tabTarget, 'DOM.enable').catch(() => {});
    await this.sendCmd(this.tabTarget, 'Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: false,
    });

    await sleep(800);
  }

  private onEvent(method: string, params: any) {
    if (method === 'Target.attachedToTarget') {
      this.childSessions.set(params.sessionId, params.targetInfo);
      this.log('info', `Auto-attached ${params.targetInfo.type}: ${params.targetInfo.url}`);
    } else if (method === 'Target.detachedFromTarget') {
      this.childSessions.delete(params.sessionId);
      this.cdpReadyChildren.delete(params.sessionId);
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
    } catch {}
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
    // Short-circuit when we're already on the target URL — saves a redundant
    // reload after the chrome:// pre-flight in background.ts, and lets users
    // re-run scripts without paying the load cost again.
    try {
      const current = await chrome.tabs.get(this.tabId);
      if (current.url === url && current.status === 'complete') {
        this.log('info', `Already at ${url}, skipping navigation.`);
        return;
      }
    } catch {
      /* tab gone — fall through to update, which will fail loudly */
    }
    this.log('info', `Navigating to ${url}…`);
    await chrome.tabs.update(this.tabId, { url, active: true });
    await this.waitForLoad(30_000);
    await sleep(500);
  }

  async fill(
    locator: Locator,
    value: string,
    opts: { pierceClosed?: boolean } = {},
  ): Promise<FrameResult> {
    return this.runAction(locator, 'fill', { value }, undefined, opts.pierceClosed);
  }

  async get(
    locator: Locator,
    opts: GetOptions & { pierceClosed?: boolean } = {},
  ): Promise<FrameResult> {
    const { pierceClosed, ...getOpts } = opts;
    return this.runAction(locator, 'get', getOpts, undefined, pierceClosed);
  }

  async click(
    locator: Locator,
    opts: { pierceClosed?: boolean } = {},
  ): Promise<FrameResult> {
    await this.validateXPath(locator.xpath);

    // pierceClosed targets are inside closed shadow roots — resolve via CDP
    // DOM walk, then trusted-click at the resolved coordinates.
    if (opts.pierceClosed) {
      this.log('info', 'pierceClosed=true — CDP-resolving and trusted-clicking.');
      return this.cdpTrustedClick(locator);
    }

    // Fast path: resolve coords via Runtime.evaluate (also walks open shadow
    // roots + same-origin iframes). For main-frame matches, dispatch trusted
    // mouse events through CDP Input — needed for any library that gates on
    // event.isTrusted (react-select, MUI Select, etc.). For iframe matches,
    // viewport coords aren't directly translatable, so fall back to the
    // synthetic pointer-sequence click.
    const resolveExpr = buildResolveExpression(locator);
    let resolved: any;
    try {
      resolved = await this.runUntilFound(resolveExpr, DEFAULT_SEARCH_TIMEOUT_MS);
    } catch (fastErr) {
      this.log('info', 'Fast-path resolve missed — trying CDP DOM walk.');
      try {
        return await this.cdpTrustedClick(locator);
      } catch {
        throw fastErr;
      }
    }

    if (resolved?.isMain === true && typeof resolved.x === 'number') {
      await this.dispatchTrustedClick(resolved.x, resolved.y);
      this.log(
        'success',
        `Clicked ${resolved.tag ?? 'element'} (trusted) at (${Math.round(
          resolved.x,
        )}, ${Math.round(resolved.y)}) in ${resolved.frame}`,
      );
      return { ok: true, frame: resolved.frame, tag: resolved.tag, name: resolved.name };
    }

    // Iframe element — synthetic click via the existing pointer sequence.
    this.log(
      'info',
      `Click target in iframe ${resolved?.frame ?? ''} — using synthetic pointer-sequence.`,
    );
    return this.runUntilFound(buildActionExpression(locator, 'click'), DEFAULT_SEARCH_TIMEOUT_MS);
  }

  /** Resolve the element via CDP, scroll it into view, then trusted-click. */
  private async cdpTrustedClick(locator: Locator): Promise<FrameResult> {
    const send = (m: string, p?: Record<string, unknown>) =>
      this.sendCmd(this.tabTarget, m, p);
    const nodeId = await this.cdpResolveXPath(send, locator.xpath);
    if (!nodeId) {
      throw new Error(`No match found for '${locator.xpath}' via CDP DOM walk.`);
    }

    // Scroll into view via callFunctionOn on the resolved object.
    const resolved = await send('DOM.resolveNode', { nodeId });
    const objectId = resolved?.object?.objectId;
    if (objectId) {
      try {
        await send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration:
            'function () { this.scrollIntoView({ block: "center", inline: "center" }); }',
        });
      } finally {
        await send('Runtime.releaseObject', { objectId }).catch(() => {});
      }
    }

    const box = await send('DOM.getBoxModel', { nodeId });
    const content = box?.model?.content as number[] | undefined;
    if (!content || content.length < 8) {
      throw new Error('Element has no box model (zero-size or detached).');
    }
    const x = (content[0] + content[4]) / 2;
    const y = (content[1] + content[5]) / 2;
    await this.dispatchTrustedClick(x, y);
    this.log(
      'success',
      `Clicked (trusted, CDP-resolved) at (${Math.round(x)}, ${Math.round(y)}).`,
    );
    return { ok: true, frame: '' };
  }

  /** Send a trusted left-click at (x, y) in the tab's viewport coordinates. */
  private async dispatchTrustedClick(x: number, y: number): Promise<void> {
    await this.sendCmd(this.tabTarget, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
    });
    await this.sendCmd(this.tabTarget, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await this.sendCmd(this.tabTarget, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
  }

  async waitFor(
    locator: Locator,
    opts: { timeoutMs?: number; pierceClosed?: boolean } = {},
  ): Promise<FrameResult> {
    return this.runAction(locator, 'find', {}, opts.timeoutMs, opts.pierceClosed);
  }

  private async runAction(
    locator: Locator,
    mode: Mode,
    opts: { value?: string } & GetOptions = {},
    timeoutMs?: number,
    pierceClosed?: boolean,
  ): Promise<FrameResult> {
    // Surface XPath syntax errors loudly before the 20-second search timeout.
    await this.validateXPath(locator.xpath);

    if (pierceClosed) {
      this.log('info', 'pierceClosed=true — going straight to CDP DOM walk.');
      return await this.cdpFindAndAct(locator, mode, opts);
    }

    const expression = buildActionExpression(locator, mode, opts);
    let fastErr: Error | null = null;
    try {
      return await this.runUntilFound(expression, timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS);
    } catch (err) {
      fastErr = err as Error;
    }

    this.log('info', 'Fast path missed — trying CDP DOM walk for closed shadow roots…');
    try {
      return await this.cdpFindAndAct(locator, mode, opts);
    } catch (cdpErr: any) {
      this.log('info', `CDP fallback also failed: ${cdpErr?.message ?? cdpErr}`);
      throw fastErr;
    }
  }

  // ---------- fast path: Runtime.evaluate across frames ----------

  private async runUntilFound(
    expression: string,
    timeoutMs: number,
  ): Promise<FrameResult> {
    const start = Date.now();
    const runtimeEnabled = new Set<string>();
    let maxInputs = 0;

    while (Date.now() - start < timeoutMs) {
      const main = await this.evalSafe(this.tabTarget, expression);
      if (main?.ok) return main;
      if (typeof main?.inputs === 'number') maxInputs = Math.max(maxInputs, main.inputs);

      for (const [sessionId, info] of this.childSessions) {
        if (!isDomTarget(info?.type)) continue;
        if (!runtimeEnabled.has(sessionId)) {
          try {
            await this.sendToChild(sessionId, 'Runtime.enable');
            runtimeEnabled.add(sessionId);
          } catch {}
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

  // ---------- CDP fallback: DOM.performSearch with XPath ----------

  private async cdpFindAndAct(
    locator: Locator,
    mode: Mode,
    opts: { value?: string } & GetOptions,
  ): Promise<FrameResult> {
    const mainResult = await this.cdpFindAndActOnTarget(
      (m, p) => this.sendCmd(this.tabTarget, m, p),
      locator,
      mode,
      opts,
    );
    if (mainResult) return mainResult;

    for (const [sessionId, info] of this.childSessions) {
      if (!isDomTarget(info?.type)) continue;
      try {
        if (!this.cdpReadyChildren.has(sessionId)) {
          await this.sendToChild(sessionId, 'DOM.enable');
          this.cdpReadyChildren.add(sessionId);
        }
        const res = await this.cdpFindAndActOnTarget(
          (m, p) => this.sendToChild(sessionId, m, p),
          locator,
          mode,
          opts,
        );
        if (res) {
          if (!res.frame && info?.url) res.frame = info.url;
          return res;
        }
      } catch (err: any) {
        this.log('info', `CDP on ${info?.type ?? 'child'} ${info?.url ?? sessionId}: ${err?.message ?? err}`);
      }
    }

    throw new Error('No match found via CDP DOM walk.');
  }

  /** Find a nodeId by XPath, then call the action function on it. */
  private async cdpFindAndActOnTarget(
    send: (method: string, params?: Record<string, unknown>) => Promise<any>,
    locator: Locator,
    mode: Mode,
    opts: { value?: string } & GetOptions,
  ): Promise<FrameResult | null> {
    const nodeId = await this.cdpResolveXPath(send, locator.xpath);
    if (!nodeId) return null;

    let objectId: string | undefined;
    try {
      const resolved = await send('DOM.resolveNode', { nodeId });
      objectId = resolved?.object?.objectId;
      if (!objectId) return null;

      const fnDecl = buildCallFunctionExpression(mode, opts);
      const result = await send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: fnDecl,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result?.exceptionDetails) {
        throw new Error(
          result.exceptionDetails.exception?.description ??
            result.exceptionDetails.text ??
            'callFunctionOn failed',
        );
      }
      return (result?.result?.value as FrameResult | undefined) ?? null;
    } finally {
      if (objectId) {
        await send('Runtime.releaseObject', { objectId }).catch(() => {});
      }
    }
  }

  /**
   * Resolve an XPath via `DOM.performSearch`, which understands XPath natively
   * and traverses every shadow root, including closed ones.
   */
  private async cdpResolveXPath(
    send: (method: string, params?: Record<string, unknown>) => Promise<any>,
    xpath: string,
  ): Promise<number | null> {
    const search = await send('DOM.performSearch', {
      query: xpath,
      includeUserAgentShadowDOM: false,
    });
    const searchId: string | undefined = search?.searchId;
    const resultCount: number = search?.resultCount ?? 0;
    if (!searchId || resultCount === 0) {
      if (searchId) await send('DOM.discardSearchResults', { searchId }).catch(() => {});
      return null;
    }
    try {
      const res = await send('DOM.getSearchResults', {
        searchId,
        fromIndex: 0,
        toIndex: 1,
      });
      const nodeId: number | undefined = res?.nodeIds?.[0];
      return nodeId ?? null;
    } finally {
      await send('DOM.discardSearchResults', { searchId }).catch(() => {});
    }
  }

  /**
   * Validate an XPath expression up-front. Without this the fast path runs to
   * its full 20-second timeout on a typo and the user sees a vague "Locator
   * not found" — this turns it into "Bad XPath: …".
   */
  private async validateXPath(xpath: string): Promise<void> {
    try {
      const res = await this.sendCmd<any>(this.tabTarget, 'Runtime.evaluate', {
        expression:
          `(() => { try { document.createExpression(${JSON.stringify(xpath)}); return null; } ` +
          `catch (e) { return e.message || String(e); } })()`,
        returnByValue: true,
      });
      const errMsg = res?.result?.value;
      if (errMsg) {
        throw new Error(`Bad XPath: ${errMsg} — '${xpath}'`);
      }
    } catch (err: any) {
      if (err?.message?.startsWith('Bad XPath')) throw err;
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

/** True if a child target's type can run DOM/Runtime evaluation. */
function isDomTarget(type: string | undefined): boolean {
  return type === 'iframe' || type === 'page';
}
