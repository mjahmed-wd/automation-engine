/**
 * Parse a user-typed JSON string into an AutomationScript.
 *
 * Accepts (auto-detected):
 *   1. A full script object:    { "name": "...", "steps": [ ... ] }
 *   2. A bare array of steps:   [ { ... }, { ... } ]
 *   3. A single step object:    { "action": "get", "selector": "..." }
 *
 * Powered by JSON5 so the textarea tolerates // comments and trailing commas.
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

  // 1) Bare array of steps
  if (Array.isArray(parsed)) {
    return { name: 'Untitled', steps: parsed as AutomationStep[] };
  }

  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;

    // 2) Full script
    if (Array.isArray(obj.steps)) {
      return obj as unknown as AutomationScript;
    }

    // 3) Single step (has an `action` field)
    if (typeof obj.action === 'string') {
      return {
        name: 'Untitled',
        steps: [obj as unknown as AutomationStep],
      };
    }
  }

  throw new Error(
    'Input must be an AutomationScript, an array of steps, or a single step.',
  );
}
