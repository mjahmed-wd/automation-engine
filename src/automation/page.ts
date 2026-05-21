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
 *   2. CDP fallback — `DOM.getDocument({pierce: true})` returns the full tree
 *      including closed shadow roots and same-origin iframe documents. We
 *      collect every Document / ShadowRoot nodeId, `DOM.resolveNode` each to
 *      a RemoteObject, then `Runtime.callFunctionOn` to run
 *      `document.evaluate` scoped to that root. First hit wins; we
 *      `DOM.requestNode` it back to a nodeId, then call the action via
 *      `Runtime.callFunctionOn` on the resolved object. Triggered when the
 *      fast path turns up nothing, or eagerly when `pierceClosed: true`.
 *      (We don't use `DOM.performSearch` — it's documented to traverse
 *      closed shadow roots but in practice returns 0 hits on some real
 *      sites, e.g. Shepherd's Take Payment page where DevTools Cmd+F
 *      finds the element fine.)
 */

import type { Locator, LogFn } from './schema';
import {
  buildActionExpression,
  buildDescribeExpression,
  buildResolveExpression,
  type GetOptions,
  type Mode,
} from './locator';
import { CDPPort } from './cdp-port';
import { TabManager } from './tab-manager';
import { NetworkMonitor } from './network-monitor';
import { DOMExecutor, FatalActionError, anyClosedShadow } from './dom-executor';
import { InputExecutor } from './input-executor';
import { UploadHandler } from './upload-handler';
import { SelectHandler } from './select-handler';
import { EventRouter } from './event-router';
import { Navigator } from './navigator';
import { serializeEvalResult } from './serialization';
import type { ActionDescriptor, ActionResult } from './action-descriptor';
import type { NetworkResponse } from './network-monitor';

// Re-exports for action handlers and interpreter
export { FatalActionError } from './dom-executor';
export type FatalReason = 'disabled' | 'read-only' | 'covered' | 'no-match' | 'not-a-select' | 'unknown';
export type { ActionDescriptor, ActionResult } from './action-descriptor';

type Target = chrome.debugger.Debuggee;

const DEFAULT_SEARCH_TIMEOUT_MS = 20_000;

export interface FrameResult {
  ok: boolean;
  value?: string;
  frame: string;
  tag?: string;
  name?: string;
  inputs?: number;
  /**
   * Found-but-rejected signal. When `true`, the locator matched an element but
   * we refuse to act on it (e.g., fill target is `disabled` / `readOnly`, or in
   * Batch 3 a click target is overlay-covered). The search loop stops polling
   * immediately and surfaces `message` to the user.
   */
  fatal?: boolean;
  /** Short tag for the rejection, e.g. `'disabled'`, `'read-only'`, `'covered'`. */
  reason?: string;
  /** Human-readable error built in-page so the loop can throw it verbatim. */
  message?: string;
}

/** One element's worth of metadata returned by `describe`. */
export interface DescribeMatch {
  frame: string;
  tag: string;
  id?: string;
  name?: string;
  classes: string[];
  /** First 60 chars of `innerText`, trimmed. Ellipsis appended if truncated. */
  text: string;
}

/** Result shape of `page.describe`. `matches` is capped at 5; `matchCount`
 *  is exact (i.e., may exceed `matches.length`). */
