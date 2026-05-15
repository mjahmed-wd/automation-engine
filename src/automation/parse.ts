/**
 * Parse a user-typed JSON string into an AutomationScript.
 *
 * Accepts (auto-detected):
 *   1. A full script object:    { "name": "...", "steps": [ ... ] }
 *   2. A bare array of steps:   [ { ... }, { ... } ]
 *   3. A single step object:    { "action": "get", "selector": "..." }
 *
 * Powered by JSON5 so the textarea tolerates // comments and trailing commas.
 *
 * After the shape detection, `validateScript` runs per-step shape validation
 * so typos and missing required fields surface as parse errors — BEFORE the
 * debugger attaches and the script starts navigating tabs. Catching a typo'd
 * action name at edit time turns a 2-second mistake (chrome:// pre-flight +
 * attach + first goto + finally "Unknown action") into a 50-millisecond one.
 */

import JSON5 from 'json5';
import type { AutomationScript, AutomationStep } from './schema';

export function parseAutomation(input: string): AutomationScript {
  if (!input.trim()) throw new Error('Input is empty.');

  let parsed: unknown;
  try {
    parsed = JSON5.parse(input);
  } catch (err: any) {
    throw new Error(`JSON parse error: ${err?.message ?? String(err)}`);
  }

  let script: AutomationScript;

  // 1) Bare array of steps
  if (Array.isArray(parsed)) {
    script = { name: 'Untitled', steps: parsed as AutomationStep[] };
  } else if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;

    // 2) Full script
    if (Array.isArray(obj.steps)) {
      script = obj as unknown as AutomationScript;
    }
    // 3) Single step (has an `action` field)
    else if (typeof obj.action === 'string') {
      script = {
        name: 'Untitled',
        steps: [obj as unknown as AutomationStep],
      };
    } else {
      throw new Error(
        'Input must be an AutomationScript, an array of steps, or a single step.',
      );
    }
  } else {
    throw new Error(
      'Input must be an AutomationScript, an array of steps, or a single step.',
    );
  }

  validateScript(script);
  return script;
}

// -------------------------------------------------------------------------
// Shape validation
//
// Centralized here so adding a new action is one place to update — the same
// reason `actions/index.ts` registers handlers in one map. Each validator
// returns either `null` (OK) or an error string that already includes the
// step index. Validators are deliberately shallow: required-field presence,
// type checks on critical fields, mutually-exclusive constraints. They do
// NOT check xpath syntax (that's validateXPath at runtime), file path
// shape (that's page.upload), or anything that requires DOM context.
// -------------------------------------------------------------------------

type StepValidator = (step: any, n: number) => string | null;

const isString = (v: unknown): v is string => typeof v === 'string';
const isNumber = (v: unknown): v is number => typeof v === 'number' && !Number.isNaN(v);
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';

/**
 * Shared validator for the `retries` / `retryDelay` mixin fields. Called from
 * every locator-using step's validator. Caps retries at 5 because worst-case
 * time per step is (retries+1) × timeoutMs + retries × retryDelay — at 5
 * retries with a default 20s timeout that's already ~2 minutes per step,
 * usually a sign the script should be restructured instead.
 */
const MAX_RETRIES = 5;
function validateRetryFields(s: any, n: number): string | null {
  if (s.retries !== undefined) {
    if (!isNumber(s.retries) || !Number.isInteger(s.retries) || s.retries < 0)
      return `Step ${n}: retries must be a non-negative integer.`;
    if (s.retries > MAX_RETRIES)
      return `Step ${n}: retries capped at ${MAX_RETRIES} (got ${s.retries}). At default 20s timeoutMs, that's already ~2 minutes per step — restructure the script if you need more.`;
  }
  if (s.retryDelay !== undefined) {
    if (!isNumber(s.retryDelay) || s.retryDelay < 0)
      return `Step ${n}: retryDelay must be a non-negative number (milliseconds).`;
  }
  return null;
}

