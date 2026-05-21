import type { ActionStrategy } from './action-strategy.js';

/**
 * Hover strategy requires no options.
 */
export interface HoverOptions {}

/**
 * Strategy for hovering over elements.
 *
 * Handles:
 * - Scroll into view
 * - Overlay hit-test (covered element detection)
 * - Full event sequence: pointerover → pointerenter → mouseover → mouseenter → pointermove → mousemove
 *
 * Note: Synthetic hover dispatch. JS hover handlers (mouseenter / pointerover
 * listeners) fire normally; CSS `:hover` does NOT — only a real cursor
 * move via Input.dispatchMouseEvent triggers it, which page.hover()'s
 * trusted path handles. This block is the iframe / synthetic-only fallback.
 */
export class HoverStrategy implements ActionStrategy<HoverOptions> {
  readonly mode = 'hover' as const;

  buildActionBlock(_opts: HoverOptions): string {
    // Mirror of the fast-path hover block in buildActionExpression. Currently
    // dead in page.hover() (which routes closed-shadow to cdpTrustedHover
    // rather than cdpFindAndAct), but kept in lockstep so the two paths
    // don't drift.
    return `
      {{ELEMENT}}.scrollIntoView({ block: 'center', inline: 'center' });
      const __r = {{ELEMENT}}.getBoundingClientRect();
      const __cx = __r.left + __r.width / 2;
      const __cy = __r.top + __r.height / 2;
      try {
        const __root = {{ELEMENT}}.getRootNode();
        const __efp = (__root && typeof __root.elementsFromPoint === 'function'
          ? __root.elementsFromPoint(__cx, __cy)
          : document.elementsFromPoint(__cx, __cy));
        const __top = __efp && __efp[0];
        if (__top && !{{ELEMENT}}.contains(__top)) {
          var __tag = {{ELEMENT}}.tagName ? {{ELEMENT}}.tagName.toLowerCase() : 'element';
          var __ident = {{ELEMENT}}.name ? '[name="' + {{ELEMENT}}.name + '"]' : ({{ELEMENT}}.id ? '#' + {{ELEMENT}}.id : '');
          var __topTag = __top.tagName ? __top.tagName.toLowerCase() : 'element';
          return {
            ok: false,
            fatal: true,
            reason: 'covered',
            message: 'Cannot hover ' + __tag + __ident + ': covered by <' + __topTag + '>',
            frame: location.href,
            tag: {{ELEMENT}}.tagName,
            name: {{ELEMENT}}.name || {{ELEMENT}}.id || '',
          };
        }
      } catch (e) {}
      const __opts = { bubbles: true, cancelable: true, composed: true, view: window, clientX: __cx, clientY: __cy };
      const __popts = Object.assign({}, __opts, { pointerType: 'mouse', pointerId: 1, isPrimary: true });
      const __dispatch = (Ctor, type, init) => { try { {{ELEMENT}}.dispatchEvent(new Ctor(type, init)); } catch (e) {} };
      __dispatch(PointerEvent, 'pointerover', __popts);
      __dispatch(PointerEvent, 'pointerenter', __popts);
      __dispatch(MouseEvent, 'mouseover', __opts);
      __dispatch(MouseEvent, 'mouseenter', __opts);
      __dispatch(PointerEvent, 'pointermove', __popts);
      __dispatch(MouseEvent, 'mousemove', __opts);
    `;
  }
}
