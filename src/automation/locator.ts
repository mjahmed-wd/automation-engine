/**
 * Locator → in-page JavaScript expression.
 *
 * Builds the IIFE that runs inside the page (via `Runtime.evaluate`) to find
 * an element and either return it, fill it, click it, or read a value from
 * it.
 *
 * The one and only locator type is `xpath`. Light DOM is queried via
 * `document.evaluate`; open shadow roots are walked and the XPath is
 * re-evaluated inside each one. Closed shadow roots are unreachable from
 * page JS — the CDP fallback (`DOM.performSearch`) covers those.
 *
 * Visibility filter: `fill` and `click` require the element to be on-screen
 * (non-zero box, not display:none, not visibility:hidden). `get` and `find`
 * don't, because reading a `<title>`, a `<meta>`, or a deliberately hidden
 * input is a normal use case.
 */

import type { Locator } from './schema';
import { strategyRegistry } from './strategies/index.js';

export type Mode = 'find' | 'fill' | 'click' | 'get' | 'hover';

export interface GetOptions {
  attribute?: string;
  property?: string;
  regex?: string;
  regexFlags?: string;
}

type BindMode = 'cdp' | 'fastpath';

/**
 * Replace {{ELEMENT}} placeholder in strategy action blocks.
 * For CDP path: replaced with 'this' (element is bound as function context)
 * For fast-path: replaced with 'el' (element is a local variable)
 */
function wrapActionBlock(actionBlock: string, bindMode: BindMode): string {
  const elementRef = bindMode === 'cdp' ? 'this' : 'el';
  return actionBlock.replace(/\{\{ELEMENT\}\}/g, elementRef);
}

/**
 * Build the value expression for the return value.
 * GetStrategy returns the extracted value directly, other modes return element value.
 */
function buildValueExpression(mode: Mode, opts: GetOptions, elementRef: string): string {
  if (mode === 'get' || mode === 'find') {
    // GetStrategy returns the value expression directly
    const strategy = strategyRegistry.get('get') as any;
    return strategy.buildActionBlock(opts).replace(/\{\{ELEMENT\}\}/g, elementRef);
  }
  // Other modes: return element value or text content
  return `('value' in ${elementRef} ? String(${elementRef}.value) : (${elementRef}.textContent || '').trim())`;
}

/** IIFE that resolves to the matched element or `null`. */
function buildFinderExpression(locator: Locator, requireVisible: boolean): string {
  const visibleFn = requireVisible
    ? `function visible(el) {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0
          && cs.visibility !== 'hidden'
          && cs.display !== 'none'
          && parseFloat(cs.opacity) > 0
          && cs.pointerEvents !== 'none';
      }`
    : `function visible(_el) { return true; }`;

  const xpLit = JSON.stringify(locator.xpath);

  return `(() => {
    ${visibleFn}
    function evalIn(root, xp) {
      try {
        const doc = root.ownerDocument || (root.nodeType === 9 ? root : document);
        const ctx = (root.nodeType === 9 || root.nodeType === 11) ? root : root;
        const res = doc.evaluate(xp, ctx, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        if (res && res.singleNodeValue) return res.singleNodeValue;
      } catch (e) {}
      return null;
    }
    function deepEval(root, xp) {
      const direct = evalIn(root, xp);
      if (direct) return direct;
      const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (let i = 0; i < all.length; i++) {
        const node = all[i];
        if (node.shadowRoot) {
          const hit = deepEval(node.shadowRoot, xp);
          if (hit) return hit;
        }
        // Same-origin <iframe>/<frame>: walk into its document. Cross-origin
        // throws or returns null; those iframes get handled by the CDP
        // child-session path.
        if (node.tagName === 'IFRAME' || node.tagName === 'FRAME') {
          try {
            const idoc = node.contentDocument;
            if (idoc) {
              const hit = deepEval(idoc, xp);
              if (hit) return hit;
            }
          } catch (e) {}
        }
      }
      return null;
    }
    const el = deepEval(document, ${xpLit});
    if (!el || !visible(el)) return null;
    return el;
  })()`;
}

/**
 * Build a `function () {...}` for `Runtime.callFunctionOn` — used by the CDP
 * fallback path where the element has already been resolved to a remote
 * object and is passed as `this`.
 */
