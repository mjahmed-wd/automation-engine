/**
 * Variable substitution for automation steps.
 */

import type { ExecutionContext, Locator } from './base';

/** Encode a runtime string as an XPath string literal.
 *  Exported for unit testing — the `concat()` branch is fiddly and worth
 *  pinning with a test. */
export function xpathStringLiteral(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  const parts = value.split("'");
  const tokens: string[] = [];
  parts.forEach((p, i) => {
    if (i > 0) tokens.push(`"'"`);
    if (p) tokens.push(`'${p}'`);
  });
  return `concat(${tokens.join(', ')})`;
}

/** Plain `{{var}}` substitution — for free-text fields (value, url). */
export function substituteRaw(str: string, ctx: ExecutionContext): string {
  return str.replace(/\{\{(\w+)\}\}/g, (_, name) => {
    if (name in ctx.outputs) return ctx.outputs[name];
    if (name in ctx.variables) return ctx.variables[name];
    return `{{${name}}}`;
  });
}

/**
 * XPath substitution. Accepts both shapes:
 *   `//input[@name={{n}}]`        — bare token, becomes a literal
 *   `//input[@name='{{n}}']`      — surrounding single quotes get stripped
 *   `//input[@name="{{n}}"]`      — surrounding double quotes get stripped
 */
export function substituteXPath(template: string, ctx: ExecutionContext): string {
  return template.replace(
    /(['"])?\{\{(\w+)\}\}\1?/g,
    function (match, _quote, name) {
      if (!(name in ctx.outputs) && !(name in ctx.variables)) return match;
      const value = String(ctx.outputs[name] ?? ctx.variables[name]);
      return xpathStringLiteral(value);
    },
  );
}

/** Back-compat alias for callers that imported the original. */
export const substitute = substituteRaw;

/** Build the locator object for a step, with XPath substitution applied. */
export function resolveLocator(
  step: { xpath?: string },
  ctx: ExecutionContext,
): Locator {
  if (!step.xpath) {
    throw new Error('Step requires "xpath"');
  }
  return { xpath: substituteXPath(step.xpath, ctx) };
}
