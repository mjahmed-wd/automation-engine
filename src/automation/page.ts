/**
 * Page — a thin CDP client bound to a Chrome tab.
 *
 * Wraps chrome.debugger.attach + Target.setAutoAttach (legacy flatten:false
 * mode) so that we can address out-of-process iframes (OOPIFs) via
 * Target.sendMessageToTarget / Target.receivedMessageFromTarget.
 *
 * Exposes high-level methods (`goto`, `fill`, `get`, `click`, `waitFor`).
 * Internally each action runs in two phases:
 *
 *   1. Fast path — a single `Runtime.evaluate` that finds + acts atomically.
 *      Covers the light DOM, open shadow roots, and the explicit `>>>`
 *      syntax. Runs on the main page first, then each attached iframe.
 *
 *   2. CDP fallback — `DOM.getDocument({pierce: true})` exposes every shadow
 *      root including closed ones. We walk the tree, run `DOM.querySelector`
 *      against each shadow root, resolve the matching node, and use
 *      `Runtime.callFunctionOn` to perform the action. Only kicks in if the
 *      fast path turned up nothing. Selector-based locators only.
 */

import type { Locator, LogFn } from './schema';
import {
  buildActionExpression,
  buildCallFunctionExpression,
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

interface CdpNode {
  nodeId: number;
  nodeName?: string;
  shadowRoots?: CdpNode[];
  shadowRootType?: string;
  children?: CdpNode[];
  contentDocument?: CdpNode;
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
    await this.sendCmd(this.tabTarget, 'DOM.enable').catch(() => {
      /* may already be enabled */
    });
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
    return this.runAction(locator, 'click', {}, undefined, opts.pierceClosed);
  }

  async waitFor(
    locator: Locator,
    opts: { timeoutMs?: number; pierceClosed?: boolean } = {},
  ): Promise<FrameResult> {
    return this.runAction(locator, 'find', {}, opts.timeoutMs, opts.pierceClosed);
  }

  /**
   * Run an action with the fast path first, then the CDP fallback when the
   * fast path returns nothing. If `pierceClosed` is true, skip the fast path
   * and go straight to the CDP DOM-walk.
   */
  private async runAction(
    locator: Locator,
    mode: Mode,
    opts: { value?: string } & GetOptions = {},
    timeoutMs?: number,
    pierceClosed?: boolean,
  ): Promise<FrameResult> {
    const cdpCapable = !!(locator.selector || locator.xpath);

    // Opt-in shortcut: if the caller knows the target is in a closed shadow
    // root, skip the fast path entirely.
    if (pierceClosed && cdpCapable) {
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

    // Fast path failed. Try the CDP DOM-domain fallback — covers closed
    // shadow roots that the fast path can't see. Only meaningful for
    // selector/xpath locators; labels stay on the fast path.
    if (!cdpCapable) throw fastErr;

    this.log('info', 'Fast path missed — trying CDP DOM walk for closed shadow roots…');
    try {
      return await this.cdpFindAndAct(locator, mode, opts);
    } catch (cdpErr: any) {
      this.log(
        'info',
        `CDP fallback also failed: ${cdpErr?.message ?? cdpErr}`,
      );
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
        // Workers/worklets/service workers don't have DOM — skip them so we
        // don't log noise like "document is not defined".
        if (!isDomTarget(info?.type)) continue;
        if (!runtimeEnabled.has(sessionId)) {
          try {
            await this.sendToChild(sessionId, 'Runtime.enable');
            runtimeEnabled.add(sessionId);
          } catch {
            /* page may still be loading */
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

  // ---------- CDP fallback: DOM domain walks closed shadow roots ----------

  private async cdpFindAndAct(
    locator: Locator,
    mode: Mode,
    opts: { value?: string } & GetOptions,
  ): Promise<FrameResult> {
    // Try main target.
    const mainResult = await this.cdpFindAndActOnTarget(
      this.tabTarget,
      (m, p) => this.sendCmd(this.tabTarget, m, p),
      locator,
      mode,
      opts,
    );
    if (mainResult) return mainResult;

    // Then each child session — iframes only. Workers/worklets/etc don't
    // have DOM.enable so DOM walks against them are pointless and noisy.
    for (const [sessionId, info] of this.childSessions) {
      if (!isDomTarget(info?.type)) continue;
      try {
        if (!this.cdpReadyChildren.has(sessionId)) {
          await this.sendToChild(sessionId, 'DOM.enable');
          this.cdpReadyChildren.add(sessionId);
        }
        const res = await this.cdpFindAndActOnTarget(
          this.tabTarget,
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

  /** One target's worth of "find a nodeId then call function on it". */
  private async cdpFindAndActOnTarget(
    _root: Target,
    send: (method: string, params?: Record<string, unknown>) => Promise<any>,
    locator: Locator,
    mode: Mode,
    opts: { value?: string } & GetOptions,
  ): Promise<FrameResult | null> {
    let nodeId: number | null = null;
    if (locator.xpath) {
      nodeId = await this.cdpResolveXPath(send, locator.xpath);
    } else if (locator.selector && locator.nearText) {
      nodeId = await this.cdpResolveNearText(send, locator.selector, locator.nearText);
    } else if (locator.selector) {
      nodeId = await this.cdpResolveSelector(send, locator.selector);
    }
    if (!nodeId) return null;

    // Resolve the node to a JS remote object so we can run a function on it.
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
      const value = result?.result?.value as FrameResult | undefined;
      return value ?? null;
    } finally {
      if (objectId) {
        await send('Runtime.releaseObject', { objectId }).catch(() => {});
      }
    }
  }

  /**
   * Resolve a (possibly `>>>`-piercing) selector to a single nodeId on the
   * given target. Walks every shadow root returned by DOM.getDocument with
   * pierce:true, so closed shadows are reachable.
   */
  private async cdpResolveSelector(
    send: (method: string, params?: Record<string, unknown>) => Promise<any>,
    selector: string,
  ): Promise<number | null> {
    const hops = selector.includes('>>>')
      ? selector.split('>>>').map((s) => s.trim()).filter(Boolean)
      : null;

    const docResp = await send('DOM.getDocument', { depth: -1, pierce: true });
    const root: CdpNode | undefined = docResp?.root;
    if (!root) return null;

    if (hops && hops.length > 0) {
      // Explicit hop-by-hop: querySelector each segment against the previous
      // element's shadow root.
      let scopeId: number = root.nodeId;
      for (let i = 0; i < hops.length; i++) {
        const r = await send('DOM.querySelector', { nodeId: scopeId, selector: hops[i] });
        const nodeId: number = r?.nodeId ?? 0;
        if (!nodeId) return null;
        if (i === hops.length - 1) return nodeId;
        const desc = await send('DOM.describeNode', {
          nodeId,
          depth: 1,
          pierce: true,
        });
        const sr = desc?.node?.shadowRoots?.[0];
        if (!sr?.nodeId) return null;
        scopeId = sr.nodeId;
      }
      return null;
    }

    // Auto-pierce: collect every shadow root in the tree, run querySelector
    // at each one. First hit wins.
    const roots: number[] = [root.nodeId];
    collectShadowRoots(root, roots);
    for (const nodeId of roots) {
      try {
        const r = await send('DOM.querySelector', { nodeId, selector });
        if (r?.nodeId) return r.nodeId as number;
      } catch {
        /* querySelector against a detached node throws — keep going */
      }
    }
    return null;
  }

  /**
   * Resolve an XPath expression via `DOM.performSearch`, which natively
   * understands XPath and traverses every shadow root, including closed ones.
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
   * Resolve `selector + nearText`: walk the full DOM (incl. shadow roots),
   * find every element whose own direct text content matches `nearText`, then
   * for each one walk up to 6 ancestor levels calling `DOM.querySelector(...,
   * selector)`. First hit wins. Works for closed shadow roots because we read
   * the tree via DOM.getDocument({pierce:true}).
   */
  private async cdpResolveNearText(
    send: (method: string, params?: Record<string, unknown>) => Promise<any>,
    selector: string,
    nearText: string,
  ): Promise<number | null> {
    const docResp = await send('DOM.getDocument', { depth: -1, pierce: true });
    const root: CdpNode | undefined = docResp?.root;
    if (!root) return null;

    // Pattern: a relaxed-whitespace, case-insensitive match.
    const pattern = new RegExp(
      nearText.trim().replace(/\s+/g, '\\s*').replace(/[.*+?^${}()|[\]\\]/g, (m) => m),
      'i',
    );

    // Walk tree, build parent map, collect text-bearing elements.
    const parentOf = new Map<number, number>();
    const candidates: number[] = [];

    const visit = (n: any, parentId: number) => {
      if (n.nodeId != null) parentOf.set(n.nodeId, parentId);
      // CDP nodeType 1 = ELEMENT_NODE. Check the element's *direct* text by
      // summing nodeValue of immediate text-node children.
      if (n.nodeType === 1 && Array.isArray(n.children)) {
        let direct = '';
        for (const c of n.children) {
          if (c.nodeType === 3 && typeof c.nodeValue === 'string') direct += c.nodeValue;
        }
        if (direct && pattern.test(direct)) candidates.push(n.nodeId);
      }
      if (Array.isArray(n.children)) for (const c of n.children) visit(c, n.nodeId);
      if (Array.isArray(n.shadowRoots)) for (const sr of n.shadowRoots) visit(sr, n.nodeId);
      if (n.contentDocument) visit(n.contentDocument, n.nodeId);
    };
    visit(root, -1);

    for (const startId of candidates) {
      let cur: number | undefined = parentOf.get(startId);
      for (let d = 0; d < 6 && cur != null && cur !== -1; d++) {
        try {
          const r = await send('DOM.querySelector', { nodeId: cur, selector });
          if (r?.nodeId) return r.nodeId as number;
        } catch {
          /* unreachable; keep walking */
        }
        cur = parentOf.get(cur);
      }
    }
    return null;
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

/** True if a child target's type can run DOM/Runtime evaluation. */
function isDomTarget(type: string | undefined): boolean {
  return type === 'iframe' || type === 'page';
}

/** Walks a CDP DOM tree node, pushing every shadow-root nodeId into `out`. */
function collectShadowRoots(node: CdpNode, out: number[]): void {
  if (node.shadowRoots) {
    for (const sr of node.shadowRoots) {
      out.push(sr.nodeId);
      collectShadowRoots(sr, out);
    }
  }
  if (node.contentDocument) {
    // Iframes nested inside the main document — for OOPIFs this is empty;
    // same-origin iframes show their inner tree here.
    collectShadowRoots(node.contentDocument, out);
  }
  if (node.children) {
    for (const c of node.children) collectShadowRoots(c, out);
  }
}
