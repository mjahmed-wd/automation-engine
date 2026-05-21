import { describe, it, expect } from 'vitest';
import { HoverStrategy } from './hover-strategy';

describe('HoverStrategy', () => {
  const strategy = new HoverStrategy();

  it('has mode "hover"', () => {
    expect(strategy.mode).toBe('hover');
  });

  describe('buildActionBlock', () => {
    it('builds action block without options', () => {
      const block = strategy.buildActionBlock({});
      expect(block).toContain('{{ELEMENT}}.scrollIntoView');
      expect(block).toContain('{{ELEMENT}}.getBoundingClientRect');
    });

    it('includes scroll into view with center alignment', () => {
      const block = strategy.buildActionBlock({});
      expect(block).toContain('block: \'center\'');
      expect(block).toContain('inline: \'center\'');
    });

    it('calculates center coordinates', () => {
      const block = strategy.buildActionBlock({});
      expect(block).toContain('__r.left + __r.width / 2');
      expect(block).toContain('__r.top + __r.height / 2');
    });

    it('includes overlay hit-test for covered elements', () => {
      const block = strategy.buildActionBlock({});
      expect(block).toContain('getRootNode()');
      expect(block).toContain('elementsFromPoint');
      expect(block).toContain('!{{ELEMENT}}.contains(__top)');
    });

    it('returns fatal error when element is covered', () => {
      const block = strategy.buildActionBlock({});
      expect(block).toContain('fatal: true');
      expect(block).toContain('reason: \'covered\'');
      expect(block).toContain('Cannot hover');
      expect(block).toContain('covered by <');
    });

    it('includes element identification in covered error', () => {
      const block = strategy.buildActionBlock({});
      expect(block).toContain('__tag');
      expect(block).toContain('__ident');
      expect(block).toContain('{{ELEMENT}}.tagName');
    });

    it('includes top element tag in covered error', () => {
      const block = strategy.buildActionBlock({});
      expect(block).toContain('__topTag');
      expect(block).toContain('__top.tagName');
    });

    it('dispatches pointer events: pointerover, pointerenter, pointermove', () => {
      const block = strategy.buildActionBlock({});
      expect(block).toContain('__dispatch(PointerEvent');
      expect(block).toContain('\'pointerover\'');
      expect(block).toContain('\'pointerenter\'');
      expect(block).toContain('\'pointermove\'');
    });

    it('dispatches mouse events: mouseover, mouseenter, mousemove', () => {
      const block = strategy.buildActionBlock({});
      expect(block).toContain('__dispatch(MouseEvent');
      expect(block).toContain('\'mouseover\'');
      expect(block).toContain('\'mouseenter\'');
      expect(block).toContain('\'mousemove\'');
    });

    it('includes event options: bubbles, cancelable, composed, view, clientX, clientY', () => {
      const block = strategy.buildActionBlock({});
      expect(block).toContain('bubbles: true');
      expect(block).toContain('cancelable: true');
      expect(block).toContain('composed: true');
      expect(block).toContain('view: window');
      expect(block).toContain('clientX: __cx');
      expect(block).toContain('clientY: __cy');
    });

    it('includes pointer-specific options', () => {
      const block = strategy.buildActionBlock({});
      expect(block).toContain('pointerType: \'mouse\'');
      expect(block).toContain('pointerId: 1');
      expect(block).toContain('isPrimary: true');
    });

    it('uses __dispatch helper to safely dispatch events', () => {
      const block = strategy.buildActionBlock({});
      expect(block).toContain('const __dispatch = (Ctor, type, init) =>');
      expect(block).toContain('try { {{ELEMENT}}.dispatchEvent');
      expect(block).toContain('} catch (e) {}');
    });

    it('follows correct event sequence: pointerover → pointerenter → mouseover → mouseenter → pointermove → mousemove', () => {
      const block = strategy.buildActionBlock({});
      const pointerover = block.indexOf('\'pointerover\'');
      const pointerenter = block.indexOf('\'pointerenter\'');
      const mouseover = block.indexOf('\'mouseover\'');
      const mouseenter = block.indexOf('\'mouseenter\'');
      const pointermove = block.indexOf('\'pointermove\'');
      const mousemove = block.indexOf('\'mousemove\'');

      expect(pointerover).toBeLessThan(pointerenter);
      expect(pointerenter).toBeLessThan(mouseover);
      expect(mouseover).toBeLessThan(mouseenter);
      expect(mouseenter).toBeLessThan(pointermove);
      expect(pointermove).toBeLessThan(mousemove);
    });

    it('uses {{ELEMENT}} placeholder throughout', () => {
      const block = strategy.buildActionBlock({});
      const matches = block.match(/\{\{ELEMENT\}\}/g);
      expect(matches?.length).toBeGreaterThan(10);
    });

    it('wraps hit-test in try-catch', () => {
      const block = strategy.buildActionBlock({});
      expect(block).toMatch(/try \{[\s\S]*getRootNode[\s\S]*\} catch \(e\) \{\}/);
    });
  });
});
