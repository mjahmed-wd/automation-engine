import type { ActionStrategy } from './action-strategy.js';

/**
 * Click strategy requires no options.
 */
export interface ClickOptions {}

/**
 * Strategy for clicking elements.
 *
 * Handles:
 * - Scroll into view
 * - Overlay hit-test (covered element detection)
 * - Full event sequence: pointerdown → mousedown → focus → pointerup → mouseup → click
 */
export class ClickStrategy implements ActionStrategy<ClickOptions> {
  readonly mode = 'click' as const;

  buildActionBlock(_opts: ClickOptions): string {
    // Mirror of buildActionExpression's overlay hit-test. Currently dead in
    // page.click() (which routes closed-shadow to cdpTrustedClick instead of
    // cdpFindAndAct), but kept in lockstep so a future regression doesn't
    // drift behavior between fast and CDP paths.
    return `
      {{ELEMENT}}.scrollIntoView({ block: 'center', inline: 'center' });
      {{ELEMENT}}.offsetHeight; // Force layout recalculation
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
            message: 'Cannot click ' + __tag + __ident + ': covered by <' + __topTag + '>',
            frame: location.href,
            tag: {{ELEMENT}}.tagName,
            name: {{ELEMENT}}.name || {{ELEMENT}}.id || '',
          };
        }
      } catch (e) {}
      const __opts = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, clientX: __cx, clientY: __cy };
      const __popts = Object.assign({}, __opts, { pointerType: 'mouse', pointerId: 1, isPrimary: true });
      const __dispatch = (Ctor, type, init) => { try { {{ELEMENT}}.dispatchEvent(new Ctor(type, init)); } catch (e) {} };
      __dispatch(PointerEvent, 'pointerdown', __popts);
      __dispatch(MouseEvent, 'mousedown', __opts);
      try { if (typeof {{ELEMENT}}.focus === 'function') {{ELEMENT}}.focus(); } catch (e) {}
      __dispatch(PointerEvent, 'pointerup', __popts);
      __dispatch(MouseEvent, 'mouseup', __opts);
      __dispatch(MouseEvent, 'click', __opts);
    `;
  }
}
