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

/**
 * Retry fields (Phase 5 Batch 2) — mixed into every locator-using step.
 *
 * Why a mixin rather than fields on `BaseStep`: not every step is retry-eligible.
 * `wait` is a pure sleep (nothing to retry), `goto` and `dialog` are one-shot
 * navigation/arming. Keeping the fields out of those interfaces makes typos
 * (`{"action":"wait","ms":100,"retries":3}`) catch at parse time.
 *
 * Retry semantics:
 *   - `retries` is the number of ADDITIONAL attempts after the first. Total
 *     attempts = retries + 1. Default 0 (current single-attempt behavior).
 *   - `retryDelay` is milliseconds between attempts. Default 500.
 *   - `FatalActionError` with reason `'disabled'`, `'read-only'`, `'no-match'`,
 *     `'not-a-select'`, or `'unknown'` DOES NOT retry — those states won't
 *     fix themselves.
 *   - `FatalActionError` with reason `'covered'` DOES retry by default —
 *     toast banners, loading spinners, and modal scrims routinely self-dismiss.
 *   - Validator caps `retries` at 5 to prevent runaway scripts (worst-case
 *     time per step ~= (retries+1) × timeoutMs + retries × retryDelay).
 */
export interface RetryFields {
  retries?: number;
  retryDelay?: number;
}

/**
 * Navigate the active tab. The default behavior waits for `tabs.onUpdated`
 * to report `'complete'` — but on modern SPAs that fires when the HTML
 * shell loads, not when the framework has mounted the page content. For
 * those, set `waitForXPath` so the goto only resolves once an element
 * matching that xpath actually appears (uses the same `waitFor`
 * infrastructure as the standalone action).
 *
 *   { "action": "goto", "url": "https://example.com/dashboard",
 *     "waitForXPath": "//h1[normalize-space(.)='Dashboard']",
 *     "waitForTimeoutMs": 10000 }
 */
export interface GotoStep extends BaseStep {
  action: 'goto';
  url: string;
  /** XPath to wait for after the tab signals 'complete'. Default 20s. */
  waitForXPath?: string;
  /** Override for the waitFor timeout. Only meaningful with waitForXPath. */
  waitForTimeoutMs?: number;
}