export interface DescribeResult {
  matchCount: number;
  matches: DescribeMatch[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Page {
  readonly windowId: number | undefined;
  private readonly log: LogFn;
  private readonly cdpPort = new CDPPort();
  private readonly tabManager: TabManager;
  private readonly networkMonitor: NetworkMonitor;
  private readonly domExecutor: DOMExecutor;
  private readonly inputExecutor: InputExecutor;
  private readonly uploadHandler: UploadHandler;
  private readonly selectHandler: SelectHandler;
  private readonly eventRouter: EventRouter;
  private readonly navigator: Navigator;
  private detached = false;

  /** Public view of the active tab. */
  get tabId(): number {
    return this.tabManager.getCurrentTabId();
  }

  /** Accessors for current tab's CDP state — delegate to TabManager. */
  private get tabTarget(): Target {
    return this.tabManager.tabTarget;
  }
  private get childSessions(): Map<string, any> {
    return this.tabManager.childSessions;
  }
  private get cdpReadyChildren(): Set<string> {
    return this.tabManager.cdpReadyChildren;
  }
  private get hasClosedShadow(): boolean {
    return this.tabManager.hasClosedShadow;
  }
  private set hasClosedShadow(v: boolean) {
    this.tabManager.hasClosedShadow = v;
  }

  private constructor(_tabId: number, windowId: number | undefined, log: LogFn) {
    this.windowId = windowId;
    this.log = log;
    this.tabManager = new TabManager({ windowId, log }, this.cdpPort, () => this.detectClosedShadow());
    this.networkMonitor = new NetworkMonitor(log, this.cdpPort);
    this.domExecutor = new DOMExecutor(log, this.cdpPort);
    this.inputExecutor = new InputExecutor(log, this.cdpPort);
    this.uploadHandler = new UploadHandler(log, this.cdpPort);
    this.selectHandler = new SelectHandler(log, this.cdpPort);
    this.eventRouter = new EventRouter(
      log,
      this.cdpPort,
      this.networkMonitor,
      (tabId) => this.tabManager.attachments.get(tabId),
    );
    this.navigator = new Navigator({
      tabId: this.tabId,
      log,
      navigate: async (url) => {
        await chrome.tabs.update(this.tabId, { url, active: true });
      },
      waitForLoad: (timeoutMs) => this.waitForLoad(timeoutMs),
      getHasClosedShadow: () => this.hasClosedShadow,
      setHasClosedShadow: (v) => { this.hasClosedShadow = v; },
      detectClosedShadow: () => this.detectClosedShadow(),
      waitFor: (locator, opts) => this.waitFor(locator, opts),
    });
  }

  static async create(
    tabId: number,
    windowId: number | undefined,
    log: LogFn,
  ): Promise<Page> {
    const page = new Page(tabId, windowId, log);
    await page.init(tabId);
    return page;
  }

  private async init(initialTabId: number) {
    // CDPPort routes all CDP events. We register a callback that forwards
    // to per-tab handlers (dialog, network, etc.).
    this.cdpPort.onEvent((target, method, params) => {
      const tabId = target.tabId;
      if (tabId === undefined) return;
      if (!this.tabManager.attachments.has(tabId)) return;
      this.onEvent(tabId, method, params);
    });

    await this.tabManager.init(initialTabId);
  }

  /**
   * One CDP round-trip to check whether the page contains any closed shadow
   * roots (which the fast-path `document.evaluate` can't see). Cached on the
   * instance; flips back to false only on `goto`. Re-runs after `click` and
   * `waitFor` if currently false, so dynamically-mounted closed shadow
   * (modals, dropdowns, SPA route changes) flips us into CDP mode.
   */
  private async detectClosedShadow(): Promise<void> {
    try {
      const res = await this.cdpPort.sendCommand<any>(this.tabTarget, 'DOM.getDocument', {
        depth: -1,
        pierce: true,
      });
      const found = anyClosedShadow(res?.root);
      if (found !== this.hasClosedShadow) {
        this.log(
          'info',
          found
            ? 'Closed shadow root detected — XPath actions will use CDP path.'
            : 'No closed shadow roots — XPath actions back to fast path.',
        );
      }
      this.hasClosedShadow = found;
    } catch {
      /* keep previous state on detection failure */
    }
  }

  private onEvent(sourceTabId: number, method: string, params: any) {
    this.eventRouter.onEvent(sourceTabId, method, params);
  }

  async detach() {
    if (this.detached) {
      this.log('info', 'Page.detach() called but already detached.');
      return;
    }
    this.detached = true;
    this.log('info', 'Page.detach() starting...');
    // Cleanup network state for all tabs before detaching.
    for (const tabId of this.tabManager.attachments.keys()) {
      this.networkMonitor.cleanup(tabId);
    }
    await this.tabManager.detachAll();
    this.cdpPort.detach();
    this.log('info', 'Page.detach() complete.');
  }

  /**
   * Pre-arm the one-shot response for the next native dialog. Called by the
   * `dialog` action handler. Single audit point so the field stays private.
   * If never consumed, the arming sits until the next dialog fires — pair
   * this immediately before the step that will actually trigger one.
   */
  setNextDialogResponse(accept: boolean, promptText: string = ''): void {
    this.tabManager.armDialog(accept, promptText);
  }

  // ---------- high-level actions ----------

  async goto(
    url: string,
    opts: { waitForXPath?: string; waitForTimeoutMs?: number } = {},
  ): Promise<void> {
    return this.navigator.goto(url, opts);
  }

  /**
   * Central action execution point using ActionDescriptor pattern.
   * Validates XPath, determines strategy (fast vs CDP), executes with
   * error context, and returns the result.
   *
   * This is the preferred way for action handlers to execute locator-based
   * actions, replacing direct calls to fill/get/waitFor/etc.
   */
  async executeAction<T = any>(descriptor: ActionDescriptor<T>): Promise<ActionResult> {
    // Click mode must use trusted CDP events (event.isTrusted=true) for
    // libraries like react-select, MUI Select that gate on this property.
    // Route to the existing page.click() method which handles this correctly.
    if (descriptor.mode === 'click') {
      return this.click(descriptor.locator, {
        pierceClosed: descriptor.pierceClosed,
        timeoutMs: descriptor.timeoutMs,
      });
    }

    const context = {
      action: descriptor.name,
      original: descriptor.originalXPath,
      resolved: descriptor.locator.xpath,
      value: (descriptor.opts as any)?.value,
    };

    try {
      // Validate XPath upfront to fail fast on syntax errors
      await this.domExecutor.validateXPath(this.tabTarget, descriptor.locator.xpath);

      const totalTimeout = descriptor.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;
      const deadline = Date.now() + totalTimeout;

      // Three-state pierceClosed gate
      const shouldUseCdp =
        descriptor.pierceClosed === true ||
        (descriptor.pierceClosed !== false && this.hasClosedShadow);

      if (shouldUseCdp) {
        this.log(
          'info',
          descriptor.pierceClosed === true
            ? 'pierceClosed=true — going straight to CDP DOM walk.'
            : 'Closed shadow detected — going straight to CDP DOM walk.',
        );
        return await this.cdpFindAndActPolling(
          descriptor.locator,
          descriptor.mode,
          descriptor.opts ?? {},
          totalTimeout,
        );
      }

      // Fast path with CDP fallback
      const expression = buildActionExpression(
        descriptor.locator,
        descriptor.mode,
        descriptor.opts ?? {},
      );
      let fastErr: Error | null = null;
      try {
        return await this.runUntilFound(expression, totalTimeout);
      } catch (err) {
        if (err instanceof FatalActionError) throw err;
        fastErr = err as Error;
      }

      // CDP fallback with remaining budget
      const remainingMs = Math.max(0, deadline - Date.now());
      this.log(
        'info',
        `Fast path missed — trying CDP DOM walk (${remainingMs}ms remaining)…`,
      );
      try {
        return await this.cdpFindAndActPolling(
          descriptor.locator,
          descriptor.mode,
          descriptor.opts ?? {},
          remainingMs,
        );
      } catch (cdpErr: any) {
        if (cdpErr instanceof FatalActionError) throw cdpErr;
        this.log('info', `CDP fallback also failed: ${cdpErr?.message ?? cdpErr}`);
        throw fastErr;
      }
    } catch (err: any) {
      // Add error context (same as withLocatorContext)
      if (err instanceof FatalActionError) throw err;

      const target = context.original ?? '(no xpath)';
      const valuePart = context.value !== undefined ? ` → ${JSON.stringify(String(context.value))}` : '';
      const tail = context.original && context.original !== context.resolved
        ? `\n  resolved xpath: ${context.resolved}`
        : '';
      const baseMessage = err?.message ?? String(err);

      throw new Error(
        `Failed to ${context.action} ${target}${valuePart}: ${baseMessage}${tail}`,
      );
    }
  }

  // ---------- multi-tab orchestration ----------

  /**
   * Open a new tab at `url`, attach the debugger to it, and make it current.
   * Pushes the previously-current tabId onto the origin stack so a subsequent
   * `closeTab` returns focus to the right place.
   *
   * `waitForXPath` / `waitForTimeoutMs` mirror `goto`'s SPA-aware wait — the
   * new tab's load completes when the HTML shell parses, which is too early
   * for React/Vue/Angular. Pass an xpath that's guaranteed to render after
   * mount to delay until the framework is up.
   */
  // ---------- multi-tab orchestration (delegated to TabManager) ----------

  async openTab(
    url: string,
    opts: { waitForXPath?: string; waitForTimeoutMs?: number } = {},
  ): Promise<number> {
    return this.tabManager.openTab(url, opts, this.waitFor.bind(this));
  }

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
    } = {},
  ): Promise<number> {
    return this.tabManager.openWindow(url, opts, this.waitFor.bind(this));
  }