export function buildCallFunctionExpression(
  mode: Mode,
  opts: { value?: string } & GetOptions = {},
): string {
  const strategy = strategyRegistry.get(mode);
  const actionBlock = wrapActionBlock(strategy.buildActionBlock(opts as any), 'cdp');
  const valueExpr = buildValueExpression(mode, opts, 'this');

  return `
    function () {
      ${actionBlock}
      const __value = ${valueExpr};
      return {
        ok: true,
        value: __value,
        frame: location.href,
        tag: this.tagName,
        name: this.name || this.id || '',
      };
    }
  `;
}

/**
 * Resolve an XPath to its viewport coordinates so the caller can dispatch a
 * trusted click via CDP `Input.dispatchMouseEvent`. Scrolls the element into
 * view first. Returns `isMain: true` only if the matched element lives in the
 * top-level frame — for iframe elements the coordinates are iframe-local and
 * don't map to the tab viewport.
 */
export function buildResolveExpression(locator: Locator): string {
  const xpLit = JSON.stringify(locator.xpath);
  return `(() => {
    function visible(el) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0
        && cs.visibility !== 'hidden'
        && cs.display !== 'none'
        && parseFloat(cs.opacity) > 0
        && cs.pointerEvents !== 'none';
    }
    function evalIn(root, xp) {
      try {
        const doc = root.ownerDocument || (root.nodeType === 9 ? root : document);
        const ctx = (root.nodeType === 9 || root.nodeType === 11) ? root : root;
        const res = doc.evaluate(xp, ctx, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        if (res && res.singleNodeValue) return res.singleNodeValue;
      } catch (e) {}
      return null;
    }
    function deepEval(root, xp) {
      const direct = evalIn(root, xp);
      if (direct) return direct;
      const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (let i = 0; i < all.length; i++) {
        const node = all[i];
        if (node.shadowRoot) {
          const hit = deepEval(node.shadowRoot, xp);
          if (hit) return hit;
        }
        if (node.tagName === 'IFRAME' || node.tagName === 'FRAME') {
          try {
            const idoc = node.contentDocument;
            if (idoc) {
              const hit = deepEval(idoc, xp);
              if (hit) return hit;
            }
          } catch (e) {}
        }
      }
      return null;
    }
    const el = deepEval(document, ${xpLit});
    if (!el) {
      return { ok: false, frame: location.href, inputs: document.querySelectorAll('input').length };
    }
    // DEBUG: log what element was found
    const _dbg = {
      tag: el.tagName,
      class: el.className,
      text: el.textContent?.substring(0, 50),
      xpath: ${xpLit}
    };
    console.log('[buildResolveExpression] found:', _dbg);
    if (!visible(el)) {
      return { ok: false, frame: location.href, inputs: document.querySelectorAll('input').length };
    }
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
    // Force layout recalculation to ensure fresh coordinates (react-select, MUI, etc.)
    el.offsetHeight;
    const r = el.getBoundingClientRect();
    const __cx = r.left + r.width / 2;
    const __cy = r.top + r.height / 2;
    // Overlay hit-test. elementsFromPoint returns elements at (cx,cy) front-to-back.
    // If the topmost element is el itself or a descendant of el (click bubbles
    // up), we're clear. Anything else means a sibling/overlay would absorb the
    // click — bail with fatal:true. Scoped to el.getRootNode() so closed-shadow
    // siblings get caught instead of just the shadow host.
    try {
      const __root = el.getRootNode();
      const __efp = (__root && typeof __root.elementsFromPoint === 'function'
        ? __root.elementsFromPoint(__cx, __cy)
        : document.elementsFromPoint(__cx, __cy));
      const __top = __efp && __efp[0];
      if (__top && !el.contains(__top)) {
        var __tag = el.tagName ? el.tagName.toLowerCase() : 'element';
        var __ident = el.name ? '[name="' + el.name + '"]' : (el.id ? '#' + el.id : '');
        var __topTag = __top.tagName ? __top.tagName.toLowerCase() : 'element';
        return {
          ok: false,
          fatal: true,
          reason: 'covered',
          message: 'Cannot click ' + __tag + __ident + ': covered by <' + __topTag + '>',
          frame: location.href,
          tag: el.tagName,
          name: el.name || el.id || '',
        };
      }
    } catch (e) {}
    return {
      ok: true,
      x: __cx,
      y: __cy,
      frame: location.href,
      tag: el.tagName,
      name: el.name || el.id || '',
      isMain: window === window.top,
      // DEBUG: include element details for troubleshooting
      _debug: {
        class: el.className,
        text: el.textContent?.substring(0, 30)
      }
    };
  })()`;
}

