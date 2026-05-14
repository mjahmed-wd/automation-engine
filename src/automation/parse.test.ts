/**
 * Unit tests for parseAutomation + the Batch-3 validator.
 *
 * Two things being pinned:
 *  - The three input shapes (full script / bare array / single step) and
 *    JSON5 features.
 *  - Every validator rejection path, plus a registry-consistency check
 *    that fails loudly if a new action is added to actions/index.ts
 *    without a matching validator.
 */

import { describe, expect, it } from 'vitest';
import { parseAutomation, stepValidators } from './parse';
import { actions } from './actions';

describe('parseAutomation: shape detection', () => {
  it('accepts a full script object', () => {
    const out = parseAutomation(`{
      "name": "test",
      "steps": [{ "action": "wait", "ms": 100 }]
    }`);
    expect(out.name).toBe('test');
    expect(out.steps).toHaveLength(1);
    expect(out.steps[0].action).toBe('wait');
  });

  it('accepts a bare array of steps', () => {
    const out = parseAutomation(`[
      { "action": "wait", "ms": 100 },
      { "action": "wait", "ms": 200 }
    ]`);
    expect(out.name).toBe('Untitled');
    expect(out.steps).toHaveLength(2);
  });

  it('accepts a single step object', () => {
    const out = parseAutomation(`{ "action": "wait", "ms": 100 }`);
    expect(out.name).toBe('Untitled');
    expect(out.steps).toHaveLength(1);
    expect(out.steps[0].action).toBe('wait');
  });

  it('throws on empty input', () => {
    expect(() => parseAutomation('')).toThrow(/empty/i);
    expect(() => parseAutomation('   ')).toThrow(/empty/i);
  });

  it('throws on malformed JSON', () => {
    expect(() => parseAutomation('{not valid')).toThrow(/JSON parse error/i);
  });

  it('throws on an object that is neither a script, array, nor single step', () => {
    expect(() => parseAutomation('{"name":"x"}')).toThrow(/must be/i);
  });
});

describe('parseAutomation: JSON5 features', () => {
  it('accepts trailing commas', () => {
    const out = parseAutomation(`{
      "steps": [
        { "action": "wait", "ms": 100, },
      ],
    }`);
    expect(out.steps).toHaveLength(1);
  });

  it('accepts // line comments', () => {
    const out = parseAutomation(`{
      // this is a comment
      "steps": [
        { "action": "wait", "ms": 100 }
      ]
    }`);
    expect(out.steps).toHaveLength(1);
  });

  it('accepts single-quoted strings', () => {
    const out = parseAutomation(`{
      'name': 'test',
      'steps': [{ 'action': 'wait', 'ms': 100 }]
    }`);
    expect(out.name).toBe('test');
  });
});

describe('validator: unknown action', () => {
  it('throws with the action name and known list', () => {
    expect(() => parseAutomation(`{ "action": "clik", "xpath": "//x" }`)).toThrow(
      /unknown action "clik"/,
    );
  });

  it('lists known actions in the error', () => {
    try {
      parseAutomation(`{ "action": "nope" }`);
    } catch (err: any) {
      expect(err.message).toContain('goto');
      expect(err.message).toContain('fill');
      expect(err.message).toContain('describe');
    }
  });
});

describe('validator: required fields', () => {
  it('fill requires value', () => {
    expect(() => parseAutomation(`{ "action": "fill", "xpath": "//x" }`)).toThrow(
      /fill requires "value"/,
    );
  });

  it('fill requires xpath', () => {
    expect(() => parseAutomation(`{ "action": "fill", "value": "x" }`)).toThrow(
      /fill requires "xpath"/,
    );
  });

  it('press requires key', () => {
    expect(() => parseAutomation(`{ "action": "press" }`)).toThrow(
      /press requires "key"/,
    );
  });

  it('wait requires ms', () => {
    expect(() => parseAutomation(`{ "action": "wait" }`)).toThrow(
      /wait requires "ms"/,
    );
  });

  it('evaluate requires expression', () => {
    expect(() => parseAutomation(`{ "action": "evaluate" }`)).toThrow(
      /evaluate requires "expression"/,
    );
  });

  it('upload requires files', () => {
    expect(() =>
      parseAutomation(`{ "action": "upload", "xpath": "//input" }`),
    ).toThrow(/upload requires "files"/);
  });

  it('describe requires xpath', () => {
    expect(() => parseAutomation(`{ "action": "describe" }`)).toThrow(
      /describe requires "xpath"/,
    );
  });

  it('goto requires url', () => {
    expect(() => parseAutomation(`{ "action": "goto" }`)).toThrow(
      /goto requires "url"/,
    );
  });
});

describe('validator: mutually-exclusive (selectOption)', () => {
  it('rejects when both value and label are provided', () => {
    expect(() =>
      parseAutomation(
        `{ "action": "selectOption", "xpath": "//s", "value": "v", "label": "l" }`,
      ),
    ).toThrow(/provide exactly one/);
  });

  it('rejects when neither value nor label is provided', () => {
    expect(() =>
      parseAutomation(`{ "action": "selectOption", "xpath": "//s" }`),
    ).toThrow(/requires "value" or "label"/);
  });

  it('accepts value alone', () => {
    const out = parseAutomation(
      `{ "action": "selectOption", "xpath": "//s", "value": "v" }`,
    );
    expect(out.steps).toHaveLength(1);
  });

  it('accepts label alone', () => {
    const out = parseAutomation(
      `{ "action": "selectOption", "xpath": "//s", "label": "l" }`,
    );
    expect(out.steps).toHaveLength(1);
  });
});

describe('validator: type checks on critical optional fields', () => {
  it('rejects timeoutMs as string', () => {
    expect(() =>
      parseAutomation(
        `{ "action": "fill", "xpath": "//x", "value": "v", "timeoutMs": "200" }`,
      ),
    ).toThrow(/timeoutMs must be a number/);
  });

  it('rejects pierceClosed as non-boolean', () => {
    expect(() =>
      parseAutomation(
        `{ "action": "click", "xpath": "//x", "pierceClosed": "yes" }`,
      ),
    ).toThrow(/pierceClosed must be a boolean/);
  });

  it('rejects dialog.accept as non-boolean', () => {
    expect(() =>
      parseAutomation(`{ "action": "dialog", "accept": "yes" }`),
    ).toThrow(/dialog.accept must be a boolean/);
  });
});

describe('validator: step index correctness', () => {
  it('reports step 2 when the second step is bad', () => {
    const json = `{
      "steps": [
        { "action": "goto", "url": "https://example.com" },
        { "action": "fil", "xpath": "//x", "value": "v" }
      ]
    }`;
    expect(() => parseAutomation(json)).toThrow(/Step 2: unknown action "fil"/);
  });

  it('reports step 3 when the third step is bad', () => {
    const json = `{
      "steps": [
        { "action": "wait", "ms": 100 },
        { "action": "wait", "ms": 200 },
        { "action": "fill", "xpath": "//x" }
      ]
    }`;
    expect(() => parseAutomation(json)).toThrow(/Step 3: fill requires "value"/);
  });
});

describe('registry consistency: stepValidators vs actions/index.ts', () => {
  it('every registered action has a validator', () => {
    for (const name of Object.keys(actions)) {
      expect(
        stepValidators[name],
        `action "${name}" is in the registry but has no validator`,
      ).toBeDefined();
    }
  });

  it('every validator corresponds to a registered action', () => {
    for (const name of Object.keys(stepValidators)) {
      expect(
        (actions as Record<string, unknown>)[name],
        `validator "${name}" exists but is not in the registry`,
      ).toBeDefined();
    }
  });
});