  async switchToTab(
    spec: { urlMatches?: string; index?: number },
    opts: { noStack?: boolean } = {},
  ): Promise<number> {
    return this.tabManager.switchToTab(spec, opts);
  }

  async waitForNewTab(
    opts: { urlMatches?: string; timeoutMs?: number } = {},
  ): Promise<number> {
    return this.tabManager.waitForNewTab(opts);
  }

  async closeTab(): Promise<void> {
    await this.tabManager.closeTab();
  }

  async cycleTab(direction: 'next' | 'previous'): Promise<number> {
    return this.tabManager.cycleTab(direction);
  }

  // ---------- network waits (Batch 3) ----------

  /**
   * Wait for the next Network.responseReceived event on the current tab
   * matching the supplied predicates. Race-tolerant via the per-tab
   * EventWaiter ringbuffer — responses that fired up to ~30s ago still
   * resolve (handles the common case where the response lands DURING the
   * prior step's CDP roundtrip).
   *
   * `saveBody: true` triggers an extra `Network.getResponseBody` CDP call
   * after the event arrives, returning the body as a string (base64
   * decoded if the response was binary). Omit to skip — the network wait
   * itself is event-only and very cheap.
   */
  async waitForResponse(opts: {
    urlMatches: string;
    status?: number | number[] | Record<string, number>;
    method?: string;
    timeoutMs?: number;
    saveBody?: boolean;
  }): Promise<NetworkResponse & { body?: string }> {
    const result = await this.networkMonitor.waitForResponse(
      this.tabId,
      this.tabTarget,
      opts,
    );
    return result;
  }

