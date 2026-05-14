/**
 * Automation schema.
 *
 * One locator type: `xpath`. Iframes, open and closed shadow roots, and text
 * relations are all expressible in XPath, so we don't carry alternative
 * finders.
 *
 *   { "action": "fill",   "xpath": "//input[@name='email']", "value": "x@y.z" }
 *   { "action": "get",    "xpath": "//h1", "saveAs": "title" }
 *   { "action": "click",  "xpath": "//button[normalize-space(.)='Save']" }
 */

export interface Locator {
  xpath: string;
}

export interface BaseStep {
  action: string;
}

export interface GotoStep extends BaseStep {
  action: 'goto';
  url: string;
}

export interface FillStep extends BaseStep {
  action: 'fill';
  xpath: string;
  value: string;
  /** Skip the Runtime.evaluate fast path and go straight to the CDP DOM walk
   *  (needed for elements inside `attachShadow({mode:'closed'})` roots). */
  pierceClosed?: boolean;
  /** Cap how long the locator-search loop polls before failing. Default 20s. */
  timeoutMs?: number;
}

/**
 * `get` reads any value from the matched element: input value, text content,
 * an attribute, or a regex extract over any of those.
 *
 * Default property when neither `attribute` nor `property` is set:
 *   - `<input>` / `<textarea>` / `<select>`  → "value"
 *   - everything else                        → "innerText"
 *
 * `attribute` takes precedence over `property` if both are provided.
 * If `regex` matches, the first capture group is returned; otherwise the
 * full match. No match → empty string.
 */
export interface GetStep extends BaseStep {
  action: 'get';
  xpath: string;
  attribute?: string;
  property?: string;
  regex?: string;
  regexFlags?: string;
  saveAs?: string;
  pierceClosed?: boolean;
  /** Cap how long the locator-search loop polls before failing. Default 20s. */
  timeoutMs?: number;
}

export interface ClickStep extends BaseStep {
  action: 'click';
  xpath: string;
  pierceClosed?: boolean;
  /** Cap how long the locator-search loop polls before failing. Default 20s. */
  timeoutMs?: number;
}

export interface WaitStep extends BaseStep {
  action: 'wait';
  ms: number;
}

export interface WaitForStep extends BaseStep {
  action: 'waitFor';
  xpath: string;
  timeoutMs?: number;
  pierceClosed?: boolean;
}

/**
 * Dispatch a real keyboard event via CDP `Input.dispatchKeyEvent`. Used for
 * the case where a form is wired to `@keyup.enter` on an input (Vue
 * convention when there's no `<form>` wrapper), so clicking the visible
 * submit button is a no-op and the only way to submit is to press Enter
 * with the input focused.
 *
 * `xpath` is optional — if provided, the element is focused before the
 * keystroke; if omitted, the keystroke goes to whatever has focus already
 * (typically the input most recently `fill`ed).
 */
export interface PressStep extends BaseStep {
  action: 'press';
  xpath?: string;
  key: string;
  pierceClosed?: boolean;
}

/**
 * Inject files into a real `<input type="file">` via CDP
 * `DOM.setFileInputFiles`. There's no page-JS equivalent — `input.files` is
 * read-only and synthetic clicks can't open the native OS picker. This is the
 * only path that actually works.
 *
 * Requirements:
 *   - `xpath` must resolve to a real `<input type="file">`, not a styled
 *     wrapper button. Many sites hide the real input and surface a "Choose
 *     file" button instead — target the input directly (often
 *     `position:absolute; opacity:0`).
 *   - `files` must be **absolute** local paths on the machine running Chrome.
 *     Relative paths get resolved against an unpredictable cwd; we reject
 *     them up-front rather than fail silently in the browser.
 *
 *   { "action": "upload", "xpath": "//input[@type='file']", "files": "/Users/me/sample.csv" }
 */
export interface UploadStep extends BaseStep {
  action: 'upload';
  xpath: string;
  files: string | string[];
  /** Accepted for parity; `cdpResolveXPath` already pierces closed shadow. */
  pierceClosed?: boolean;
  /** How long to poll for the file input to appear in the DOM. Default 20s. */
  timeoutMs?: number;
}

/**
 * Escape hatch for arbitrary JS evaluation in the main frame. Runs the
 * expression via `Runtime.evaluate` with `returnByValue:true` + `awaitPromise:true`,
 * so:
 *   - Expressions return their value (e.g. `document.title`).
 *   - Promises are awaited (e.g. `(async () => await fetch('/x').then(r => r.json()))()`).
 *   - Multiple statements need to be wrapped in an IIFE — `Runtime.evaluate` is
 *     script-mode, so a bare `var x = 5; x` returns undefined; write
 *     `(() => { var x = 5; return x; })()` instead.
 *
 * The returned value is JSON-serialized into `ctx.outputs[saveAs]`. Null /
 * undefined become "", numbers / booleans get `String()`, objects / arrays
 * get `JSON.stringify()`.
 *
 * Frame: main frame only in this iteration. For same-origin iframes, reach
 * across in your expression (`document.querySelector('iframe').contentWindow.…`).
 */
export interface EvaluateStep extends BaseStep {
  action: 'evaluate';
  expression: string;
  saveAs?: string;
  /** Server-side timeout for `awaitPromise` cases. Omit for no timeout. */
  timeoutMs?: number;
}

export type AutomationStep =
  | GotoStep
  | FillStep
  | GetStep
  | ClickStep
  | WaitStep
  | WaitForStep
  | PressStep
  | EvaluateStep
  | UploadStep;

/** Tag identifies which sidepanel tab a script's example belongs in. */
export type AutomationTag = 'action' | 'get';

export interface AutomationScript {
  name: string;
  description?: string;
  tag?: AutomationTag;
  variables?: Record<string, string>;
  steps: AutomationStep[];
}

export type LogLevel = 'info' | 'success' | 'error';
export type LogFn = (level: LogLevel, message: string) => void;

export interface ExecutionContext {
  variables: Record<string, string>;
  outputs: Record<string, string>;
  log: LogFn;
}

// -------------------------------------------------------------------------
// Substitution
// -------------------------------------------------------------------------

/** Encode a runtime string as an XPath string literal. */
function xpathStringLiteral(value: string): string {
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
