/**
 * Unit tests for the pure helpers in schema.ts.
 *
 * The `concat()` quote-escape in `xpathStringLiteral` is the most regression-
 * prone bit — a careless refactor could silently produce broken XPaths that
 * don't throw, just never match. These tests pin that contract.
 */

import { describe, expect, it } from 'vitest';
import {
  substituteRaw,
  substituteXPath,
  xpathStringLiteral,
  type ExecutionContext,
} from './schema';

const ctx = (
  variables: Record<string, string> = {},
  outputs: Record<string, string> = {},
): ExecutionContext => ({
  variables,
  outputs,
  log: () => {},
});

describe('xpathStringLiteral', () => {
  it('wraps a plain string in single quotes', () => {
    expect(xpathStringLiteral('hello')).toBe(`'hello'`);
  });

  it('uses double quotes when the value contains a single quote', () => {
    expect(xpathStringLiteral("O'Brien")).toBe(`"O'Brien"`);
  });

  it('uses single quotes when the value contains a double quote', () => {
    expect(xpathStringLiteral('say "hi"')).toBe(`'say "hi"'`);
  });

  it('builds a concat() expression when the value contains both quote types', () => {
    // Should produce concat('a', "'", 'b"c') or similar
    const result = xpathStringLiteral(`a'b"c`);
    expect(result.startsWith('concat(')).toBe(true);
    expect(result.endsWith(')')).toBe(true);
    // Both quote characters must appear in the concat parts
    expect(result).toContain(`"'"`);
  });

  it('handles empty string', () => {
    expect(xpathStringLiteral('')).toBe(`''`);
  });
});

describe('substituteXPath', () => {
  it('passes through when no variable references', () => {
    expect(substituteXPath(`//input[@id='foo']`, ctx())).toBe(`//input[@id='foo']`);
  });

  it('strips surrounding single quotes around {{var}}', () => {
    expect(
      substituteXPath(`//input[@name='{{n}}']`, ctx({ n: 'email' })),
    ).toBe(`//input[@name='email']`);
  });

  it('strips surrounding double quotes around {{var}}', () => {
    expect(
      substituteXPath(`//input[@name="{{n}}"]`, ctx({ n: 'email' })),
    ).toBe(`//input[@name='email']`);
  });

  it('substitutes a bare {{var}} as a literal', () => {
    expect(
      substituteXPath(`//input[@name={{n}}]`, ctx({ n: 'email' })),
    ).toBe(`//input[@name='email']`);
  });

  it('uses double quotes when a variable value contains only a single quote', () => {
    // xpathStringLiteral has three branches; a value with only a single
    // quote (no double quotes) goes through the "wrap in double quotes"
    // path, not concat(). The original surrounding single quotes around
    // {{label}} get stripped first, then the replacement supplies its
    // own quoting.
    expect(
      substituteXPath(`//button[.='{{label}}']`, ctx({ label: `O'Brien` })),
    ).toBe(`//button[.="O'Brien"]`);
  });

  it('uses concat() when a variable value contains both single and double quotes', () => {
    const result = substituteXPath(
      `//button[.='{{label}}']`,
      ctx({ label: `O'Brien said "hi"` }),
    );
    expect(result).toContain('concat(');
    // The single-quote part of the value lives inside `"'"` in the concat
    expect(result).toContain(`"'"`);
  });

  it('falls through when the variable is missing', () => {
    expect(substituteXPath(`//input[@id='{{nope}}']`, ctx())).toBe(
      `//input[@id='{{nope}}']`,
    );
  });

  it('substitutes multiple variables in value positions independently', () => {
    // substituteXPath is designed for value positions (inside [@attr='…']
    // predicates), not structural positions like tag names.
    expect(
      substituteXPath(
        `//input[@name='{{n}}' and @id='{{id}}']`,
        ctx({ n: 'email', id: 'login' }),
      ),
    ).toBe(`//input[@name='email' and @id='login']`);
  });

  it('prefers outputs over variables when both have the same key', () => {
    expect(
      substituteXPath(
        `//input[@name='{{n}}']`,
        ctx({ n: 'old' }, { n: 'new' }),
      ),
    ).toBe(`//input[@name='new']`);
  });
});

describe('substituteRaw', () => {
  it('passes through with no variable refs', () => {
    expect(substituteRaw('hello world', ctx())).toBe('hello world');
  });

  it('interpolates a single variable', () => {
    expect(substituteRaw('hello {{name}}', ctx({ name: 'Jubair' }))).toBe(
      'hello Jubair',
    );
  });

  it('interpolates multiple variables', () => {
    expect(
      substituteRaw('{{greet}}, {{name}}!', ctx({ greet: 'Hi', name: 'World' })),
    ).toBe('Hi, World!');
  });

  it('falls through when the variable is missing', () => {
    expect(substituteRaw('hello {{nope}}', ctx())).toBe('hello {{nope}}');
  });

  it('outputs take precedence over variables', () => {
    expect(
      substituteRaw('value: {{x}}', ctx({ x: 'fromVars' }, { x: 'fromOutputs' })),
    ).toBe('value: fromOutputs');
  });
});
