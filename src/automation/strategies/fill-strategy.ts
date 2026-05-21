import type { ActionStrategy } from './action-strategy.js';

/**
 * Options for the fill strategy.
 */
export interface FillOptions {
  /** The value to fill into the input */
  value: string;
}

/**
 * Strategy for filling input fields and content-editable elements.
 *
 * Handles:
 * - Regular inputs (focus + value setter + input/change events)
 * - ContentEditable elements (select all + execCommand + beforeinput fallback)
 * - Disabled/read-only rejection (fatal error to prevent polling waste)
 */
export class FillStrategy implements ActionStrategy<FillOptions> {
  readonly mode = 'fill' as const;

  buildActionBlock(opts: FillOptions): string {
    const valueLiteral = JSON.stringify(opts.value);

    // Reject disabled / readOnly inputs with fatal:true. The runUntilFound
    // loop will throw immediately rather than poll for 20s waiting for a
    // state change that, in practice, only ever flips when the user does
    // something else first.
    return `
      if ({{ELEMENT}}.disabled || {{ELEMENT}}.readOnly) {
        var __tag = {{ELEMENT}}.tagName ? {{ELEMENT}}.tagName.toLowerCase() : 'element';
        var __ident = {{ELEMENT}}.name ? '[name="' + {{ELEMENT}}.name + '"]' : ({{ELEMENT}}.id ? '#' + {{ELEMENT}}.id : '');
        var __why = {{ELEMENT}}.disabled ? 'disabled' : 'read-only';
        return {
          ok: false,
          fatal: true,
          reason: __why,
          message: 'Cannot fill ' + __tag + __ident + ': it is ' + __why,
          frame: location.href,
          tag: {{ELEMENT}}.tagName,
          name: {{ELEMENT}}.name || {{ELEMENT}}.id || '',
        };
      }
      if ({{ELEMENT}}.isContentEditable) {
        // Contenteditable branch: select all existing content, then try
        // execCommand('insertText') (plain contenteditable) with a beforeinput
        // fallback (Lexical / ProseMirror / Slate). composed:true so the
        // beforeinput escapes shadow roots up to the framework's listener.
        {{ELEMENT}}.focus();
        try {
          var __view = {{ELEMENT}}.ownerDocument && {{ELEMENT}}.ownerDocument.defaultView;
          var __sel = __view ? __view.getSelection() : null;
          if (__sel) {
            var __range = {{ELEMENT}}.ownerDocument.createRange();
            __range.selectNodeContents({{ELEMENT}});
            __sel.removeAllRanges();
            __sel.addRange(__range);
          }
        } catch (e) {}
        var __ok = false;
        try {
          __ok = {{ELEMENT}}.ownerDocument.execCommand('insertText', false, ${valueLiteral});
        } catch (e) {}
        if (!__ok) {
          try {
            {{ELEMENT}}.dispatchEvent(new InputEvent('beforeinput', {
              inputType: 'insertText',
              data: ${valueLiteral},
              bubbles: true,
              cancelable: true,
              composed: true,
            }));
          } catch (e) {}
        }
        {{ELEMENT}}.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        {{ELEMENT}}.focus();
        const proto = Object.getPrototypeOf({{ELEMENT}});
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        const setter = desc && desc.set;
        if (setter) setter.call({{ELEMENT}}, ${valueLiteral});
        else {{ELEMENT}}.value = ${valueLiteral};
        {{ELEMENT}}.dispatchEvent(new Event('input', { bubbles: true }));
        {{ELEMENT}}.dispatchEvent(new Event('change', { bubbles: true }));
      }
    `;
  }
}