  async fill(
    locator: Locator,
    value: string,
    opts: { pierceClosed?: boolean; timeoutMs?: number } = {},
  ): Promise<FrameResult> {
    return this.runAction(locator, 'fill', { value }, opts.timeoutMs, opts.pierceClosed);
  }

  async get(
    locator: Locator,
    opts: GetOptions & { pierceClosed?: boolean; timeoutMs?: number } = {},
  ): Promise<FrameResult> {
    const { pierceClosed, timeoutMs, ...getOpts } = opts;
    return this.runAction(locator, 'get', getOpts, timeoutMs, pierceClosed);
  }

  async click(
    locator: Locator,
    opts: { pierceClosed?: boolean; timeoutMs?: number } = {},
  ): Promise<FrameResult> {
    await this.domExecutor.validateXPath(this.tabTarget,locator.xpath);
    const timeout = opts.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;

    // Three-state pierceClosed: explicit true/false overrides; undefined
    // consults the auto-detected hasClosedShadow flag.
    const shouldUseCdp =
      opts.pierceClosed === true ||
      (opts.pierceClosed !== false && this.hasClosedShadow);

    if (shouldUseCdp) {
      this.log(
        'info',
        opts.pierceClosed === true
          ? 'pierceClosed=true — CDP-resolving and trusted-clicking.'
          : 'Closed shadow detected — CDP-resolving and trusted-clicking.',
      );
      const out = await this.cdpTrustedClick(locator);
      // Click may have opened new closed shadow content. We're already in CDP
      // mode so the flag is true; nothing to re-detect.
      return out;
    }

    // Fast path: resolve coords via Runtime.evaluate (also walks open shadow
    // roots + same-origin iframes). For main-frame matches, dispatch trusted
    // mouse events through CDP Input — needed for any library that gates on
    // event.isTrusted (react-select, MUI Select, etc.). For iframe matches,
    // viewport coords aren't directly translatable, so fall back to the
    // synthetic pointer-sequence click.
    const resolveExpr = buildResolveExpression(locator);
    let resolved: any;
    let result: FrameResult;
    try {
      resolved = await this.runUntilFound(resolveExpr, timeout);
    } catch (fastErr) {
      // Fast-path resolve returned fatal (overlay-covered, or future
      // fill/click rejections) — no point asking CDP to re-confirm.
      if (fastErr instanceof FatalActionError) throw fastErr;
      this.log('info', 'Fast-path resolve missed — trying CDP DOM walk.');
      try {
        result = await this.cdpTrustedClick(locator);
      } catch (cdpErr) {
        // Prefer a fatal message from CDP (e.g. "covered by <div>") over the
        // generic "Locator not found" we'd otherwise surface.
        if (cdpErr instanceof FatalActionError) throw cdpErr;
        throw fastErr;
      }
      // Fast path missed but CDP found it — likely a closed shadow root we
      // hadn't detected yet. Schedule a re-detect to flip the flag.
      this.detectClosedShadow().catch(() => {});
      return result;
    }

    if (resolved?.isMain === true && typeof resolved.x === 'number') {
      await this.inputExecutor.dispatchTrustedClick(this.tabTarget, resolved.x, resolved.y);
      const dbg = resolved._debug ? ` [class="${(resolved._debug as any).class || ''}" text="${(resolved._debug as any).text || ''}"]` : '';
      this.log(
        'success',
        `Clicked ${resolved.tag ?? 'element'}${dbg} (trusted) at (${Math.round(
          resolved.x,
        )}, ${Math.round(resolved.y)}) in ${resolved.frame}`,
      );
      result = { ok: true, frame: resolved.frame, tag: resolved.tag, name: resolved.name };
    } else {
      // Iframe element — synthetic click via the existing pointer sequence.
      this.log(
        'info',
        `Click target in iframe ${resolved?.frame ?? ''} — using synthetic pointer-sequence.`,
      );
      result = await this.runUntilFound(
        buildActionExpression(locator, 'click'),
        timeout,
      );
    }

    // Click might have opened a modal / dropdown / SPA route with new closed
    // shadow. Fire-and-forget re-detect so the next action sees it.
    if (!this.hasClosedShadow) {
      this.detectClosedShadow().catch(() => {});
    }
    return result;
  }

