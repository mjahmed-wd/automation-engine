/**
 * Automation schema — types used by the interpreter and by JSON authoring.
 *
 * Each step is discriminated by its `action` string. Example shapes:
 *
 *   { "action": "goto",  "url": "https://example.com" }
 *   { "action": "fill",  "label": "Email", "value": "{{email}}" }
 *   { "action": "get",   "selector": "h1", "saveAs": "title" }
 *   { "action": "get",   "selector": "a.cta", "attribute": "href", "saveAs": "url" }
 *   { "action": "get",   "selector": ".price", "regex": "\\$([0-9.,]+)", "saveAs": "price" }
 */

export interface Locator {
  label?: string;
  /** CSS selector (supports the `>>>` shadow-piercing syntax in the fast path). */
  selector?: string;
  /**
   * XPath expression. Mutually alternative to `selector`. Use this when you
   * want native text matching, structural ancestor/sibling queries, or any
   * of XPath's tools that CSS doesn't have. Examples:
   *   //input[@data-test-id='invoice-paymentTable-input']
   *   //label[contains(@class,'toggle-button')]
   *   //label[ancestor::div[.//span[normalize-space(text())='Pay All Invoices']]]
   */
  xpath?: string;
  /**
   * Refines a `selector` match by requiring it to be near (within ~6 ancestor
   * levels of) an element whose own direct text content matches this string.
   * Lets you say "the toggle near 'Pay All Invoices'" without depending on
   * auto-generated ids. Pair with `selector`; for `xpath`, write the relation
   * directly into the XPath expression.
   */
  nearText?: string;
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
  label?: string;
  selector?: string;
  value: string;
  /** Skip the fast Runtime.evaluate path and go straight to the CDP DOM-walk
   *  (needed for elements inside `attachShadow({mode:'closed'})` roots). */
  pierceClosed?: boolean;
  /** XPath expression — alternative to `selector`. See Locator.xpath. */
  xpath?: string;
  /** Refines `selector` by requiring it to live near this text. See Locator.nearText. */
  nearText?: string;
}

/**
 * `get` reads any value from the page: input value, text content, an
 * attribute, or a regex extract over any of those.
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
  label?: string;
  selector?: string;
  attribute?: string;
  property?: string;
  regex?: string;
  regexFlags?: string;
  saveAs?: string;
  /** Skip the fast Runtime.evaluate path and go straight to the CDP DOM-walk
   *  (needed for elements inside `attachShadow({mode:'closed'})` roots). */
  pierceClosed?: boolean;
  /** XPath expression — alternative to `selector`. See Locator.xpath. */
  xpath?: string;
  /** Refines `selector` by requiring it to live near this text. See Locator.nearText. */
  nearText?: string;
}

export interface ClickStep extends BaseStep {
  action: 'click';
  label?: string;
  selector?: string;
  /** Skip the fast Runtime.evaluate path and go straight to the CDP DOM-walk
   *  (needed for elements inside `attachShadow({mode:'closed'})` roots). */
  pierceClosed?: boolean;
  /** XPath expression — alternative to `selector`. See Locator.xpath. */
  xpath?: string;
  /** Refines `selector` by requiring it to live near this text. See Locator.nearText. */
  nearText?: string;
}

export interface WaitStep extends BaseStep {
  action: 'wait';
  ms: number;
}

export interface WaitForStep extends BaseStep {
  action: 'waitFor';
  label?: string;
  selector?: string;
  timeoutMs?: number;
  /** Skip the fast Runtime.evaluate path and go straight to the CDP DOM-walk
   *  (needed for elements inside `attachShadow({mode:'closed'})` roots). */
  pierceClosed?: boolean;
  /** XPath expression — alternative to `selector`. See Locator.xpath. */
  xpath?: string;
  /** Refines `selector` by requiring it to live near this text. See Locator.nearText. */
  nearText?: string;
}

export type AutomationStep =
  | GotoStep
  | FillStep
  | GetStep
  | ClickStep
  | WaitStep
  | WaitForStep;

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

/** Replace `{{name}}` tokens using outputs first, then variables. */
export function substitute(str: string, ctx: ExecutionContext): string {
  return str.replace(/\{\{(\w+)\}\}/g, (_, name) => {
    if (name in ctx.outputs) return ctx.outputs[name];
    if (name in ctx.variables) return ctx.variables[name];
    return `{{${name}}}`;
  });
}

/** Build a Locator from a step's label/selector, with variable substitution. */
export function resolveLocator(
  step: { label?: string; selector?: string; xpath?: string; nearText?: string },
  ctx: ExecutionContext,
): Locator {
  const out: Locator = {};
  if (step.label) out.label = substitute(step.label, ctx);
  if (step.selector) out.selector = substitute(step.selector, ctx);
  if (step.xpath) out.xpath = substitute(step.xpath, ctx);
  if (step.nearText) out.nearText = substitute(step.nearText, ctx);
  if (!out.label && !out.selector && !out.xpath) {
    throw new Error('Step requires "label", "selector", or "xpath"');
  }
  return out;
}