export interface FillStep extends BaseStep, RetryFields {
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
export interface GetStep extends BaseStep, RetryFields {
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

export interface ClickStep extends BaseStep, RetryFields {
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

export interface WaitForStep extends BaseStep, RetryFields {
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
export interface PressStep extends BaseStep, RetryFields {
  action: 'press';
  xpath?: string;
  key: string;
  pierceClosed?: boolean;
}

/**
 * Side-effect-free diagnostic. Returns `{ matchCount, matches: [...] }` for
 * the xpath — the count of matching elements (across light DOM, open shadow,
 * and same-origin iframes) plus metadata for up to the first 5: frame URL,
 * tag, id, name, classes, and a 60-char snippet of innerText.
 *
 * No polling — `describe` reports the page's state *now*. Pair it with a
 * `waitFor` step beforehand if you need the element to render first.
 *
 * Closed-shadow caveat: when routed through the CDP path (via
 * `pierceClosed:true` or the auto-detected closed-shadow flag), the result
 * contains at most one match — extending the CDP DOM walk to enumerate every
 * match wasn't worth the complexity for the v1 diagnostic.
 *
 *   { "action": "describe", "xpath": "//button", "saveAs": "buttons" }
 */
export interface DescribeStep extends BaseStep, RetryFields {
  action: 'describe';
  xpath: string;
  /** Save the result as a JSON string to ctx.outputs[saveAs]. */
  saveAs?: string;
  /** Force the CDP DOM walk (for closed-shadow content). Returns first match only. */
  pierceClosed?: boolean;
}

/**
 * Pre-arm the response for the next native dialog (`alert()`, `confirm()`,
 * `prompt()`, `beforeunload`). This step does NOT itself trigger a dialog —
 * place it immediately before the step whose click/navigation/etc. will
 * cause one to appear.
 *
 * Default behavior when no `dialog` step has been used: every dialog is
 * auto-accepted with an empty prompt response, so scripts never hang on a
 * stray `confirm("Are you sure?")`. Use this step to override that for a
 * specific dialog — e.g., to test a "Cancel" path, or to supply a prompt
 * response.
 *
 * The arming is one-shot: after a dialog consumes the response, subsequent
 * dialogs go back to auto-accept until armed again.
 *
 *   { "action": "dialog", "accept": false },               // arm: cancel the next confirm
 *   { "action": "click",  "xpath": "//button[.='Delete']" } // triggers it
 *
 *   { "action": "dialog", "accept": true, "promptText": "Jubair" },
 *   { "action": "click",  "xpath": "//button[.='Set name']" }
 */
export interface DialogStep extends BaseStep {
  action: 'dialog';
  /** Whether to click OK (true) or Cancel (false) on the next dialog. Default true. */
  accept?: boolean;
  /** Text to return from a prompt(). Ignored for alert/confirm. */
  promptText?: string;
}

/**
 * Hover over an element. Used as a precondition for "hover-reveals-button →
 * click button" flows (Bootstrap dropdowns, table-row action menus, tooltip
 * triggers).
 *
 * Two paths internally:
 *   - **Trusted** (main frame OR closed-shadow CDP): one
 *     `Input.dispatchMouseEvent({type:'mouseMoved'})`. CSS `:hover` fires
 *     natively, plus all the pointer/mouse events. **Preferred.**
 *   - **Synthetic** (iframe-resolved targets where viewport coords don't
 *     map cleanly): in-page dispatch of `pointerover/pointerenter/mouseover/
 *     mouseenter/pointermove/mousemove`. JS hover handlers fire; CSS
 *     `:hover` does NOT.
 *
 *   { "action": "hover", "xpath": "//div[@class='row']" }
 */
export interface HoverStep extends BaseStep, RetryFields {
  action: 'hover';
  xpath: string;
  pierceClosed?: boolean;
  /** How long the search loop polls before failing. Default 20s. */
  timeoutMs?: number;
}

/**
 * Programmatically pick option(s) in a native `<select>`. Setting
 * `select.value` (single) or `option.selected` (multi) is much more reliable
 * than clicking — native select dropdowns render as an OS-level popup that
 * doesn't accept synthetic clicks.
 *
 * Match by exactly one of:
 *   - `value`: matches `option.value` (the value attribute / submitted value)
 *   - `label`: matches `option.label` (the visible text)
 *
 * Either can be a string (single match) or an array (multi-select).
 *
 * Multi-select semantics are "set to exactly these" — any option whose
 * value/label isn't in the wanted set gets unselected. (Playwright-style.)
 *
 *   { "action": "selectOption", "xpath": "//select[@id='country']", "label": "Bangladesh" }
 *   { "action": "selectOption", "xpath": "//select[@multiple]", "value": ["red", "blue"] }
 */
export interface SelectOptionStep extends BaseStep, RetryFields {
  action: 'selectOption';
  xpath: string;
  value?: string | string[];
  label?: string | string[];
  /** Accepted for parity; `cdpResolveXPath` already pierces closed shadow. */
  pierceClosed?: boolean;
  /** How long to poll for the select to appear in the DOM. Default 20s. */
  timeoutMs?: number;
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
export interface UploadStep extends BaseStep, RetryFields {
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
export interface EvaluateStep extends BaseStep, RetryFields {
  action: 'evaluate';
  expression: string;
  saveAs?: string;
  /** Server-side timeout for `awaitPromise` cases. Omit for no timeout. */
  timeoutMs?: number;
}

/**
 * Multi-tab / multi-window orchestration. CRM-style flows often pivot through
 * new tabs (click a row → detail opens → fill → close → repeat) or sized
 * popup windows (open a lookup window → grab info → close → resume). Today
 * the engine is bound to one `tabId` at construction; this step lets a
 * script open new tabs and windows, switch among them, and close them.
 *
 * Ops:
 *   - `open`        — proactively open a new tab in the current window at
 *                     `url`. Pairs with `waitForXPath` / `waitForTimeoutMs`.
 *   - `openWindow`  — proactively open a new BROWSER WINDOW at `url`. Use
 *                     `windowType: 'popup'` + `width` / `height` / `left` /
 *                     `top` for a sized lookup window; default is a regular
 *                     Chrome window. Pairs with `waitForXPath` /
 *                     `waitForTimeoutMs` like `open`.
 *   - `switchTo`    — focus a tab matching `urlMatches` (substring or
 *                     `/regex/flags`) or `index` (0-based, within the window).
 *                     Exactly one of `urlMatches` or `index` must be supplied.
 *   - `waitForNew`  — wait for a new tab opened by the previous step's side
 *                     effect (e.g., `click` on a `target="_blank"` link).
 *                     Optional `urlMatches` to disambiguate.
 *   - `close`       — close the current tab and pop back to the previous one.
 *                     The engine maintains an internal origin stack: every
 *                     `open` / `openWindow` / `switchTo` / `waitForNew` pushes
 *                     the prior tab; `close` pops + reactivates whatever's on
 *                     top. Closing the only tab in a popup window also closes
 *                     the window (Chrome default).
 *   - `next`/`previous` — cycle to the adjacent tab in the same window.
 *
 *   { "action": "tab", "op": "open", "url": "https://lookup.internal/sku/{{sku}}",
 *     "waitForXPath": "//span[@id='price']" }
 *   { "action": "tab", "op": "openWindow", "url": "https://en.wikipedia.org/wiki/Foo",
 *     "windowType": "popup", "width": 700, "height": 500,
 *     "waitForXPath": "//h1[@id='firstHeading']" }
 *   { "action": "tab", "op": "waitForNew", "urlMatches": "/customers/" }
 *   { "action": "tab", "op": "close" }
 */
export interface TabStep extends BaseStep, RetryFields {
  action: 'tab';
  op:
    | 'open'
    | 'openWindow'
    | 'switchTo'
    | 'waitForNew'
    | 'close'
    | 'next'
    | 'previous';
  /** For `open` / `openWindow`: the URL to navigate the new tab/window to.
   *  Supports `{{var}}`. */
  url?: string;
  /** For `open` / `openWindow`: optional xpath to wait for after the tab
   *  signals 'complete'. */
  waitForXPath?: string;
  /** For `open` / `openWindow`: override for the post-load waitFor timeout
   *  (default 20s). */
  waitForTimeoutMs?: number;
  /** For `openWindow`: Chrome window type. `'normal'` is a regular window
   *  with full chrome; `'popup'` is a minimal window without tabs / address
   *  bar (good for sized lookup/auth dialogs). Default `'normal'`. */
  windowType?: 'normal' | 'popup';
  /** For `openWindow`: dimensions + position in CSS pixels. Omitted →
   *  Chrome picks defaults. */
  width?: number;
  height?: number;
  left?: number;
  top?: number;
  /** For `switchTo` / `waitForNew`: URL pattern to match. Plain string is a
   *  substring match; `/regex/flags` is a RegExp. Supports `{{var}}`. */
  urlMatches?: string;
  /** For `switchTo`: 0-based index in the window's tab strip. Mutex with `urlMatches`. */
  index?: number;
  /** For `waitForNew`: how long to wait for the new tab to appear. Default 10s. */
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
  | UploadStep
  | SelectOptionStep
  | HoverStep
  | DialogStep
  | DescribeStep
  | TabStep;

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