  /** Resolve the element via CDP, scroll it into view, then trusted-click. */
  private async cdpTrustedClick(locator: Locator): Promise<FrameResult> {
    const send = (m: string, p?: Record<string, unknown>) =>
      this.cdpPort.sendCommand(this.tabTarget, m, p);
    const { x, y } = await this.domExecutor.cdpResolveAndVerify(send, locator.xpath, 'click');
    await this.inputExecutor.dispatchTrustedClick(this.tabTarget, x, y);
    this.log('success', `Clicked (trusted, CDP-resolved) at (${Math.round(x)}, ${Math.round(y)}).`);
    return { ok: true, frame: '' };
  }

  /**
   * Hover the cursor over an element. Parallels page.click() but only emits
   * the cursor move — no press/release/click. Trusted path (CDP
   * Input.dispatchMouseEvent({type:'mouseMoved'})) is preferred because it's
   * the only thing that triggers CSS `:hover`; synthetic dispatch via
   * buildActionExpression('hover') is the iframe fallback (fires JS hover
   * handlers only).
   */
  async hover(
    locator: Locator,
    opts: { pierceClosed?: boolean; timeoutMs?: number } = {},
  ): Promise<FrameResult> {
    await this.domExecutor.validateXPath(this.tabTarget,locator.xpath);
    const timeout = opts.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;

    // Three-state pierceClosed: same gate as click. Closed-shadow auto-detect
    // flips us straight to CDP-trusted hover.
    const shouldUseCdp =
      opts.pierceClosed === true ||
      (opts.pierceClosed !== false && this.hasClosedShadow);

    if (shouldUseCdp) {
      this.log(
        'info',
        opts.pierceClosed === true
          ? 'pierceClosed=true — CDP-resolving and trusted-hover.'
          : 'Closed shadow detected — CDP-resolving and trusted-hover.',
      );
      return await this.cdpTrustedHover(locator);
    }

    const resolveExpr = buildResolveExpression(locator);
    let resolved: any;
    let result: FrameResult;
    try {
      resolved = await this.runUntilFound(resolveExpr, timeout);
    } catch (fastErr) {
      if (fastErr instanceof FatalActionError) throw fastErr;
      this.log('info', 'Fast-path resolve missed — trying CDP DOM walk.');
      try {
        result = await this.cdpTrustedHover(locator);
      } catch (cdpErr) {
        if (cdpErr instanceof FatalActionError) throw cdpErr;
        throw fastErr;
      }
      this.detectClosedShadow().catch(() => {});
      return result;
    }

    if (resolved?.isMain === true && typeof resolved.x === 'number') {
      await this.inputExecutor.dispatchTrustedMouseMove(this.tabTarget, resolved.x, resolved.y);
      this.log(
        'success',
        `Hovered ${resolved.tag ?? 'element'} (trusted) at (${Math.round(
          resolved.x,
        )}, ${Math.round(resolved.y)}) in ${resolved.frame}`,
      );
      result = { ok: true, frame: resolved.frame, tag: resolved.tag, name: resolved.name };
    } else {
      // Iframe element — synthetic event dispatch (JS hover handlers only;
      // CSS :hover won't fire from synthetic events).
      this.log(
        'info',
        `Hover target in iframe ${resolved?.frame ?? ''} — using synthetic event dispatch.`,
      );
      result = await this.runUntilFound(
        buildActionExpression(locator, 'hover'),
        timeout,
      );
    }

    // Hover often reveals new DOM (tooltips, dropdowns) including newly
    // mounted closed shadow. Fire-and-forget re-detect so the next action
    // routes correctly.
    if (!this.hasClosedShadow) {
      this.detectClosedShadow().catch(() => {});
    }
    return result;
  }

