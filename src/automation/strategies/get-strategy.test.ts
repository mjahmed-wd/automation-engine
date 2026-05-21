import { describe, it, expect } from 'vitest';
import { GetStrategy } from './get-strategy';

describe('GetStrategy', () => {
  const strategy = new GetStrategy();

  it('has mode "get"', () => {
    expect(strategy.mode).toBe('get');
  });

  describe('buildActionBlock', () => {
    it('builds value expression without options', () => {
      const block = strategy.buildActionBlock({});
      expect(block).toContain('{{ELEMENT}}.tagName');
      expect(block).toContain('innerText');
    });

    it('defaults to value for INPUT elements', () => {
      const block = strategy.buildActionBlock({});
      expect(block).toContain('t === \'INPUT\'');
      expect(block).toContain('\'value\'');
    });

    it('defaults to value for TEXTAREA elements', () => {
      const block = strategy.buildActionBlock({});
      expect(block).toContain('t === \'TEXTAREA\'');
    });

    it('defaults to value for SELECT elements', () => {
      const block = strategy.buildActionBlock({});
      expect(block).toContain('t === \'SELECT\'');
    });

    it('defaults to innerText for other elements', () => {
      const block = strategy.buildActionBlock({});
      expect(block).toContain('\'innerText\'');
    });

    it('uses provided property when specified', () => {
      const block = strategy.buildActionBlock({ property: 'customProp' });
      expect(block).toContain('const PROP = "customProp"');
      expect(block).toContain('{{ELEMENT}}[p]');
    });

    it('reads attribute when attribute option is provided', () => {
      const block = strategy.buildActionBlock({ attribute: 'data-test' });
      expect(block).toContain('const ATTR = "data-test"');
      expect(block).toContain('{{ELEMENT}}.getAttribute(ATTR)');
    });

    it('returns empty string for null attribute values', () => {
      const block = strategy.buildActionBlock({ attribute: 'missing' });
      expect(block).toMatch(/getAttribute\(ATTR\)[\s\S]*if \(raw == null\) raw = ''/);
    });

    it('returns empty string for null property values', () => {
      const block = strategy.buildActionBlock({});
      expect(block).toContain('v == null ? \'\'');
    });

    it('converts non-string values to string', () => {
      const block = strategy.buildActionBlock({});
      expect(block).toContain('typeof v === \'string\' ? v : String(v)');
    });

    describe('regex extraction', () => {
      it('includes regex pattern when provided', () => {
        const block = strategy.buildActionBlock({ regex: '\\d+' });
        expect(block).toContain('const RX = "\\\\d+"');
      });

      it('includes regex flags when provided', () => {
        const block = strategy.buildActionBlock({ regex: 'test', regexFlags: 'gi' });
        expect(block).toContain('const FLAGS = "gi"');
        expect(block).toContain('new RegExp(RX, FLAGS)');
      });

      it('returns empty string when regex does not match', () => {
        const block = strategy.buildActionBlock({ regex: 'nomatch' });
        expect(block).toMatch(/if \(!m\) return ''/);
      });

      it('returns first capture group when present', () => {
        const block = strategy.buildActionBlock({ regex: '(\\d+)' });
        expect(block).toContain('m.length > 1');
        expect(block).toContain('m[1] ?? \'\'');
      });

      it('returns full match when no capture groups', () => {
        const block = strategy.buildActionBlock({ regex: '\\d+' });
        expect(block).toContain('m.length > 1');
        expect(block).toContain(': m[0]');
      });

      it('wraps regex in try-catch and throws on bad regex', () => {
        const block = strategy.buildActionBlock({ regex: '[invalid' });
        expect(block).toContain('try {');
        expect(block).toContain('raw.match(new RegExp(RX, FLAGS))');
        expect(block).toContain('} catch (e) {');
        expect(block).toContain('throw new Error(\'Bad regex: \' + e.message)');
      });
    });

    it('uses {{ELEMENT}} placeholder throughout', () => {
      const block = strategy.buildActionBlock({});
      const matches = block.match(/\{\{ELEMENT\}\}/g);
      expect(matches?.length).toBeGreaterThan(3);
    });

    it('wraps expression in IIFE and calls with element context', () => {
      const block = strategy.buildActionBlock({});
      expect(block).toMatch(/\(\(\) => \{[\s\S]*\}\)\.call\(\{\{ELEMENT\}\}\)/);
    });

    it('escapes attribute value with JSON.stringify', () => {
      const block = strategy.buildActionBlock({ attribute: 'data-"test"' });
      expect(block).toContain('"data-\\"test\\""');
    });

    it('escapes property value with JSON.stringify', () => {
      const block = strategy.buildActionBlock({ property: 'my.prop' });
      expect(block).toContain('"my.prop"');
    });

    it('handles empty string options', () => {
      const block = strategy.buildActionBlock({ attribute: '', property: '' });
      expect(block).toContain('const ATTR = ""');
      expect(block).toContain('const PROP = ""');
    });

    it('prioritizes attribute over property when both provided', () => {
      const block = strategy.buildActionBlock({ attribute: 'href', property: 'innerText' });
      const attrIndex = block.indexOf('if (ATTR)');
      expect(attrIndex).toBeGreaterThan(-1);
      // Attribute path should be checked first
      expect(block).toContain('getAttribute(ATTR)');
    });

    it('handles complex regex patterns with special characters', () => {
      const block = strategy.buildActionBlock({ regex: '^test.*\\d+$' });
      expect(block).toContain('"^test.*\\\\d+$"');
    });
  });
});
