/**
 * Locator → in-page JavaScript expression.
 *
 * `buildActionExpression` produces a self-contained expression that:
 *   1. Finds an element by selector or label.
 *   2. Optionally performs an action (fill / click) or extracts a value (get).
 *   3. Returns { ok, value, frame, name, tag } or { ok: false, frame, inputs }.
 *
 * Visibility filter: `fill` and `click` require the element to be on-screen
 * (non-zero box, not display:none, not visibility:hidden). `get` and `find`
 * don't, because reading a <title>, a <meta>, or a deliberately hidden input
 * is a normal use case.
 *
 * Shadow DOM (open): the finder pierces shadow roots in two ways.
 *   • Auto-traversal — `selector: "input[name=email]"` will recurse into every
 *     open shadow root after failing in the light DOM.
 *   • Explicit hops — `selector: "x-card >>> x-form >>> input"` walks segments
 *     one at a time, calling `.shadowRoot.querySelector()` between each `>>>`.
 *
 * Closed shadow roots (e.g. native `<input type="date">` internals) are not
 * reachable from page JS and remain inaccessible.
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

  // Helpers shared between selector- and label-based finders.
  const helpers = `
    ${visibleFn}
    function deepQuery(root, sel) {
      const direct = root.querySelector(sel);
      if (direct) return direct;
      const all = root.querySelectorAll('*');
      for (let i = 0; i < all.length; i++) {
        const sr = all[i].shadowRoot;
        if (sr) {
          const hit = deepQuery(sr, sel);
          if (hit) return hit;
        }
      }
      return null;
    }
    function deepQueryAll(root, sel) {
      const out = [];
      (function walk(node) {
        const direct = node.querySelectorAll(sel);
        for (let i = 0; i < direct.length; i++) out.push(direct[i]);
        const all = node.querySelectorAll('*');
        for (let i = 0; i < all.length; i++) {
          const sr = all[i].shadowRoot;
          if (sr) walk(sr);
        }
      })(root);
      return out;
    }
    function pierceSelector(sel) {
      if (sel.indexOf('>>>') !== -1) {
        // Explicit hop-by-hop piercing — each segment runs against the
        // previous element's shadowRoot.
        const parts = sel.split('>>>').map(function (s) { return s.trim(); }).filter(Boolean);
        if (parts.length === 0) return null;
        let scope = document;
        for (let i = 0; i < parts.length; i++) {
          const el = scope.querySelector(parts[i]);
          if (!el) return null;
          if (i === parts.length - 1) return el;
          if (!el.shadowRoot) return null;
          scope = el.shadowRoot;
        }
        return null;
      }
      // Auto-pierce: try light DOM first, then descend into every open shadow root.
      return deepQuery(document, sel);
    }
    /** getElementById that respects the element's owning root (light DOM or shadow). */
    function ownerGetElementById(label, id) {
      const root = label.getRootNode();
      if (root && typeof root.getElementById === 'function') return root.getElementById(id);
      return document.getElementById(id);
    }
  `;

  // ---- XPath path ----
  // document.evaluate handles the light DOM. For open shadow roots we walk
  // every shadowRoot and evaluate XPath scoped to it. Closed shadow roots
  // are unreachable here; the CDP path (DOM.performSearch) handles those.
  if (locator.xpath) {
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
          if (all[i].shadowRoot) {
            const hit = deepEval(all[i].shadowRoot, xp);
            if (hit) return hit;
          }
        }
        return null;
      }
      const el = deepEval(document, ${xpLit});
      if (!el || !visible(el)) return null;
      return el;
    })()`;
  }

  if (locator.selector) {
    const selLiteral = JSON.stringify(locator.selector);

    // When `nearText` is also set, refine: find all elements (light + open
    // shadow) whose direct text matches; then look in each one's parent chain
    // for an element matching `selector`. First match wins.
    if (locator.nearText) {
      const txtLiteral = JSON.stringify(locator.nearText);
      return `(() => {
        ${helpers}
        const SEL = ${selLiteral};
        const re = new RegExp(${txtLiteral}.trim().replace(/\\s+/g, '\\\\s*'), 'i');
        function directText(el) {
          let t = '';
          for (let i = 0; i < el.childNodes.length; i++) {
            const c = el.childNodes[i];
            if (c.nodeType === 3) t += c.nodeValue || '';
          }
          return t;
        }
        function collectStarts(root, out) {
          const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
          for (let i = 0; i < all.length; i++) {
            const el = all[i];
            if (re.test(directText(el))) out.push(el);
            if (el.shadowRoot) collectStarts(el.shadowRoot, out);
          }
        }
        const starts = [];
        collectStarts(document, starts);
        for (let s = 0; s < starts.length; s++) {
          let el = starts[s];
          for (let d = 0; d < 6 && el; d++) {
            const parent = el.parentElement || (el.getRootNode && el.getRootNode().host);
            if (!parent) break;
            const hit = parent.querySelector(SEL);
            if (hit && visible(hit)) return hit;
            el = parent;
          }
        }
        return null;
      })()`;
    }

    return `(() => {
      ${helpers}
      const el = pierceSelector(${selLiteral});
      if (!el) return null;
      if (!visible(el)) return null;
      return el;
    })()`;
  }
  if (locator.label) {
    const labelLiteral = JSON.stringify(locator.label);
    return `(() => {
      ${helpers}
      const TARGET = ${labelLiteral};
      const re = new RegExp(TARGET.trim().replace(/\\s+/g, '\\\\s*'), 'i');
      const firstWord = (TARGET.match(/[A-Za-z0-9]+/) || [''])[0].toLowerCase();

      // 1) <label>…First Name…</label> → htmlFor / nested input. Walks shadow roots too.
      const labels = deepQueryAll(document, 'label');
      for (let i = 0; i < labels.length; i++) {
        const label = labels[i];
        if (!re.test(label.textContent || '')) continue;
        if (label.htmlFor) {
          const el = ownerGetElementById(label, label.htmlFor);
          if (el && visible(el)) return el;
        }
        const nested = label.querySelector('input:not([type="hidden"]), textarea, select, button');
        if (nested && visible(nested)) return nested;
      }

      // 2) Attribute hints — name / id / aria-label / placeholder contains the first word.
      if (firstWord) {
        const selectors = [
          'input[name*="' + firstWord + '" i]:not([type="hidden"])',
          'input[id*="' + firstWord + '" i]:not([type="hidden"])',
          'input[aria-label*="' + firstWord + '" i]:not([type="hidden"])',
          'input[placeholder*="' + firstWord + '" i]:not([type="hidden"])',
          '[role="textbox"][aria-label*="' + firstWord + '" i]',
        ];
        for (let s = 0; s < selectors.length; s++) {
          const cand = deepQueryAll(document, selectors[s]);
          for (let i = 0; i < cand.length; i++) {
            if (visible(cand[i])) return cand[i];
          }
        }
      }

      // 3) Surrounding-container text fallback.
      const inputs = deepQueryAll(document, 'input:not([type="hidden"]), textarea');
      for (let i = 0; i < inputs.length; i++) {
        const input = inputs[i];
        if (!visible(input)) continue;
        const around = input.closest('label, .form-group, .field, fieldset, .tempFrmWrapper') || input.parentElement;
        if (around && re.test(around.textContent || '')) return input;
      }
      return null;
    })()`;
  }
  return 'null';
}

/**
 * Same action logic as `buildActionExpression`, but shaped as a `function () {...}`
 * suitable for CDP's `Runtime.callFunctionOn`. The function's `this` is the
 * already-resolved DOM element (returned by `DOM.resolveNode`), so no in-page
 * finder runs. This is what the closed-shadow-DOM fallback path uses.
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
      if (typeof this.click === 'function') this.click();
      else this.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
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
      if (typeof el.click === 'function') el.click();
      else el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
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