  /**
   * Resolve via CDP (handles closed shadow), scroll-into-view + overlay
   * hit-test in one round trip, then trusted mouseMoved at the element's
   * center. Used both for the auto-detected-closed-shadow gate and the
   * fast-path-miss fallback.
   */
  private async cdpTrustedHover(locator: Locator): Promise<FrameResult> {
    const send = (m: string, p?: Record<string, unknown>) =>
      this.cdpPort.sendCommand(this.tabTarget, m, p);
    const { x, y } = await this.domExecutor.cdpResolveAndVerify(send, locator.xpath, 'hover');
    await this.inputExecutor.dispatchTrustedMouseMove(this.tabTarget, x, y);
    this.log('success', `Hovered (trusted, CDP-resolved) at (${Math.round(x)}, ${Math.round(y)}).`);
    return { ok: true, frame: '' };
  }

  /**
   * Side-effect-free diagnostic — enumerate the matches for an xpath and
   * return their metadata. Routes through the same `shouldUseCdp` gate as
   * other actions; the fast path enumerates fully (up to 5 matches), the
   * CDP path returns at most one match because `cdpResolveXPath` short-
   * circuits on first.
   *
   * No polling — `describe` reports the current state. Pair with a `waitFor`
   * beforehand if the element is async-mounted.
   */
  async describe(
    locator: Locator,
    opts: { pierceClosed?: boolean } = {},
  ): Promise<DescribeResult> {
    await this.domExecutor.validateXPath(this.tabTarget,locator.xpath);

    const shouldUseCdp =
      opts.pierceClosed === true ||
      (opts.pierceClosed !== false && this.hasClosedShadow);

    if (shouldUseCdp) {
      this.log(
        'info',
        opts.pierceClosed === true
          ? 'pierceClosed=true — describe via CDP DOM walk (first match only).'
          : 'Closed shadow detected — describe via CDP DOM walk (first match only).',
      );
      return await this.describeCdp(locator);
    }

    const res = await this.cdpPort.sendCommand<any>(this.tabTarget, 'Runtime.evaluate', {
      expression: buildDescribeExpression(locator),
      returnByValue: true,
      awaitPromise: false,
    });
    if (res?.exceptionDetails) {
      const desc =
        res.exceptionDetails.exception?.description ??
        res.exceptionDetails.text ??
        'describe failed';
      throw new Error(`describe: ${desc}`);
    }
    const value = res?.result?.value as DescribeResult | undefined;
    return value ?? { matchCount: 0, matches: [] };
  }

  /** CDP path for `describe`. Returns at most one match — extending
   *  `cdpResolveXPath` to enumerate all matches wasn't justified for v1. */
  private async describeCdp(locator: Locator): Promise<DescribeResult> {
    const send = (m: string, p?: Record<string, unknown>) =>
      this.cdpPort.sendCommand(this.tabTarget, m, p);
    const match = await this.domExecutor.cdpDescribe(send, locator.xpath);
    if (!match) return { matchCount: 0, matches: [] };
    return {
      matchCount: 1,
      matches: [{
        frame: '',
        tag: match.tag ?? '',
        id: match.id,
        name: match.name,
        classes: match.classes,
        text: match.text,
      }],
    };
  }

  async waitFor(
    locator: Locator,
    opts: { timeoutMs?: number; pierceClosed?: boolean } = {},
  ): Promise<FrameResult> {
    const result = await this.runAction(locator, 'find', {}, opts.timeoutMs, opts.pierceClosed);
    // After a waitFor, page might have rendered new content — including
    // newly-mounted closed shadow. Re-detect if we haven't already flipped.
    if (!this.hasClosedShadow) {
      this.detectClosedShadow().catch(() => {});
    }
    return result;
  }

  /**
   * Dispatch a trusted keyboard event via CDP `Input.dispatchKeyEvent`. If a
   * locator is given, the element is focused first (CDP-resolved so it works
   * inside closed shadow roots); otherwise the keystroke goes to whatever has
   * focus already. Used for Vue forms wired to `@keyup.enter` on an input,
   * where clicking the visible submit button doesn't trigger submit (no
   * `<form>` wrapper).
   */
  async press(
    locator: Locator | null,
    key: string,
    opts: { pierceClosed?: boolean } = {},
  ): Promise<void> {
    // Helper to focus an element via CDP before pressing a key.
    const focusElement = locator
      ? async (send: (m: string, p?: Record<string, unknown>) => Promise<any>, xpath: string) => {
          await this.domExecutor.cdpFocusElement(send, xpath);
        }
      : undefined;

    await this.inputExecutor.press(this.tabTarget, key, {
      locator: locator ?? undefined,
      focusElement,
    });
    // pierceClosed is accepted for parity with other actions but isn't
    // structurally needed here — cdpResolveXPath already pierces.
    void opts.pierceClosed;
  }