/** Exported so unit tests can pin the keyset against actions/index.ts. */
export const stepValidators: Record<string, StepValidator> = {
  goto: (s, n) => {
    if (!isString(s.url)) return `Step ${n}: goto requires "url" (string).`;
    if (s.waitForXPath !== undefined && !isString(s.waitForXPath))
      return `Step ${n}: goto.waitForXPath must be a string.`;
    if (s.waitForTimeoutMs !== undefined && !isNumber(s.waitForTimeoutMs))
      return `Step ${n}: goto.waitForTimeoutMs must be a number.`;
    return null;
  },
  fill: (s, n) => {
    if (!isString(s.xpath)) return `Step ${n}: fill requires "xpath" (string).`;
    if (!isString(s.value)) return `Step ${n}: fill requires "value" (string).`;
    if (s.timeoutMs !== undefined && !isNumber(s.timeoutMs))
      return `Step ${n}: fill.timeoutMs must be a number.`;
    if (s.pierceClosed !== undefined && !isBoolean(s.pierceClosed))
      return `Step ${n}: fill.pierceClosed must be a boolean.`;
    return validateRetryFields(s, n);
  },
  get: (s, n) => {
    if (!isString(s.xpath)) return `Step ${n}: get requires "xpath" (string).`;
    if (s.saveAs !== undefined && !isString(s.saveAs))
      return `Step ${n}: get.saveAs must be a string.`;
    if (s.attribute !== undefined && !isString(s.attribute))
      return `Step ${n}: get.attribute must be a string.`;
    if (s.property !== undefined && !isString(s.property))
      return `Step ${n}: get.property must be a string.`;
    if (s.regex !== undefined && !isString(s.regex))
      return `Step ${n}: get.regex must be a string.`;
    if (s.timeoutMs !== undefined && !isNumber(s.timeoutMs))
      return `Step ${n}: get.timeoutMs must be a number.`;
    return validateRetryFields(s, n);
  },
  click: (s, n) => {
    if (!isString(s.xpath)) return `Step ${n}: click requires "xpath" (string).`;
    if (s.timeoutMs !== undefined && !isNumber(s.timeoutMs))
      return `Step ${n}: click.timeoutMs must be a number.`;
    if (s.pierceClosed !== undefined && !isBoolean(s.pierceClosed))
      return `Step ${n}: click.pierceClosed must be a boolean.`;
    return validateRetryFields(s, n);
  },
  wait: (s, n) => {
    if (!isNumber(s.ms)) return `Step ${n}: wait requires "ms" (number).`;
    return null;
  },
  waitFor: (s, n) => {
    if (!isString(s.xpath)) return `Step ${n}: waitFor requires "xpath" (string).`;
    if (s.timeoutMs !== undefined && !isNumber(s.timeoutMs))
      return `Step ${n}: waitFor.timeoutMs must be a number.`;
    return validateRetryFields(s, n);
  },
  press: (s, n) => {
    if (!isString(s.key)) return `Step ${n}: press requires "key" (string, e.g. "Enter").`;
    if (s.xpath !== undefined && !isString(s.xpath))
      return `Step ${n}: press.xpath must be a string when provided.`;
    return validateRetryFields(s, n);
  },
  evaluate: (s, n) => {
    if (!isString(s.expression))
      return `Step ${n}: evaluate requires "expression" (string).`;
    if (s.saveAs !== undefined && !isString(s.saveAs))
      return `Step ${n}: evaluate.saveAs must be a string.`;
    if (s.timeoutMs !== undefined && !isNumber(s.timeoutMs))
      return `Step ${n}: evaluate.timeoutMs must be a number.`;
    return validateRetryFields(s, n);
  },
  upload: (s, n) => {
    if (!isString(s.xpath)) return `Step ${n}: upload requires "xpath" (string).`;
    if (s.files === undefined || s.files === null)
      return `Step ${n}: upload requires "files" (string or array of strings).`;
    if (typeof s.files !== 'string' && !Array.isArray(s.files))
      return `Step ${n}: upload.files must be a string or array of strings.`;
    if (Array.isArray(s.files)) {
      if (s.files.length === 0)
        return `Step ${n}: upload.files must contain at least one path.`;
      for (let i = 0; i < s.files.length; i++) {
        if (!isString(s.files[i]))
          return `Step ${n}: upload.files[${i}] must be a string.`;
      }
    }
    return validateRetryFields(s, n);
  },
  selectOption: (s, n) => {
    if (!isString(s.xpath))
      return `Step ${n}: selectOption requires "xpath" (string).`;
    const hasValue = s.value !== undefined && s.value !== null;
    const hasLabel = s.label !== undefined && s.label !== null;
    if (!hasValue && !hasLabel)
      return `Step ${n}: selectOption requires "value" or "label".`;
    if (hasValue && hasLabel)
      return `Step ${n}: selectOption: provide exactly one of "value" or "label", not both.`;
    return validateRetryFields(s, n);
  },
  hover: (s, n) => {
    if (!isString(s.xpath)) return `Step ${n}: hover requires "xpath" (string).`;
    if (s.timeoutMs !== undefined && !isNumber(s.timeoutMs))
      return `Step ${n}: hover.timeoutMs must be a number.`;
    return validateRetryFields(s, n);
  },
  dialog: (s, n) => {
    if (s.accept !== undefined && !isBoolean(s.accept))
      return `Step ${n}: dialog.accept must be a boolean.`;
    if (s.promptText !== undefined && !isString(s.promptText))
      return `Step ${n}: dialog.promptText must be a string.`;
    return null;
  },
  describe: (s, n) => {
    if (!isString(s.xpath))
      return `Step ${n}: describe requires "xpath" (string).`;
    if (s.saveAs !== undefined && !isString(s.saveAs))
      return `Step ${n}: describe.saveAs must be a string.`;
    return validateRetryFields(s, n);
  },
  tab: (s, n) => {
    const KNOWN_OPS = [
      'open',
      'openWindow',
      'switchTo',
      'waitForNew',
      'close',
      'next',
      'previous',
    ];
    if (!isString(s.op) || !KNOWN_OPS.includes(s.op))
      return `Step ${n}: tab requires "op" (one of ${KNOWN_OPS.join(', ')}).`;

    if (s.op === 'open') {
      if (!isString(s.url))
        return `Step ${n}: tab.open requires "url" (string).`;
      if (s.waitForXPath !== undefined && !isString(s.waitForXPath))
        return `Step ${n}: tab.open.waitForXPath must be a string.`;
      if (s.waitForTimeoutMs !== undefined && !isNumber(s.waitForTimeoutMs))
        return `Step ${n}: tab.open.waitForTimeoutMs must be a number.`;
    }

    if (s.op === 'openWindow') {
      if (!isString(s.url))
        return `Step ${n}: tab.openWindow requires "url" (string).`;
      if (s.waitForXPath !== undefined && !isString(s.waitForXPath))
        return `Step ${n}: tab.openWindow.waitForXPath must be a string.`;
      if (s.waitForTimeoutMs !== undefined && !isNumber(s.waitForTimeoutMs))
        return `Step ${n}: tab.openWindow.waitForTimeoutMs must be a number.`;
      if (
        s.windowType !== undefined &&
        s.windowType !== 'normal' &&
        s.windowType !== 'popup'
      )
        return `Step ${n}: tab.openWindow.windowType must be "normal" or "popup".`;
      // Dimensions must be positive numbers when provided. Position fields
      // (left/top) allow 0 but reject negatives — chrome.windows.create
      // tolerates negatives but they almost certainly mean an off-screen
      // window, which is rarely intentional in an automation script.
      for (const k of ['width', 'height'] as const) {
        if (s[k] !== undefined && (!isNumber(s[k]) || (s[k] as number) <= 0))
          return `Step ${n}: tab.openWindow.${k} must be a positive number.`;
      }
      for (const k of ['left', 'top'] as const) {
        if (s[k] !== undefined && (!isNumber(s[k]) || (s[k] as number) < 0))
          return `Step ${n}: tab.openWindow.${k} must be a non-negative number.`;
      }
    }

    if (s.op === 'switchTo') {
      const hasUrl = s.urlMatches !== undefined && s.urlMatches !== null;
      const hasIndex = s.index !== undefined && s.index !== null;
      if (!hasUrl && !hasIndex)
        return `Step ${n}: tab.switchTo requires "urlMatches" or "index".`;
      if (hasUrl && hasIndex)
        return `Step ${n}: tab.switchTo: provide exactly one of "urlMatches" or "index", not both.`;
      if (hasUrl && !isString(s.urlMatches))
        return `Step ${n}: tab.switchTo.urlMatches must be a string.`;
      if (hasIndex && (!isNumber(s.index) || s.index < 0 || !Number.isInteger(s.index)))
        return `Step ${n}: tab.switchTo.index must be a non-negative integer.`;
    }

    if (s.op === 'waitForNew') {
      if (s.urlMatches !== undefined && !isString(s.urlMatches))
        return `Step ${n}: tab.waitForNew.urlMatches must be a string.`;
      if (s.timeoutMs !== undefined && !isNumber(s.timeoutMs))
        return `Step ${n}: tab.waitForNew.timeoutMs must be a number.`;
    }

    return validateRetryFields(s, n);
  },
};

function validateScript(script: AutomationScript): void {
  if (!Array.isArray(script.steps)) {
    throw new Error('Script must have a "steps" array.');
  }
  for (let i = 0; i < script.steps.length; i++) {
    const step = script.steps[i] as unknown;
    const n = i + 1;
    if (!step || typeof step !== 'object') {
      throw new Error(`Step ${n}: must be an object.`);
    }
    const s = step as Record<string, unknown>;
    if (typeof s.action !== 'string') {
      throw new Error(`Step ${n}: "action" must be a string.`);
    }
    const validator = stepValidators[s.action];
    if (!validator) {
      throw new Error(
        `Step ${n}: unknown action "${s.action}". ` +
          `Known: ${Object.keys(stepValidators).join(', ')}`,
      );
    }
    const err = validator(s, n);
    if (err) throw new Error(err);
  }
}
