/**
 * Build a fatal error result object for in-page IIFE.
 *
 * Returns a string that expands to inline code (no runtime function call).
 * The error object is serialized across CDP boundary to report action failures.
 *
 * @param reason - Short error reason code (e.g., 'disabled', 'covered', 'read-only')
 * @param message - Human-readable error message
 * @param elementRef - Element reference ('this' for CDP path, 'el' for fast-path)
 * @returns JavaScript code string representing the error object
 */
export function buildFatalError(
  reason: string,
  message: string,
  elementRef: string = 'this',
): string {
  return `{
    ok: false,
    fatal: true,
    reason: ${JSON.stringify(reason)},
    message: ${JSON.stringify(message)},
    frame: location.href,
    tag: ${elementRef}.tagName,
    name: ${elementRef}.name || ${elementRef}.id || '',
  }`;
}

/**
 * Build a non-fatal error result object for when no element is found.
 *
 * @returns JavaScript code string representing the not-found error object
 */
export function buildNotFoundError(): string {
  return `{
    ok: false,
    frame: location.href,
    inputs: document.querySelectorAll('input').length,
  }`;
}