  /**
   * Arbitrary JS evaluation in the main frame. Used by the `evaluate` action
   * as the user-facing escape hatch when no specialised action fits.
   *
   * `returnByValue:true` so the result comes back as JSON. `awaitPromise:true`
   * so the user's expression can be async without extra ceremony. If the
   * expression throws, we surface the description from `exceptionDetails`.
   *
   * Result is serialised to a string (the shape `ctx.outputs` stores):
   *   - null / undefined  → ""
   *   - string            → as-is
   *   - number / boolean  → String()
   *   - object / array    → JSON.stringify()
   */
  async evaluate(
    expression: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<string> {
    const params: Record<string, unknown> = {
      expression,
      returnByValue: true,
      awaitPromise: true,
    };
    // CDP timeout applies to the awaitPromise wait. Omit when not set so a
    // long-running expression isn't truncated unless the user asked for it.
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      params.timeout = opts.timeoutMs;
    }
    const res = await this.cdpPort.sendCommand<any>(this.tabTarget, 'Runtime.evaluate', params);
    if (res?.exceptionDetails) {
      const desc =
        res.exceptionDetails.exception?.description ??
        res.exceptionDetails.text ??
        'evaluation failed';
      throw new Error(`evaluate: ${desc}`);
    }
    return serializeEvalResult(res?.result?.value);
  }

  /**
   * Inject files into a real `<input type="file">` via `DOM.setFileInputFiles`.
   * This is the only reliable way to attach files in an automation — there's
   * no page-JS equivalent.
   *
   * Polls `cdpResolveXPath` until the input appears or `timeoutMs` elapses
   * (default 20s). Verifies the resolved node is actually an `INPUT[type=file]`
   * — if the user pointed at a styled wrapper, we fail fast with a clear
   * "target is not an <input type='file'>" instead of CDP's opaque error.
   * File paths are required to be absolute; relatives get rejected up-front.
   */
  async upload(
    locator: Locator,
    files: string[],
    opts: { pierceClosed?: boolean; timeoutMs?: number } = {},
  ): Promise<void> {
    await this.domExecutor.validateXPath(this.tabTarget,locator.xpath);
    // pierceClosed accepted for parity; cdpResolveXPath always pierces.
    void opts.pierceClosed;

    return this.uploadHandler.upload(this.tabTarget, locator, files, {
      timeoutMs: opts.timeoutMs,
      resolveXPath: (sendFn, xpath) => this.domExecutor.cdpResolveXPath(sendFn, xpath),
    });
  }

  /**
   * Pick option(s) in a native `<select>`. Resolves the select via
   * `cdpResolveXPath` (with polling), then runs an in-page iterator that
   * sets `selectedIndex` (single) or toggles `option.selected` per-option
   * (multi), then dispatches `input` + `change`. Returns the count of
   * options that ended up selected.
   *
   * Failure modes that surface as FatalActionError (no point in retrying):
   *   - resolved element isn't a `<select>` (probably a custom dropdown)
   *   - the select is disabled
   *   - no option matched the requested value(s)/label(s)
   */
  async selectOption(
    locator: Locator,
    wants: string[],
    opts: { useLabel?: boolean; pierceClosed?: boolean; timeoutMs?: number } = {},
  ): Promise<number> {
    await this.domExecutor.validateXPath(this.tabTarget,locator.xpath);
    void opts.pierceClosed;

    return this.selectHandler.selectOption(this.tabTarget, locator, wants, {
      useLabel: opts.useLabel,
      timeoutMs: opts.timeoutMs,
      resolveXPath: (sendFn, xpath) => this.domExecutor.cdpResolveXPath(sendFn, xpath),
    });
  }

