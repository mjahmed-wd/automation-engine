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

  if (locator.selector) {
    const selLiteral = JSON.stringify(locator.selector);
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
