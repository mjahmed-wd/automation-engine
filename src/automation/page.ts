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

/**
 * Thrown when the in-page function signals `fatal:true`. We use a typed error
 * so `runAction` can distinguish "didn't find it, try CDP" from "found it but
 * the page state forbids the action — stop searching."
 */
export class FatalActionError extends Error {
  readonly fatal = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'FatalActionError';
  }
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
  /**
   * Auto-detected at attach + after each DOM-mutating action. When `true`,
   * `runAction` and `click` skip the fast path (which can't see into closed
   * shadow roots) and go straight to CDP. Users can override with
   * `pierceClosed: true` (force CDP) or `pierceClosed: false` (force fast path).
   */
  private hasClosedShadow = false;
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

    // Initial closed-shadow detection so we can skip the fast path on pages
    // like Shepherd that mount closed shadow at load time.
    await this.detectClosedShadow();
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
      const res = await this.sendCmd<any>(this.tabTarget, 'DOM.getDocument', {
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
        // Even on a no-op navigation, re-check shadow state — the page might
        // have rendered different content since the previous detection.
        this.hasClosedShadow = false;
        await this.detectClosedShadow();
        return;
      }
    } catch {
      /* tab gone — fall through to update, which will fail loudly */
    }
    this.log('info', `Navigating to ${url}…`);
    await chrome.tabs.update(this.tabId, { url, active: true });
    await this.waitForLoad(30_000);
    await sleep(500);
    // New page → new shadow landscape. Reset and re-detect synchronously so
    // the next action sees the correct flag.
    this.hasClosedShadow = false;
    await this.detectClosedShadow();
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
    await this.validateXPath(locator.xpath);
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
      await this.dispatchTrustedClick(resolved.x, resolved.y);
      this.log(
        'success',
        `Clicked ${resolved.tag ?? 'element'} (trusted) at (${Math.round(
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
      this.sendCmd(this.tabTarget, m, p);
    const nodeId = await this.cdpResolveXPath(send, locator.xpath);
    if (!nodeId) {
      throw new Error(`No match found for '${locator.xpath}' via CDP DOM walk.`);
    }

    // Scroll into view + overlay hit-test in a single callFunctionOn to avoid a
    // second round-trip. The in-page function returns either {ok:true} or, if
    // some other element would absorb a click at the target center,
    // {ok:false, fatal:true, reason:'covered', message:...} — we surface that
    // as a FatalActionError so page.click()'s caller sees a clear reason
    // instead of a vague CDP failure.
    const resolved = await send('DOM.resolveNode', { nodeId });
    const objectId = resolved?.object?.objectId;
    if (objectId) {
      try {
        const checkRes = await send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: `function () {
            this.scrollIntoView({ block: 'center', inline: 'center' });
            const r = this.getBoundingClientRect();
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            try {
              const root = this.getRootNode();
              const efp = (root && typeof root.elementsFromPoint === 'function'
                ? root.elementsFromPoint(cx, cy)
                : document.elementsFromPoint(cx, cy));
              const top = efp && efp[0];
              if (top && !this.contains(top)) {
                const tag = this.tagName ? this.tagName.toLowerCase() : 'element';
                const ident = this.name ? '[name="' + this.name + '"]' : (this.id ? '#' + this.id : '');
                const topTag = top.tagName ? top.tagName.toLowerCase() : 'element';
                return {
                  ok: false,
                  fatal: true,
                  reason: 'covered',
                  message: 'Cannot click ' + tag + ident + ': covered by <' + topTag + '>',
                  frame: location.href,
                  tag: this.tagName,
                  name: this.name || this.id || '',
                };
              }
            } catch (e) {}
            return { ok: true };
          }`,
          returnByValue: true,
        });
        const out = checkRes?.result?.value as FrameResult | undefined;
        if (out?.fatal) {
          throw new FatalActionError(
            out.message ?? `Click target is ${out.reason ?? 'rejected'}`,
          );
        }
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
    await this.validateXPath(locator.xpath);
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
      await this.dispatchTrustedMouseMove(resolved.x, resolved.y);
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
      this.sendCmd(this.tabTarget, m, p);
    const nodeId = await this.cdpResolveXPath(send, locator.xpath);
    if (!nodeId) {
      throw new Error(`No match found for '${locator.xpath}' via CDP DOM walk.`);
    }

    // scrollIntoView + overlay hit-test in a single callFunctionOn (same
    // pattern as cdpTrustedClick).
    const resolved = await send('DOM.resolveNode', { nodeId });
    const objectId = resolved?.object?.objectId;
    if (objectId) {
      try {
        const checkRes = await send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: `function () {
            this.scrollIntoView({ block: 'center', inline: 'center' });
            const r = this.getBoundingClientRect();
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            try {
              const root = this.getRootNode();
              const efp = (root && typeof root.elementsFromPoint === 'function'
                ? root.elementsFromPoint(cx, cy)
                : document.elementsFromPoint(cx, cy));
              const top = efp && efp[0];
              if (top && !this.contains(top)) {
                const tag = this.tagName ? this.tagName.toLowerCase() : 'element';
                const ident = this.name ? '[name="' + this.name + '"]' : (this.id ? '#' + this.id : '');
                const topTag = top.tagName ? top.tagName.toLowerCase() : 'element';
                return {
                  ok: false,
                  fatal: true,
                  reason: 'covered',
                  message: 'Cannot hover ' + tag + ident + ': covered by <' + topTag + '>',
                  frame: location.href,
                  tag: this.tagName,
                  name: this.name || this.id || '',
                };
              }
            } catch (e) {}
            return { ok: true };
          }`,
          returnByValue: true,
        });
        const out = checkRes?.result?.value as FrameResult | undefined;
        if (out?.fatal) {
          throw new FatalActionError(
            out.message ?? `Hover target is ${out.reason ?? 'rejected'}`,
          );
        }
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
    await this.dispatchTrustedMouseMove(x, y);
    this.log(
      'success',
      `Hovered (trusted, CDP-resolved) at (${Math.round(x)}, ${Math.round(y)}).`,
    );
    return { ok: true, frame: '' };
  }

  /** Trusted cursor-move via CDP. Triggers CSS `:hover` natively, plus all
   *  the pointer/mouse hover events Chrome would normally dispatch. */
  private async dispatchTrustedMouseMove(x: number, y: number): Promise<void> {
    await this.sendCmd(this.tabTarget, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
    });
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
    if (locator) {
      await this.validateXPath(locator.xpath);
      const send = (m: string, p?: Record<string, unknown>) =>
        this.sendCmd(this.tabTarget, m, p);
      const nodeId = await this.cdpResolveXPath(send, locator.xpath);
      if (!nodeId) {
        throw new Error(`Press: no match for '${locator.xpath}' via CDP DOM walk.`);
      }
      const resolved = await send('DOM.resolveNode', { nodeId });
      const objectId = resolved?.object?.objectId;
      if (objectId) {
        try {
          await send('Runtime.callFunctionOn', {
            objectId,
            functionDeclaration:
              'function () { if (typeof this.focus === "function") this.focus(); }',
          });
        } finally {
          await send('Runtime.releaseObject', { objectId }).catch(() => {});
        }
      }
      // pierceClosed is accepted for parity with other actions but isn't
      // structurally needed here — cdpResolveXPath already pierces.
      void opts.pierceClosed;
    }

    const params = mapKeyToCdp(key);
    await this.sendCmd(this.tabTarget, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      ...params,
    });
    await this.sendCmd(this.tabTarget, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      ...params,
    });
    this.log('success', `Pressed "${key}".`);
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
    const res = await this.sendCmd<any>(this.tabTarget, 'Runtime.evaluate', params);
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
    await this.validateXPath(locator.xpath);
    // pierceClosed accepted for parity; cdpResolveXPath always pierces.
    void opts.pierceClosed;

    for (const f of files) {
      if (!isAbsoluteFilePath(f)) {
        throw new Error(
          `upload: file path must be absolute — got '${f}'. ` +
            'Chrome resolves relative paths against an unpredictable cwd, so we require an absolute path on the local filesystem.',
        );
      }
    }

    const send = (m: string, p?: Record<string, unknown>) =>
      this.sendCmd(this.tabTarget, m, p);

    // Poll for the input to appear. Mirrors the cdpFindAndActPolling cadence
    // (500ms) but skips the FrameResult plumbing — upload doesn't run an
    // in-page action function, just resolves a nodeId and feeds it to
    // setFileInputFiles directly.
    const timeoutMs = opts.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    let nodeId: number | null = null;
    while (true) {
      nodeId = await this.cdpResolveXPath(send, locator.xpath);
      if (nodeId) break;
      if (Date.now() >= deadline) {
        throw new Error(
          `upload: locator not found within ${Math.round(timeoutMs / 1000)}s — '${locator.xpath}'`,
        );
      }
      await sleep(500);
    }

    // Verify it's actually a file input. setFileInputFiles silently fails on
    // a wrong target (Chrome accepts the call but no files attach); we'd
    // rather surface the mistake here than have the user wonder why the
    // upload "succeeded" but nothing happened.
    const resolved = await send('DOM.resolveNode', { nodeId });
    const objectId = resolved?.object?.objectId;
    if (objectId) {
      try {
        const check = await send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration:
            'function () { return { tag: this.tagName, type: (this.type || "").toLowerCase() }; }',
          returnByValue: true,
        });
        const meta = check?.result?.value as { tag?: string; type?: string } | undefined;
        if (meta?.tag !== 'INPUT' || meta?.type !== 'file') {
          const got = meta?.tag
            ? `<${meta.tag.toLowerCase()}${meta.type ? ` type="${meta.type}"` : ''}>`
            : 'unknown';
          throw new Error(
            `upload: target is not an <input type="file"> (got ${got}). ` +
              "Many sites hide the real input behind a styled wrapper button — point the xpath at the input itself, not the wrapper.",
          );
        }
      } finally {
        await send('Runtime.releaseObject', { objectId }).catch(() => {});
      }
    }

    await send('DOM.setFileInputFiles', { nodeId, files });
    this.log(
      'success',
      `Uploaded ${files.length} file${files.length === 1 ? '' : 's'} into '${locator.xpath}'.`,
    );
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
    await this.validateXPath(locator.xpath);
    void opts.pierceClosed;

    const send = (m: string, p?: Record<string, unknown>) =>
      this.sendCmd(this.tabTarget, m, p);

    const timeoutMs = opts.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    let nodeId: number | null = null;
    while (true) {
      nodeId = await this.cdpResolveXPath(send, locator.xpath);
      if (nodeId) break;
      if (Date.now() >= deadline) {
        throw new Error(
          `selectOption: locator not found within ${Math.round(timeoutMs / 1000)}s — '${locator.xpath}'`,
        );
      }
      await sleep(500);
    }

    const resolved = await send('DOM.resolveNode', { nodeId });
    const objectId = resolved?.object?.objectId;
    if (!objectId) {
      throw new Error('selectOption: could not resolve element to an object.');
    }

    // In-page iterator. Returns either {ok:true, selected:n} or a fatal
    // sentinel — we surface fatal as FatalActionError so the run loop
    // stops politely instead of doing CDP retries.
    const fnDecl = `function (wants, useLabel) {
      if (this.tagName !== 'SELECT') {
        return {
          ok: false,
          fatal: true,
          reason: 'not-a-select',
          message: 'selectOption: target is not <select> (got <' + (this.tagName ? this.tagName.toLowerCase() : '?') + '>).',
        };
      }
      if (this.disabled) {
        return {
          ok: false,
          fatal: true,
          reason: 'disabled',
          message: 'selectOption: <select> is disabled.',
        };
      }
      var wantSet = {};
      for (var w = 0; w < wants.length; w++) wantSet[String(wants[w])] = true;
      var multi = this.multiple === true;
      var selected = 0;
      var firstMatchIdx = -1;
      for (var i = 0; i < this.options.length; i++) {
        var opt = this.options[i];
        var key = useLabel ? (opt.label || '').trim() : String(opt.value);
        var match = Object.prototype.hasOwnProperty.call(wantSet, key);
        if (multi) {
          opt.selected = match;
          if (match) selected++;
        } else if (match && firstMatchIdx === -1) {
          firstMatchIdx = i;
        }
      }
      if (!multi) {
        if (firstMatchIdx === -1) {
          return {
            ok: false,
            fatal: true,
            reason: 'no-match',
            message: 'selectOption: no option matched ' + JSON.stringify(wants) + (useLabel ? ' (by label)' : ' (by value)') + '.',
          };
        }
        this.selectedIndex = firstMatchIdx;
        selected = 1;
      } else if (selected === 0) {
        return {
          ok: false,
          fatal: true,
          reason: 'no-match',
          message: 'selectOption: no option matched ' + JSON.stringify(wants) + (useLabel ? ' (by label)' : ' (by value)') + '.',
        };
      }
      this.dispatchEvent(new Event('input', { bubbles: true }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, selected: selected };
    }`;

    let count = 0;
    try {
      const res = await send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: fnDecl,
        arguments: [{ value: wants }, { value: opts.useLabel === true }],
        returnByValue: true,
      });
      if (res?.exceptionDetails) {
        throw new Error(
          res.exceptionDetails.exception?.description ??
            res.exceptionDetails.text ??
            'selectOption: callFunctionOn failed',
        );
      }
      const result = res?.result?.value as
        | { ok: boolean; fatal?: boolean; reason?: string; message?: string; selected?: number }
        | undefined;
      if (result?.fatal) {
        throw new FatalActionError(result.message ?? 'selectOption rejected');
      }
      count = result?.selected ?? 0;
    } finally {
      await send('Runtime.releaseObject', { objectId }).catch(() => {});
    }

    this.log(
      'success',
      `Selected ${count} option${count === 1 ? '' : 's'} in '${locator.xpath}'.`,
    );
    return count;
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
      return await this.cdpFindAndActPolling(
        locator,
        mode,
        opts,
        timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS,
      );
    }

    const expression = buildActionExpression(locator, mode, opts);
    let fastErr: Error | null = null;
    try {
      return await this.runUntilFound(expression, timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS);
    } catch (err) {
      // Found-but-rejected — CDP won't change the verdict. Re-throw now.
      if (err instanceof FatalActionError) throw err;
      fastErr = err as Error;
    }

    this.log('info', 'Fast path missed — trying CDP DOM walk for closed shadow roots…');
    try {
      return await this.cdpFindAndActPolling(
        locator,
        mode,
        opts,
        timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS,
      );
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
    const start = Date.now();
    const runtimeEnabled = new Set<string>();
    let maxInputs = 0;

    while (Date.now() - start < timeoutMs) {
      const main = await this.evalSafe(this.tabTarget, expression);
      if (main?.ok) return main;
      // Found-but-rejected (disabled input, etc.). Bail out of the poll loop
      // immediately — no amount of waiting will change the verdict.
      if (main?.fatal) {
        throw new FatalActionError(
          main.message ?? `Action rejected: ${main.reason ?? 'unknown'}`,
        );
      }
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
          if (value?.fatal) {
            throw new FatalActionError(
              value.message ?? `Action rejected: ${value.reason ?? 'unknown'}`,
            );
          }
          if (typeof value?.inputs === 'number') maxInputs = Math.max(maxInputs, value.inputs);
        } catch (err: any) {
          if (err instanceof FatalActionError) throw err;
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
        if (err instanceof FatalActionError) throw err;
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
      const out = (result?.result?.value as FrameResult | undefined) ?? null;
      // Mirror runUntilFound: a CDP-resolved match that returns fatal:true
      // means "found but state-rejected" — bubble it past the frame loop.
      if (out?.fatal) {
        throw new FatalActionError(
          out.message ?? `Action rejected: ${out.reason ?? 'unknown'}`,
        );
      }
      return out;
    } finally {
      if (objectId) {
        await send('Runtime.releaseObject', { objectId }).catch(() => {});
      }
    }
  }

  /**
   * Resolve an XPath against the page, piercing every shadow root (open AND
   * closed) and same-origin iframe document.
   *
   * Strategy (each step is a fallback when the previous can't see closed
   * shadow content):
   *
   *   1. `DOM.getDocument({depth:-1, pierce:true})` — full pierced tree.
   *   2. Walk the tree collecting Document + ShadowRoot + contentDocument
   *      nodeIds, plus host->shadow-root lookup keyed by backendNodeId.
   *   3. For each root, `DOM.resolveNode` → objectId, then
   *      `Runtime.callFunctionOn` runs:
   *        a. `document.evaluate(xp, this, …)` (and `.` + xp for non-Document
   *           contexts) — works inside main doc + open shadows.
   *        b. For shadow contexts, falls back to parsing the shadow's
   *           outerHTML into a synthetic doc, running XPath there, and
   *           path-replaying the result back to the live shadow tree. This
   *           is what catches Shepherd's closed shadow on the Take Payment
   *           page, where `document.evaluate` against the live ShadowRoot
   *           returns null even though the element exists.
   *   4. First root that returns a hit wins; convert its RemoteObject back
   *      into a nodeId via `DOM.requestNode`.
   *
   * We deliberately avoid `DOM.performSearch` — it's documented to traverse
   * closed shadow roots but empirically returns 0 hits on Shepherd while
   * DevTools' Cmd+F finds the same XPath fine.
   */
  private async cdpResolveXPath(
    send: (method: string, params?: Record<string, unknown>) => Promise<any>,
    xpath: string,
  ): Promise<number | null> {
    const doc = await send('DOM.getDocument', { depth: -1, pierce: true });
    const rootIds: number[] = [];
    collectRootNodeIds(doc?.root, rootIds);
    if (rootIds.length === 0) {
      this.log('info', 'CDP DOM walk: no roots collected from getDocument.');
      return null;
    }

    // Two-strategy resolver:
    //  - direct: document.evaluate against the live root (works for main doc
    //    + open shadow roots).
    //  - clone: deep-clone the shadow root's children into a hidden holder
    //    attached to the main document, run XPath there, then replay the
    //    child-index path back into the live shadow tree. Slower but works
    //    when Chrome's XPath engine refuses to descend into a closed
    //    ShadowRoot context. We use cloneNode(true) — NOT outerHTML+parse —
    //    because HTML5 parsing collapses nested <body> elements (which
    //    Shepherd's shadow root has at the top level), which would scramble
    //    child indices and break path-replay.
    //
    // Returns either the matched node, or a small object describing why
    // nothing matched (`__cdp_resolve__: 'direct'|'clone'|'none'`) so the
    // caller can log which strategy each root tried.
    const fnDecl = `function (xp) {
      var ctx = this;
      var isDoc = ctx.nodeType === 9;
      var isFrag = ctx.nodeType === 11;

      function relativize(q) { return q.charAt(0) === '/' ? '.' + q : q; }

      // (a) direct document.evaluate — main doc + open shadow roots
      try {
        var doc = isDoc ? ctx : (ctx.ownerDocument || document);
        var queries = isDoc ? [xp] : [relativize(xp), xp];
        for (var i = 0; i < queries.length; i++) {
          try {
            var r = doc.evaluate(queries[i], ctx, null, 9, null);
            if (r && r.singleNodeValue) return r.singleNodeValue;
          } catch (e) {}
        }
      } catch (e) {}

      // (b) clone-into-light-DOM fallback for closed shadow roots
      if (isFrag && ctx.children && ctx.children.length > 0) {
        var mainDoc = ctx.ownerDocument || document;
        var holder = null;
        try {
          holder = mainDoc.createElement('div');
          holder.style.cssText =
            'position:absolute;left:-99999px;top:-99999px;width:1px;height:1px;overflow:hidden;visibility:hidden;';
          // Must be attached to a document tree for evaluate to see it.
          mainDoc.body.appendChild(holder);
          for (var c = 0; c < ctx.children.length; c++) {
            holder.appendChild(ctx.children[c].cloneNode(true));
          }
          var sq = relativize(xp);
          var sr = mainDoc.evaluate(sq, holder, null, 9, null);
          if (sr && sr.singleNodeValue) {
            // Walk up from cloned match to one of holder.children,
            // recording child-indices. Replay onto the live shadow root.
            var path = [];
            var n = sr.singleNodeValue;
            while (n && n.parentElement && n.parentElement !== holder) {
              var sibs = n.parentElement.children;
              for (var k = 0; k < sibs.length; k++) {
                if (sibs[k] === n) { path.unshift(k); break; }
              }
              n = n.parentElement;
            }
            if (n && n.parentElement === holder) {
              var topIdx = -1;
              for (var m = 0; m < holder.children.length; m++) {
                if (holder.children[m] === n) { topIdx = m; break; }
              }
              if (topIdx >= 0) {
                path.unshift(topIdx);
                var live = ctx;
                for (var p = 0; p < path.length; p++) {
                  var idx = path[p];
                  if (!live.children || idx >= live.children.length) {
                    live = null; break;
                  }
                  live = live.children[idx];
                }
                if (live) return live;
              }
            }
            // Clone matched but path-replay failed — return a sentinel so
            // the caller can log it.
            return { __cdp_resolve__: 'clone-replay-failed' };
          }
          // Clone tried, no match.
          return { __cdp_resolve__: 'clone-no-match' };
        } catch (e) {
          return { __cdp_resolve__: 'clone-threw', err: String(e) };
        } finally {
          if (holder && holder.parentNode) holder.parentNode.removeChild(holder);
        }
      }

      return null;
    }`;

    let walked = 0;
    let errored = 0;
    const synthOutcomes: string[] = [];
    for (const rootNodeId of rootIds) {
      walked++;
      let rootObjectId: string | undefined;
      let matchObjectId: string | undefined;
      try {
        const resolved = await send('DOM.resolveNode', { nodeId: rootNodeId });
        rootObjectId = resolved?.object?.objectId;
        if (!rootObjectId) continue;

        const res = await send('Runtime.callFunctionOn', {
          objectId: rootObjectId,
          functionDeclaration: fnDecl,
          arguments: [{ value: xpath }],
          returnByValue: false,
        });
        if (res?.exceptionDetails) {
          errored++;
          continue;
        }
        const obj = res?.result;
        if (!obj) continue;
        // Null comes back as { type: 'object', subtype: 'null', value: null }.
        if (obj.subtype === 'null' || obj.type === 'undefined') continue;
        matchObjectId = obj.objectId;
        if (!matchObjectId) continue;

        // The function returns either an Element (subtype 'node') or, for
        // closed-shadow clone attempts, a diagnostic sentinel object. Read
        // the sentinel before falling through to DOM.requestNode.
        if (obj.subtype !== 'node') {
          try {
            const sentinel = await send('Runtime.callFunctionOn', {
              objectId: matchObjectId,
              functionDeclaration: 'function () { return this.__cdp_resolve__; }',
              returnByValue: true,
            });
            const tag = sentinel?.result?.value;
            if (typeof tag === 'string') synthOutcomes.push(tag);
          } catch {
            /* ignore diagnostic failure */
          }
          continue;
        }

        const requested = await send('DOM.requestNode', { objectId: matchObjectId });
        const matchNodeId: number | undefined = requested?.nodeId;
        if (matchNodeId) {
          this.log('info', `CDP DOM walk: matched after ${walked}/${rootIds.length} roots.`);
          return matchNodeId;
        }
      } catch {
        errored++;
      } finally {
        if (matchObjectId) {
          await send('Runtime.releaseObject', { objectId: matchObjectId }).catch(() => {});
        }
        if (rootObjectId) {
          await send('Runtime.releaseObject', { objectId: rootObjectId }).catch(() => {});
        }
      }
    }

    const synthSummary =
      synthOutcomes.length > 0 ? `; synth: ${synthOutcomes.join(', ')}` : '';
    this.log(
      'info',
      `CDP DOM walk: no match across ${rootIds.length} roots (${errored} errored)${synthSummary}.`,
    );
    return null;
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
/**
 * Walks a CDP DOM tree (from DOM.getDocument({pierce:true})) looking for any
 * shadow root with `shadowRootType === 'closed'`. Short-circuits on first hit.
 * Recurses into children, shadowRoots, and contentDocument so it catches
 * closed shadow inside same-origin iframes too.
 */
function anyClosedShadow(node: any): boolean {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node.shadowRoots)) {
    for (const sr of node.shadowRoots) {
      if (sr?.shadowRootType === 'closed') return true;
      if (anyClosedShadow(sr)) return true;
    }
  }
  if (Array.isArray(node.children)) {
    for (const c of node.children) {
      if (anyClosedShadow(c)) return true;
    }
  }
  if (node.contentDocument && anyClosedShadow(node.contentDocument)) return true;
  return false;
}

function isDomTarget(type: string | undefined): boolean {
  return type === 'iframe' || type === 'page';
}

/**
 * Cross-platform absolute-path heuristic for `DOM.setFileInputFiles`.
 *   - Unix / macOS: starts with `/`
 *   - Windows drive: `C:\…` or `C:/…`
 *   - Windows UNC:   `\\server\share\…`
 * Anything else we treat as relative and reject up-front.
 */
function isAbsoluteFilePath(p: string): boolean {
  if (!p) return false;
  if (p.startsWith('/')) return true;
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;
  if (p.startsWith('\\\\')) return true;
  return false;
}

/**
 * Coerce a Runtime.evaluate result into a string for `ctx.outputs` storage.
 * Outputs are `Record<string, string>`, so non-string values need a stable
 * representation. JSON.stringify covers objects / arrays; we strip null /
 * undefined to empty so a downstream `{{var}}` substitution doesn't render
 * literal "null".
 */
function serializeEvalResult(value: unknown): string {
  if (value == null) return '';
  const t = typeof value;
  if (t === 'string') return value as string;
  if (t === 'number' || t === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Map a friendly key name to the params CDP `Input.dispatchKeyEvent` expects.
 * Covers Enter, Tab, Escape, arrow keys, Backspace, Delete, Space — the keys
 * an automation actually needs. For anything else we fall back to treating
 * the key as a single character (best-effort, no synthetic shift handling).
 */
function mapKeyToCdp(key: string): {
  key: string;
  code: string;
  windowsVirtualKeyCode?: number;
  text?: string;
} {
  switch (key) {
    case 'Enter':
      return { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' };
    case 'Tab':
      return { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 };
    case 'Escape':
      return { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 };
    case 'Backspace':
      return { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 };
    case 'Delete':
      return { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 };
    case 'ArrowDown':
      return { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 };
    case 'ArrowUp':
      return { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 };
    case 'ArrowLeft':
      return { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 };
    case 'ArrowRight':
      return { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 };
    case ' ':
    case 'Space':
      return { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' };
    default:
      return { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, text: key };
  }
}

/**
 * Walks a pierced CDP DOM tree and collects every nodeId we can scope an XPath
 * to: the main Document, each ShadowRoot (open or closed), and every
 * same-origin iframe's contentDocument. Order matters — main document first,
 * then shadow roots in tree order, then iframe docs — so that a hit in the
 * light DOM beats a hit in a shadow.
 *
 * Shadow roots come through CDP as `shadowRoots: [...]` on their host element,
 * with `nodeType === 11` (DocumentFragment). Documents have `nodeType === 9`.
 */
function collectRootNodeIds(node: any, out: number[]): void {
  if (!node || typeof node !== 'object') return;
  if (node.nodeType === 9 && typeof node.nodeId === 'number') {
    out.push(node.nodeId);
  }
  if (Array.isArray(node.shadowRoots)) {
    for (const sr of node.shadowRoots) {
      if (sr && typeof sr.nodeId === 'number') out.push(sr.nodeId);
      collectRootNodeIds(sr, out);
    }
  }
  if (Array.isArray(node.children)) {
    for (const c of node.children) collectRootNodeIds(c, out);
  }
  if (node.contentDocument) collectRootNodeIds(node.contentDocument, out);
}