  private async runAction(
    locator: Locator,
    mode: Mode,
    opts: { value?: string } & GetOptions = {},
    timeoutMs?: number,
    pierceClosed?: boolean,
  ): Promise<FrameResult> {
    // Surface XPath syntax errors loudly before the 20-second search timeout.
    await this.domExecutor.validateXPath(this.tabTarget,locator.xpath);

    // Single shared deadline across fast path + CDP fallback. Previously each
    // phase got its own `timeoutMs`, so `timeoutMs: 2000` effectively allowed
    // 4s total when the fast path missed and CDP also polled. Now `timeoutMs`
    // is the wall-clock budget for the whole action — the fast path gets the
    // full budget, the fallback gets whatever's left (typically a single
    // CDP attempt before bailing).
    const totalTimeout = timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;
    const deadline = Date.now() + totalTimeout;

    // Three-state pierceClosed:
    //   true       → always CDP (overrides auto-detection)
    //   false      → always fast path (overrides auto-detection)
    //   undefined  → use auto-detected hasClosedShadow flag
    const shouldUseCdp =
      pierceClosed === true ||
      (pierceClosed !== false && this.hasClosedShadow);

    if (shouldUseCdp) {
      this.log(
        'info',
        pierceClosed === true
          ? 'pierceClosed=true — going straight to CDP DOM walk.'
          : 'Closed shadow detected — going straight to CDP DOM walk.',
      );
      return await this.cdpFindAndActPolling(locator, mode, opts, totalTimeout);
    }

    const expression = buildActionExpression(locator, mode, opts);
    let fastErr: Error | null = null;
    try {
      return await this.runUntilFound(expression, totalTimeout);
    } catch (err) {
      // Found-but-rejected — CDP won't change the verdict. Re-throw now.
      if (err instanceof FatalActionError) throw err;
      fastErr = err as Error;
    }

    // Remaining budget for the CDP fallback. If the fast path consumed
    // everything, the polling loop still does ONE attempt before checking
    // the deadline — that's the right behavior for "give CDP a single shot
    // at closed-shadow content the fast path can't see."
    const remainingMs = Math.max(0, deadline - Date.now());
    this.log(
      'info',
      `Fast path missed — trying CDP DOM walk for closed shadow roots (${remainingMs}ms remaining)…`,
    );
    try {
      return await this.cdpFindAndActPolling(locator, mode, opts, remainingMs);
    } catch (cdpErr: any) {
      if (cdpErr instanceof FatalActionError) throw cdpErr;
      this.log('info', `CDP fallback also failed: ${cdpErr?.message ?? cdpErr}`);
      throw fastErr;
    }
  }

  /**
   * Poll `cdpFindAndAct` until it succeeds or `timeoutMs` elapses. Each
   * attempt does a fresh `DOM.getDocument({pierce:true})` walk + per-root
   * resolution, so this is the CDP-side analog of `runUntilFound`. Needed
   * because SPA navigations (Shepherd's `/invoices/edit` → `/take-payment`
   * route change) take measurable time to render the closed-shadow subtree
   * after the URL changes — a single attempt right after the click loses the
   * race. Polling at ~500ms intervals lines up with the fast-path cadence.
   *
   * `FatalActionError` (e.g. element exists but is `disabled`) short-circuits
   * the loop — retrying won't change the verdict.
   */
  private async cdpFindAndActPolling(
    locator: Locator,
    mode: Mode,
    opts: { value?: string } & GetOptions,
    timeoutMs: number,
  ): Promise<FrameResult> {
    const deadline = Date.now() + timeoutMs;
    let lastErr: Error | null = null;
    while (true) {
      try {
        return await this.cdpFindAndAct(locator, mode, opts);
      } catch (err) {
        if (err instanceof FatalActionError) throw err;
        lastErr = err as Error;
        if (Date.now() >= deadline) break;
        await sleep(500);
      }
    }
    throw (
      lastErr ??
      new Error(`CDP DOM walk: no match within ${Math.round(timeoutMs / 1000)}s.`)
    );
  }

  // ---------- fast path: Runtime.evaluate across frames ----------

  private async runUntilFound(
    expression: string,
    timeoutMs: number,
  ): Promise<FrameResult> {
    return this.domExecutor.runUntilFound(
      this.tabTarget,
      this.childSessions,
      expression,
      timeoutMs,
    );
  }

  // ---------- CDP fallback: DOM.performSearch with XPath ----------

  private async cdpFindAndAct(
    locator: Locator,
    mode: Mode,
    opts: { value?: string } & GetOptions,
  ): Promise<FrameResult> {
    return this.domExecutor.cdpFindAndAct(
      this.tabTarget,
      this.childSessions,
      this.cdpReadyChildren,
      locator,
      mode,
      opts,
    );
  }

  // ---------- chrome.debugger plumbing (moved to CDPPort) ----------

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
