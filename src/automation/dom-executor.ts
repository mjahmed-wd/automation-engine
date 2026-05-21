/**
 * DOMExecutor — Low-level CDP/DOM operations for element discovery and action.
 *
 * Extracted from Page class during Phase 4 of architecture refactoring.
 * Owns fast-path Runtime.evaluate, CDP DOM fallback, XPath resolution,
 * shadow root traversal, and frame iteration.
 */

import type { LogFn, Locator } from './schema';
import type { FrameResult } from './page';
import { buildCallFunctionExpression, type Mode, type GetOptions } from './locator';
import type { Target } from './cdp-port';
import { CDPPort } from './cdp-port';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Result of a frame iteration — contains both the value and metadata about
 * which frame produced it.
 */
export interface FrameIterationResult {
  result: FrameResult | null;
  sessionId?: string;
  frameUrl?: string;
}

export class DOMExecutor {
  private readonly log: LogFn;
  private readonly cdpPort: CDPPort;

  constructor(log: LogFn, cdpPort: CDPPort) {
    this.log = log;
    this.cdpPort = cdpPort;
  }

  /**
   * Validate an XPath expression up-front. Without this the fast path runs to
   * its full 20-second timeout on a typo and the user sees a vague "Locator
   * not found" — this turns it into "Bad XPath: …".
   */
  async validateXPath(target: Target, xpath: string): Promise<void> {
    try {
      const res = await this.cdpPort.sendCommand<any>(target, 'Runtime.evaluate', {
        expression:
          `(() => { try { document.createExpression(${JSON.stringify(xpath)}); return null; } ` +
          `catch (e) { return e.message || String(e); } })()`,
        returnByValue: true,
      });
      const err = res.result?.value;
      if (err) throw new Error(`Bad XPath: ${err}`);
    } catch (err: any) {
      throw new Error(`Bad XPath: ${err?.message ?? err}`);
    }
  }