/**
 * IIFE for the `describe` action — enumerates every match across light DOM,
 * open shadow roots, and same-origin iframes. Returns `{matchCount, matches}`
 * where `matches` is capped at the first 5 (the count is exact). Closed
 * shadow roots are invisible to this; the CDP path in `page.describe`
 * handles those.
 *
 * Two correctness things baked in:
 *   - Per-root `document.evaluate` with `UNORDERED_NODE_SNAPSHOT_TYPE` so a
 *     single element can't be counted twice across the main doc + a shadow
 *     walk (each evaluation is scoped to its root).
 *   - SVG `className` is an `SVGAnimatedString`, not a string — we read
 *     `.baseVal` as a fallback so the IIFE doesn't crash on pages with
 *     SVG matches.
 */
export function buildDescribeExpression(locator: Locator): string {
  const xpLit = JSON.stringify(locator.xpath);
  return `(() => {
    function metadata(el, frame) {
      var classes = [];
      if (el.className) {
        var s = typeof el.className === 'string'
          ? el.className
          : (el.className.baseVal || '');
        classes = s.split(/\\s+/).filter(Boolean);
      }
      var text = '';
      try { text = (el.innerText || el.textContent || '').trim(); } catch (e) {}
      if (text.length > 60) text = text.slice(0, 60) + '…';
      var out = {
        frame: frame,
        tag: el.tagName || '',
        classes: classes,
        text: text,
      };
      if (el.id) out.id = el.id;
      if (el.name) out.name = el.name;
      return out;
    }
    function evalAll(root, xp) {
      try {
        var doc = root.ownerDocument || (root.nodeType === 9 ? root : document);
        var res = doc.evaluate(xp, root, null, XPathResult.UNORDERED_NODE_SNAPSHOT_TYPE, null);
        var out = [];
        for (var i = 0; i < res.snapshotLength; i++) {
          out.push(res.snapshotItem(i));
        }
        return out;
      } catch (e) { return []; }
    }
    function walkAll(root, xp, frame, matches) {
      var direct = evalAll(root, xp);
      for (var i = 0; i < direct.length; i++) {
        matches.push(metadata(direct[i], frame));
      }
      var all = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (var j = 0; j < all.length; j++) {
        var node = all[j];
        if (node.shadowRoot) {
          walkAll(node.shadowRoot, xp, frame + ' (shadow)', matches);
        }
        if (node.tagName === 'IFRAME' || node.tagName === 'FRAME') {
          try {
            var idoc = node.contentDocument;
            if (idoc) {
              var iframeUrl = (idoc.location && idoc.location.href) || (frame + ' (iframe)');
              walkAll(idoc, xp, iframeUrl, matches);
            }
          } catch (e) {}
        }
      }
    }
    var matches = [];
    walkAll(document, ${xpLit}, location.href, matches);
    return {
      matchCount: matches.length,
      matches: matches.slice(0, 5),
    };
  })()`;
}

export function buildActionExpression(
  locator: Locator,
  mode: Mode,
  opts: { value?: string } & GetOptions = {},
): string {
  // Reads should not be gated by visibility — page <title>, meta, hidden
  // inputs etc. are all legitimate read targets.
  const requireVisible = mode === 'fill' || mode === 'click' || mode === 'hover';
  const finder = buildFinderExpression(locator, requireVisible);

  const strategy = strategyRegistry.get(mode);
  const actionBlock = wrapActionBlock(strategy.buildActionBlock(opts as any), 'fastpath');
  const valueExpr = buildValueExpression(mode, opts, 'el');

  return `
    (() => {
      const el = ${finder};
      if (!el) {
        return {
          ok: false,
          frame: location.href,
          inputs: document.querySelectorAll('input').length,
        };
      }
      ${actionBlock}
      const __value = ${valueExpr};
      return {
        ok: true,
        value: __value,
        frame: location.href,
        tag: el.tagName,
        name: el.name || el.id || '',
      };
    })()
  `;
}
