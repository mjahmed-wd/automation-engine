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

export type Mode = 'find' | 'fill' | 'click' | 'get';

export interface GetOptions {
  attribute?: string;
  property?: string;
  regex?: string;
  regexFlags?: string;
}

/** IIFE that resolves to the matched element or `null`. */
function buildFinderExpression(locator: Locator, requireVisible: boolean): string {
  const visibleFn = requireVisible
    ? `function visible(el) {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
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
  let actionBlock = '';
  if (mode === 'fill') {
    const valueLiteral = JSON.stringify(opts.value ?? '');
    actionBlock = `
      this.focus();
      const proto = Object.getPrototypeOf(this);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      const setter = desc && desc.set;
      if (setter) setter.call(this, ${valueLiteral});
      else this.value = ${valueLiteral};
      this.dispatchEvent(new Event('input', { bubbles: true }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
    `;
  } else if (mode === 'click') {
    actionBlock = `
      this.scrollIntoView({ block: 'center', inline: 'center' });
      const __r = this.getBoundingClientRect();
      const __cx = __r.left + __r.width / 2;
      const __cy = __r.top + __r.height / 2;
      const __opts = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, clientX: __cx, clientY: __cy };
      const __popts = Object.assign({}, __opts, { pointerType: 'mouse', pointerId: 1, isPrimary: true });
      const __dispatch = (Ctor, type, init) => { try { this.dispatchEvent(new Ctor(type, init)); } catch (e) {} };
      __dispatch(PointerEvent, 'pointerdown', __popts);
      __dispatch(MouseEvent, 'mousedown', __opts);
      try { if (typeof this.focus === 'function') this.focus(); } catch (e) {}
      __dispatch(PointerEvent, 'pointerup', __popts);
      __dispatch(MouseEvent, 'mouseup', __opts);
      __dispatch(MouseEvent, 'click', __opts);
    `;
  }

  let valueExpr: string;
  if (mode === 'get') {
    const attrLit = JSON.stringify(opts.attribute ?? '');
    const propLit = JSON.stringify(opts.property ?? '');
    const regexLit = JSON.stringify(opts.regex ?? '');
    const flagsLit = JSON.stringify(opts.regexFlags ?? '');
    valueExpr = `(() => {
      const ATTR = ${attrLit};
      const PROP = ${propLit};
      const RX = ${regexLit};
      const FLAGS = ${flagsLit};
      let raw;
      if (ATTR) {
        raw = this.getAttribute(ATTR);
        if (raw == null) raw = '';
      } else {
        let p = PROP;
        if (!p) {
          const t = this.tagName;
          p = (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') ? 'value' : 'innerText';
        }
        const v = this[p];
        raw = v == null ? '' : (typeof v === 'string' ? v : String(v));
      }
      if (RX) {
        try {
          const m = raw.match(new RegExp(RX, FLAGS));
          if (!m) return '';
          return m.length > 1 ? (m[1] ?? '') : m[0];
        } catch (e) {
          throw new Error('Bad regex: ' + e.message);
        }
      }
      return raw;
    }).call(this)`;
  } else {
    valueExpr = `('value' in this ? String(this.value) : (this.textContent || '').trim())`;
  }

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
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
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
    if (!visible(el)) {
      return { ok: false, frame: location.href, inputs: document.querySelectorAll('input').length };
    }
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
    const r = el.getBoundingClientRect();
    return {
      ok: true,
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      frame: location.href,
      tag: el.tagName,
      name: el.name || el.id || '',
      isMain: window === window.top,
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
  const requireVisible = mode === 'fill' || mode === 'click';
  const finder = buildFinderExpression(locator, requireVisible);

  let actionBlock = '';
  if (mode === 'fill') {
    const valueLiteral = JSON.stringify(opts.value ?? '');
    actionBlock = `
      el.focus();
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      const setter = desc && desc.set;
      if (setter) setter.call(el, ${valueLiteral});
      else el.value = ${valueLiteral};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    `;
  } else if (mode === 'click') {
    actionBlock = `
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const __r = el.getBoundingClientRect();
      const __cx = __r.left + __r.width / 2;
      const __cy = __r.top + __r.height / 2;
      const __opts = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, clientX: __cx, clientY: __cy };
      const __popts = Object.assign({}, __opts, { pointerType: 'mouse', pointerId: 1, isPrimary: true });
      const __dispatch = (Ctor, type, init) => { try { el.dispatchEvent(new Ctor(type, init)); } catch (e) {} };
      __dispatch(PointerEvent, 'pointerdown', __popts);
      __dispatch(MouseEvent, 'mousedown', __opts);
      try { if (typeof el.focus === 'function') el.focus(); } catch (e) {}
      __dispatch(PointerEvent, 'pointerup', __popts);
      __dispatch(MouseEvent, 'mouseup', __opts);
      __dispatch(MouseEvent, 'click', __opts);
    `;
  }

  let valueExpr: string;
  if (mode === 'get') {
    const attrLit = JSON.stringify(opts.attribute ?? '');
    const propLit = JSON.stringify(opts.property ?? '');
    const regexLit = JSON.stringify(opts.regex ?? '');
    const flagsLit = JSON.stringify(opts.regexFlags ?? '');
    valueExpr = `(() => {
      const ATTR = ${attrLit};
      const PROP = ${propLit};
      const RX = ${regexLit};
      const FLAGS = ${flagsLit};
      let raw;
      if (ATTR) {
        raw = el.getAttribute(ATTR);
        if (raw == null) raw = '';
      } else {
        let p = PROP;
        if (!p) {
          const t = el.tagName;
          p = (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') ? 'value' : 'innerText';
        }
        const v = el[p];
        raw = v == null ? '' : (typeof v === 'string' ? v : String(v));
      }
      if (RX) {
        try {
          const m = raw.match(new RegExp(RX, FLAGS));
          if (!m) return '';
          return m.length > 1 ? (m[1] ?? '') : m[0];
        } catch (e) {
          throw new Error('Bad regex: ' + e.message);
        }
      }
      return raw;
    })()`;
  } else {
    valueExpr = `('value' in el ? String(el.value) : (el.textContent || '').trim())`;
  }

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
