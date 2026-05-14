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
  let actionBlock = '';
  if (mode === 'fill') {
    const valueLiteral = JSON.stringify(opts.value ?? '');
    // Reject disabled / readOnly inputs with fatal:true. The runUntilFound
    // loop will throw immediately rather than poll for 20s waiting for a
    // state change that, in practice, only ever flips when the user does
    // something else first.
    actionBlock = `
      if (this.disabled || this.readOnly) {
        var __tag = this.tagName ? this.tagName.toLowerCase() : 'element';
        var __ident = this.name ? '[name="' + this.name + '"]' : (this.id ? '#' + this.id : '');
        var __why = this.disabled ? 'disabled' : 'read-only';
        return {
          ok: false,
          fatal: true,
          reason: __why,
          message: 'Cannot fill ' + __tag + __ident + ': it is ' + __why,
          frame: location.href,
          tag: this.tagName,
          name: this.name || this.id || '',
        };
      }
      if (this.isContentEditable) {
        // Contenteditable branch: select all existing content, then try
        // execCommand('insertText') (plain contenteditable) with a beforeinput
        // fallback (Lexical / ProseMirror / Slate). composed:true so the
        // beforeinput escapes shadow roots up to the framework's listener.
        this.focus();
        try {
          var __view = this.ownerDocument && this.ownerDocument.defaultView;
          var __sel = __view ? __view.getSelection() : null;
          if (__sel) {
            var __range = this.ownerDocument.createRange();
            __range.selectNodeContents(this);
            __sel.removeAllRanges();
            __sel.addRange(__range);
          }
        } catch (e) {}
        var __ok = false;
        try {
          __ok = this.ownerDocument.execCommand('insertText', false, ${valueLiteral});
        } catch (e) {}
        if (!__ok) {
          try {
            this.dispatchEvent(new InputEvent('beforeinput', {
              inputType: 'insertText',
              data: ${valueLiteral},
              bubbles: true,
              cancelable: true,
              composed: true,
            }));
          } catch (e) {}
        }
        this.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        this.focus();
        const proto = Object.getPrototypeOf(this);
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        const setter = desc && desc.set;
        if (setter) setter.call(this, ${valueLiteral});
        else this.value = ${valueLiteral};
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
      }
    `;
  } else if (mode === 'click') {
    actionBlock = `
      this.scrollIntoView({ block: 'center', inline: 'center' });
      const __r = this.getBoundingClientRect();
      const __cx = __r.left + __r.width / 2;
      const __cy = __r.top + __r.height / 2;
      // Mirror of buildActionExpression's overlay hit-test. Currently dead in
      // page.click() (which routes closed-shadow to cdpTrustedClick instead of
      // cdpFindAndAct), but kept in lockstep so a future regression doesn't
      // drift behavior between fast and CDP paths.
      try {
        const __root = this.getRootNode();
        const __efp = (__root && typeof __root.elementsFromPoint === 'function'
          ? __root.elementsFromPoint(__cx, __cy)
          : document.elementsFromPoint(__cx, __cy));
        const __top = __efp && __efp[0];
        if (__top && !this.contains(__top)) {
          var __tag = this.tagName ? this.tagName.toLowerCase() : 'element';
          var __ident = this.name ? '[name="' + this.name + '"]' : (this.id ? '#' + this.id : '');
          var __topTag = __top.tagName ? __top.tagName.toLowerCase() : 'element';
          return {
            ok: false,
            fatal: true,
            reason: 'covered',
            message: 'Cannot click ' + __tag + __ident + ': covered by <' + __topTag + '>',
            frame: location.href,
            tag: this.tagName,
            name: this.name || this.id || '',
          };
        }
      } catch (e) {}
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
    if (!visible(el)) {
      return { ok: false, frame: location.href, inputs: document.querySelectorAll('input').length };
    }
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
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
    // Mirror of the CDP path's disabled/readOnly guard in
    // buildCallFunctionExpression — keep these two blocks in lockstep.
    actionBlock = `
      if (el.disabled || el.readOnly) {
        var __tag = el.tagName ? el.tagName.toLowerCase() : 'element';
        var __ident = el.name ? '[name="' + el.name + '"]' : (el.id ? '#' + el.id : '');
        var __why = el.disabled ? 'disabled' : 'read-only';
        return {
          ok: false,
          fatal: true,
          reason: __why,
          message: 'Cannot fill ' + __tag + __ident + ': it is ' + __why,
          frame: location.href,
          tag: el.tagName,
          name: el.name || el.id || '',
        };
      }
      if (el.isContentEditable) {
        // Mirror of the CDP path's contenteditable branch in
        // buildCallFunctionExpression — keep these two in lockstep.
        el.focus();
        try {
          var __view = el.ownerDocument && el.ownerDocument.defaultView;
          var __sel = __view ? __view.getSelection() : null;
          if (__sel) {
            var __range = el.ownerDocument.createRange();
            __range.selectNodeContents(el);
            __sel.removeAllRanges();
            __sel.addRange(__range);
          }
        } catch (e) {}
        var __ok = false;
        try {
          __ok = el.ownerDocument.execCommand('insertText', false, ${valueLiteral});
        } catch (e) {}
        if (!__ok) {
          try {
            el.dispatchEvent(new InputEvent('beforeinput', {
              inputType: 'insertText',
              data: ${valueLiteral},
              bubbles: true,
              cancelable: true,
              composed: true,
            }));
          } catch (e) {}
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        el.focus();
        const proto = Object.getPrototypeOf(el);
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        const setter = desc && desc.set;
        if (setter) setter.call(el, ${valueLiteral});
        else el.value = ${valueLiteral};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    `;
  } else if (mode === 'click') {
    actionBlock = `
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const __r = el.getBoundingClientRect();
      const __cx = __r.left + __r.width / 2;
      const __cy = __r.top + __r.height / 2;
      // Overlay hit-test — see buildResolveExpression for the rationale.
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
