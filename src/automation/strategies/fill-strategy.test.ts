import { describe, it, expect } from 'vitest';
import { FillStrategy } from './fill-strategy';

describe('FillStrategy', () => {
  const strategy = new FillStrategy();

  it('has mode "fill"', () => {
    expect(strategy.mode).toBe('fill');
  });

  describe('buildActionBlock', () => {
    it('builds action block with value', () => {
      const block = strategy.buildActionBlock({ value: 'test value' });
      expect(block).toContain('"test value"');
      expect(block).toContain('{{ELEMENT}}.disabled');
      expect(block).toContain('{{ELEMENT}}.readOnly');
    });

    it('includes fatal error for disabled inputs', () => {
      const block = strategy.buildActionBlock({ value: 'x' });
      expect(block).toContain('fatal: true');
      expect(block).toContain('disabled');
      expect(block).toContain('Cannot fill');
    });

    it('includes fatal error for read-only inputs', () => {
      const block = strategy.buildActionBlock({ value: 'x' });
      expect(block).toContain('readOnly');
      expect(block).toContain('read-only');
    });

    it('includes element identification in error', () => {
      const block = strategy.buildActionBlock({ value: 'x' });
      expect(block).toContain('__tag');
      expect(block).toContain('__ident');
      expect(block).toContain('{{ELEMENT}}.tagName');
      expect(block).toContain('{{ELEMENT}}.name');
      expect(block).toContain('{{ELEMENT}}.id');
    });

    it('handles contentEditable path', () => {
      const block = strategy.buildActionBlock({ value: 'text' });
      expect(block).toContain('isContentEditable');
      expect(block).toContain('execCommand');
      expect(block).toContain('insertText');
    });

    it('selects all content before inserting in contentEditable', () => {
      const block = strategy.buildActionBlock({ value: 'content' });
      expect(block).toContain('getSelection()');
      expect(block).toContain('createRange()');
      expect(block).toContain('selectNodeContents');
      expect(block).toContain('removeAllRanges()');
      expect(block).toContain('addRange(__range)');
    });

    it('includes beforeinput fallback for contentEditable', () => {
      const block = strategy.buildActionBlock({ value: 'text' });
      expect(block).toContain('beforeinput');
      expect(block).toContain('inputType: \'insertText\'');
      expect(block).toContain('composed: true');
    });

    it('handles regular input path with setter', () => {
      const block = strategy.buildActionBlock({ value: 'regular' });
      expect(block).toContain('Object.getPrototypeOf');
      expect(block).toContain('getOwnPropertyDescriptor');
      expect(block).toContain('desc && desc.set');
    });

    it('falls back to direct value assignment', () => {
      const block = strategy.buildActionBlock({ value: 'direct' });
      expect(block).toContain('{{ELEMENT}}.value =');
    });

    it('dispatches input event for both paths', () => {
      const block = strategy.buildActionBlock({ value: 'x' });
      // contentEditable path
      expect(block).toMatch(/dispatchEvent\(new Event\('input'.*bubbles: true/);
      // Regular input path should also have input event
      const inputMatches = block.match(/new Event\('input'/g);
      expect(inputMatches).toHaveLength(2);
    });

    it('dispatches change event for regular input', () => {
      const block = strategy.buildActionBlock({ value: 'x' });
      expect(block).toContain("new Event('change'");
    });

    it('escapes value literals correctly with JSON.stringify', () => {
      const block = strategy.buildActionBlock({ value: 'value with "quotes" and \'apostrophes\'' });
      expect(block).toContain('"value with \\"quotes\\" and \'apostrophes\'"');
    });

    it('handles empty string value', () => {
      const block = strategy.buildActionBlock({ value: '' });
      expect(block).toContain('""');
    });

    it('handles special characters in value', () => {
      const block = strategy.buildActionBlock({ value: 'line1\nline2' });
      expect(block).toContain('"line1\\nline2"');
    });

    it('uses {{ELEMENT}} placeholder throughout', () => {
      const block = strategy.buildActionBlock({ value: 'x' });
      // Count occurrences of {{ELEMENT}}
      const matches = block.match(/\{\{ELEMENT\}\}/g);
      expect(matches?.length).toBeGreaterThan(10);
    });
  });
});
