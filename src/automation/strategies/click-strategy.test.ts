import { describe, it, expect } from 'vitest';
import { ClickStrategy } from './click-strategy';

describe('ClickStrategy', () => {
  const strategy = new ClickStrategy();

  it('has mode "click"', () => {
    expect(strategy.mode).toBe('click');
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
      expect(block).toContain('Cannot click');
      expect(block).toContain('covered by <');
    });

    it('includes element identification in covered error', () => {
      const block = strategy.buildActionBlock({});
      expect(block).toContain('__tag');
      expect(block).toContain('__ident');
      expect(block).toContain('{{ELEMENT}}.tagName');
      expect(block).toContain('{{ELEMENT}}.name');
    });

    it('includes top element tag in covered error', () => {
      const block = strategy.buildActionBlock({});
      expect(block).toContain('__topTag');
      expect(block).toContain('__top.tagName');
    });

    it('dispatches pointer events with correct options', () => {
      const block = strategy.buildActionBlock({});
      expect(block).toContain('__dispatch(PointerEvent');
      expect(block).toContain('\'pointerdown\'');
      expect(block).toContain('\'pointerup\'');
      expect(block).toContain('pointerType: \'mouse\'');
      expect(block).toContain('pointerId: 1');
      expect(block).toContain('isPrimary: true');
    });

    it('dispatches mouse events with correct options', () => {
      const block = strategy.buildActionBlock({});
      expect(block).toContain('__dispatch(MouseEvent');
      expect(block).toContain('\'mousedown\'');
      expect(block).toContain('\'mouseup\'');
      expect(block).toContain('\'click\'');
    });

    it('includes event options: bubbles, cancelable, composed, view, button, clientX, clientY', () => {
      const block = strategy.buildActionBlock({});
      expect(block).toContain('bubbles: true');
      expect(block).toContain('cancelable: true');
      expect(block).toContain('composed: true');
      expect(block).toContain('view: window');
      expect(block).toContain('button: 0');
      expect(block).toContain('clientX: __cx');
      expect(block).toContain('clientY: __cy');
    });

    it('attempts to focus element after mousedown', () => {
      const block = strategy.buildActionBlock({});
      expect(block).toContain('mousedown');
      // focus should come between mousedown and pointerup/mouseup
      const mousedownIndex = block.indexOf('mousedown');
      const focusIndex = block.indexOf('{{ELEMENT}}.focus()');
      const pointerupIndex = block.indexOf('pointerup');
      expect(mousedownIndex).toBeLessThan(focusIndex);
      expect(focusIndex).toBeLessThan(pointerupIndex);
    });

    it('uses __dispatch helper to safely dispatch events', () => {
      const block = strategy.buildActionBlock({});
      expect(block).toContain('const __dispatch = (Ctor, type, init) =>');
      expect(block).toContain('try { {{ELEMENT}}.dispatchEvent');
      expect(block).toContain('} catch (e) {}');
    });

    it('follows correct event sequence: pointerdown → mousedown → focus → pointerup → mouseup → click', () => {
      const block = strategy.buildActionBlock({});
      const pointerdown = block.indexOf('\'pointerdown\'');
      const mousedown = block.indexOf('\'mousedown\'');
      const pointerup = block.indexOf('\'pointerup\'');
      const mouseup = block.indexOf('\'mouseup\'');
      const click = block.indexOf('\'click\'');

      expect(pointerdown).toBeLessThan(mousedown);
      expect(mousedown).toBeLessThan(pointerup);
      expect(pointerup).toBeLessThan(mouseup);
      expect(mouseup).toBeLessThan(click);
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

    it('wraps focus call in try-catch', () => {
      const block = strategy.buildActionBlock({});
      expect(block).toMatch(/try \{[\s\S]*focus[\s\S]*\} catch \(e\) \{\}/);
    });
  });
});
