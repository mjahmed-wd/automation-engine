/**
 * Serialization utilities for CDP results.
 */

/**
 * Coerce a Runtime.evaluate result into a string for `ctx.outputs` storage.
 * Outputs are `Record<string, string>`, so non-string values need a stable
 * representation. JSON.stringify covers objects / arrays; we strip null /
 * undefined to empty so a downstream `{{var}}` substitution doesn't render
 * literal "null".
 */
export function serializeEvalResult(value: unknown): string {
  if (value == null) return '';
  const t = typeof value;
  if (t === 'string') return value as string;
  if (t === 'number' || t === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