  /**
   * Fast-path: poll across main frame and all same-origin iframes using
   * Runtime.evaluate. Returns the first frame that produces an `ok: true`
   * result. Throws FatalActionError if any frame returns `fatal: true`
   * (e.g., disabled input, overlay-covered).
   */
  async runUntilFound(
    mainTarget: Target,
    childSessions: Map<string, any>,
    expression: string,
    timeoutMs: number,
  ): Promise<FrameResult> {
    const start = Date.now();
    const runtimeEnabled = new Set<string>();
    let maxInputs = 0;

    while (Date.now() - start < timeoutMs) {
      const main = await this.evalSafe(mainTarget, expression);
      if (main?.ok) return main;
      // Found-but-rejected (disabled input, etc.). Bail out of the poll loop
      // immediately — no amount of waiting will change the verdict.
      if (main?.fatal) {
        throw new FatalActionError(
          main.message ?? `Action rejected: ${main.reason ?? 'unknown'}`,
          this.coerceFatalReason(main.reason),
        );
      }
      if (typeof main?.inputs === 'number') maxInputs = Math.max(maxInputs, main.inputs);

      for (const [sessionId, info] of childSessions) {
        if (!this.isDomTarget(info?.type)) continue;
        if (!runtimeEnabled.has(sessionId)) {
          try {
            await this.cdpPort.sendToChild(mainTarget, sessionId, 'Runtime.enable');
            runtimeEnabled.add(sessionId);
          } catch {}
        }
        try {
          const res = await this.cdpPort.sendToChild<any>(mainTarget, sessionId, 'Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true,
          });
          const value = res.result?.value as FrameResult | undefined;
          if (value?.ok) return value;
          if (value?.fatal) {
            throw new FatalActionError(
              value.message ?? `Action rejected: ${value.reason ?? 'unknown'}`,
              this.coerceFatalReason(value.reason),
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

  /**
   * Safe Runtime.evaluate wrapper. Returns null on any error instead of
   * throwing — used by runUntilFound to poll frames without noise.
   */
  async evalSafe(target: Target, expression: string): Promise<FrameResult | null> {
    try {
      const res = await this.cdpPort.sendCommand<any>(target, 'Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      return res.result?.value ?? null;
    } catch {
      return null;
    }
  }

  /**
   * CDP fallback: find element by XPath across all frames and execute action.
   * Uses DOM.getDocument + DOM.resolveNode + Runtime.callFunctionOn to pierce
   * closed shadow roots and same-origin iframes.
   */
  async cdpFindAndAct(
    mainTarget: Target,
    childSessions: Map<string, any>,
    cdpReadyChildren: Set<string>,
    locator: Locator,
    mode: Mode,
    opts: { value?: string } & GetOptions,
  ): Promise<FrameResult> {
    const mainResult = await this.cdpFindAndActOnTarget(
      (m, p) => this.cdpPort.sendCommand(mainTarget, m, p),
      locator,
      mode,
      opts,
    );
    if (mainResult) return mainResult;

    for (const [sessionId, info] of childSessions) {
      if (!this.isDomTarget(info?.type)) continue;
      try {
        if (!cdpReadyChildren.has(sessionId)) {
          await this.cdpPort.sendToChild(mainTarget, sessionId, 'DOM.enable');
          cdpReadyChildren.add(sessionId);
        }
        const res = await this.cdpFindAndActOnTarget(
          (m, p) => this.cdpPort.sendToChild(mainTarget, sessionId, m, p),
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

  /**
   * Find a nodeId by XPath, then call the action function on it.
   * Returns null if no match, throws FatalActionError if found but rejected.
   */
  async cdpFindAndActOnTarget(
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
          this.coerceFatalReason(out.reason),
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
   * Strategy:
   *   1. `DOM.getDocument({depth:-1, pierce:true})` — full pierced tree.
   *   2. Walk the tree collecting Document + ShadowRoot + contentDocument nodeIds.
   *   3. For each root, run a two-strategy resolver:
   *      - direct: document.evaluate against live root (main doc + open shadow)
   *      - clone: clone closed shadow into light DOM, replay child-index path
   *   4. First root that returns a hit wins; convert to nodeId via DOM.requestNode.
   */
  async cdpResolveXPath(
    send: (method: string, params?: Record<string, unknown>) => Promise<any>,
    xpath: string,
  ): Promise<number | null> {
    const doc = await send('DOM.getDocument', { depth: -1, pierce: true });
    const rootIds: number[] = [];
    this.collectRootNodeIds(doc?.root, rootIds);
    if (rootIds.length === 0) {
      this.log('info', 'CDP DOM walk: no roots collected from getDocument.');
      return null;
    }

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
          mainDoc.body.appendChild(holder);
          for (var c = 0; c < ctx.children.length; c++) {
            holder.appendChild(ctx.children[c].cloneNode(true));
          }
          var sq = relativize(xp);
          var sr = mainDoc.evaluate(sq, holder, null, 9, null);
          if (sr && sr.singleNodeValue) {
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
            return { __cdp_resolve__: 'clone-replay-failed' };
          }
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
        if (obj.subtype === 'null' || obj.type === 'undefined') continue;
        matchObjectId = obj.objectId;
        if (!matchObjectId) continue;

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
   * Walk the DOM tree collecting Document and ShadowRoot nodeIds.
   * Recurses into children, shadowRoots, and contentDocument.
   */
  private collectRootNodeIds(node: any, out: number[]): void {
    if (!node || typeof node !== 'object') return;
    if (node.nodeType === 9 && typeof node.nodeId === 'number') {
      out.push(node.nodeId);
    }
    if (Array.isArray(node.shadowRoots)) {
      for (const sr of node.shadowRoots) {
        if (sr && typeof sr.nodeId === 'number') out.push(sr.nodeId);
        this.collectRootNodeIds(sr, out);
      }
    }
    if (Array.isArray(node.children)) {
      for (const c of node.children) this.collectRootNodeIds(c, out);
    }
    if (node.contentDocument) this.collectRootNodeIds(node.contentDocument, out);
  }

  /**
   * Check if a target type is a DOM target (iframe or page).
   */
  private isDomTarget(type: string | undefined): boolean {
    return type === 'iframe' || type === 'page';
  }

  /**
   * Map the in-page IIFE's reason string onto our typed FatalReason enum.
   */
  private coerceFatalReason(s: string | undefined): 'disabled' | 'read-only' | 'covered' | 'no-match' | 'not-a-select' | 'unknown' {
    switch (s) {
      case 'disabled':
      case 'read-only':
      case 'covered':
      case 'no-match':
      case 'not-a-select':
        return s;
      default:
        return 'unknown';
    }
  }

  /**
   * CDP-resolve an element by XPath, scroll it into view, verify it's not
   * overlay-covered, and return its center coordinates. Used by click/hover
   * to share the scroll+hit-test logic.
   *
   * @returns `{ x, y, tag, name }` center coordinates in viewport space
   * @throws FatalActionError if the element is covered by another element
   */
  async cdpResolveAndVerify(
    send: (method: string, params?: Record<string, unknown>) => Promise<any>,
    xpath: string,
    action: 'click' | 'hover',
  ): Promise<{ x: number; y: number; tag?: string; name?: string }> {
    const nodeId = await this.cdpResolveXPath(send, xpath);
    if (!nodeId) {
      throw new Error(`No match found for '${xpath}' via CDP DOM walk.`);
    }

    // Scroll into view + overlay hit-test in a single callFunctionOn.
    const resolved = await send('DOM.resolveNode', { nodeId });
    const objectId = resolved?.object?.objectId;
    let checkRes: any = undefined;
    if (objectId) {
      try {
        checkRes = await send('Runtime.callFunctionOn', {
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
                  message: 'Cannot ${action} ' + tag + ident + ': covered by <' + topTag + '>',
                  tag: this.tagName,
                  name: this.name || this.id || '',
                };
              }
            } catch (e) {}
            return {
              ok: true,
              tag: this.tagName,
              name: this.name || this.id || '',
            };
          }`,
          returnByValue: true,
        });
        const out = checkRes?.result?.value as
          | { ok: boolean; fatal?: boolean; reason?: string; message?: string; tag?: string; name?: string }
          | undefined;
        if (out?.fatal) {
          const msg = out.message?.replace('${action}', action) ?? `Cannot ${action}: target is ${out.reason ?? 'rejected'}`;
          throw new FatalActionError(msg, this.coerceFatalReason(out.reason));
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
    return { x, y, tag: checkRes?.result?.value?.tag as string | undefined, name: checkRes?.result?.value?.name as string | undefined };
  }

  /**
   * CDP-resolve an element by XPath and call `.focus()` on it. Used by `press`
   * to focus an element before dispatching a keyboard event.
   */
  async cdpFocusElement(
    send: (method: string, params?: Record<string, unknown>) => Promise<any>,
    xpath: string,
  ): Promise<void> {
    const nodeId = await this.cdpResolveXPath(send, xpath);
    if (!nodeId) {
      throw new Error(`No match found for '${xpath}' via CDP DOM walk.`);
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
  }

  /**
   * CDP-resolve an element and return its metadata (tag, id, name, classes, text).
   * Used by the `describe` action for closed-shadow pierce.
   */
  async cdpDescribe(
    send: (method: string, params?: Record<string, unknown>) => Promise<any>,
    xpath: string,
  ): Promise<{ tag?: string; id?: string; name?: string; classes: string[]; text: string } | null> {
    const nodeId = await this.cdpResolveXPath(send, xpath);
    if (!nodeId) return null;

    const resolved = await send('DOM.resolveNode', { nodeId });
    const objectId = resolved?.object?.objectId;
    if (!objectId) return null;

    try {
      const res = await send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function () {
          var classes = [];
          if (this.className) {
            var s = typeof this.className === 'string'
              ? this.className
              : (this.className.baseVal || '');
            classes = s.split(/\\s+/).filter(Boolean);
          }
          var text = '';
          try { text = (this.innerText || this.textContent || '').trim(); } catch (e) {}
          if (text.length > 60) text = text.slice(0, 60) + '…';
          var out = {
            tag: this.tagName || '',
            classes: classes,
            text: text,
          };
          if (this.id) out.id = this.id;
          if (this.name) out.name = this.name;
          return out;
        }`,
        returnByValue: true,
      });
      return res?.result?.value as { tag?: string; id?: string; name?: string; classes: string[]; text: string } | undefined ?? null;
    } finally {
      await send('Runtime.releaseObject', { objectId }).catch(() => {});
    }
  }
}

/**
 * Thrown when the in-page function signals fatal:true. We use a typed error
 * so action handlers can distinguish "didn't find it, try CDP" from "found it
 * but the page state forbids the action."
 */
export class FatalActionError extends Error {
  readonly fatal = true as const;
  readonly reason: 'disabled' | 'read-only' | 'covered' | 'no-match' | 'not-a-select' | 'unknown';
  constructor(message: string, reason: 'disabled' | 'read-only' | 'covered' | 'no-match' | 'not-a-select' | 'unknown' = 'unknown') {
    super(message);
    this.name = 'FatalActionError';
    this.reason = reason;
  }
}

/**
 * Check if a DOM tree contains any closed shadow roots.
 * Recurses into children, shadowRoots, and contentDocument.
 */
export function anyClosedShadow(node: any): boolean {
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
