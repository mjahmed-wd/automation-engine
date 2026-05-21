import type { ActionStrategy } from './action-strategy.js';

/**
 * Options for the get strategy.
 */
export interface GetOptions {
  /** Read an attribute instead of a property */
  attribute?: string;
  /** Read a specific property (defaults to 'value' for inputs, 'innerText' for others) */
  property?: string;
  /** Extract matching portion via regex */
  regex?: string;
  /** Flags for regex (e.g., 'i', 'g') */
  regexFlags?: string;
}

/**
 * Strategy for getting values from elements.
 *
 * Handles:
 * - Attribute reading (getAttribute)
 * - Property reading with defaults (value for inputs, innerText for others)
 * - Regex extraction with optional capture groups
 * - Null safety (empty string for null/undefined values)
 */
export class GetStrategy implements ActionStrategy<GetOptions> {
  readonly mode = 'get' as const;

  buildActionBlock(opts: GetOptions): string {
    const attrLit = JSON.stringify(opts.attribute ?? '');
    const propLit = JSON.stringify(opts.property ?? '');
    const regexLit = JSON.stringify(opts.regex ?? '');
    const flagsLit = JSON.stringify(opts.regexFlags ?? '');

    // Get mode has no action block — it only defines the value expression
    // The actual return happens in the wrapper function
    return this.buildValueExpression(attrLit, propLit, regexLit, flagsLit);
  }

  private buildValueExpression(
    attrLit: string,
    propLit: string,
    regexLit: string,
    flagsLit: string,
  ): string {
    return `(() => {
      const ATTR = ${attrLit};
      const PROP = ${propLit};
      const RX = ${regexLit};
      const FLAGS = ${flagsLit};
      let raw;
      if (ATTR) {
        raw = {{ELEMENT}}.getAttribute(ATTR);
        if (raw == null) raw = '';
      } else {
        let p = PROP;
        if (!p) {
          const t = {{ELEMENT}}.tagName;
          p = (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') ? 'value' : 'innerText';
        }
        const v = {{ELEMENT}}[p];
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
    }).call({{ELEMENT}})`;
  }
}
