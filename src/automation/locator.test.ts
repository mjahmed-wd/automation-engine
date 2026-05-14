/**
 * Light unit tests for the IIFE strings built by locator.ts.
 *
 * Scope: only the bits that work reliably in jsdom. The pointer-sequence
 * click and the overlay hit-test both depend on PointerEvent / elementsFromPoint
 * which jsdom implements only partially — we'd produce confidently-passing
 * tests that don't reflect real Chrome behavior. Those go in the Batch 5
 * mega-fixture (or future Playwright E2E).
 *
 * What we CAN reliably test:
 *  - `buildDescribeExpression` runs against a real document.evaluate, counts
 *    matches, captures metadata. The enumeration walker is pure DOM.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { buildDescribeExpression } from './locator';

function runIIFE<T>(expr: string): T {
  // The IIFEs are self-contained: they only touch globals like `document`,
  // `location`, `XPathResult`. `new Function` is preferred over `eval`
  // because it runs in global scope, which is exactly what we want.
  return new Function('return ' + expr)() as T;
}

interface DescribeResult {
  matchCount: number;
  matches: Array<{
    frame: string;
    tag: string;
    id?: string;
    name?: string;
    classes: string[];
    text: string;
  }>;
}

describe('buildDescribeExpression', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <button id="a">A</button>
      <button id="b" class="primary big">B button</button>
      <span>not a button</span>
      <button>unnamed</button>
    `;
  });

  it('counts matching elements', () => {
    const expr = buildDescribeExpression({ xpath: '//button' });
    const result = runIIFE<DescribeResult>(expr);
    expect(result.matchCount).toBe(3);
  });

  it('captures tag, id, classes, and text for each match', () => {
    const expr = buildDescribeExpression({ xpath: '//button' });
    const result = runIIFE<DescribeResult>(expr);
    expect(result.matches[0].tag).toBe('BUTTON');
    expect(result.matches[0].id).toBe('a');
    expect(result.matches[0].text).toBe('A');

    expect(result.matches[1].id).toBe('b');
    expect(result.matches[1].classes).toContain('primary');
    expect(result.matches[1].classes).toContain('big');
    expect(result.matches[1].text).toBe('B button');

    // Third match has no id — `id` field omitted
    expect(result.matches[2].id).toBeUndefined();
  });

  it('returns matchCount: 0 + empty matches when nothing matches', () => {
    const expr = buildDescribeExpression({ xpath: '//foobar' });
    const result = runIIFE<DescribeResult>(expr);
    expect(result.matchCount).toBe(0);
    expect(result.matches).toEqual([]);
  });

  it('caps matches at 5 even when count is higher', () => {
    // Generate 10 buttons
    document.body.innerHTML = Array.from(
      { length: 10 },
      (_, i) => `<button id="b${i}">B${i}</button>`,
    ).join('');
    const expr = buildDescribeExpression({ xpath: '//button' });
    const result = runIIFE<DescribeResult>(expr);
    expect(result.matchCount).toBe(10);
    expect(result.matches.length).toBe(5);
  });

  it('truncates text at 60 chars with ellipsis', () => {
    document.body.innerHTML = `<p>${'x'.repeat(120)}</p>`;
    const expr = buildDescribeExpression({ xpath: '//p' });
    const result = runIIFE<DescribeResult>(expr);
    expect(result.matches[0].text.length).toBe(61); // 60 chars + …
    expect(result.matches[0].text.endsWith('…')).toBe(true);
  });
});
