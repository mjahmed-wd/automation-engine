/**
 * InputExecutor — CDP Input.dispatch* operations for keyboard and mouse.
 *
 * Extracted from Page class during Phase 5 of architecture refactoring.
 * Owns trusted click/mouse-move dispatch, key press handling, and key-to-CDP mapping.
 */

import type { LogFn, Locator } from './schema';
import type { CDPPort } from './cdp-port';
import type { Target } from './cdp-port';

export class InputExecutor {
  private readonly log: LogFn;
  private readonly cdpPort: CDPPort;

  constructor(log: LogFn, cdpPort: CDPPort) {
    this.log = log;
    this.cdpPort = cdpPort;
  }

  /**
   * Send a trusted left-click at (x, y) in the tab's viewport coordinates.
   * Uses CDP Input.dispatchMouseEvent for native event dispatch.
   */
  async dispatchTrustedClick(target: Target, x: number, y: number): Promise<void> {
    await this.cdpPort.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
    });
    await this.cdpPort.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await this.cdpPort.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
  }

  /**
   * Trusted cursor-move via CDP. Triggers CSS `:hover` natively, plus all
   * pointer/mouse hover events Chrome would normally dispatch.
   */
  async dispatchTrustedMouseMove(target: Target, x: number, y: number): Promise<void> {
    await this.cdpPort.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
    });
  }

  /**
   * Press a keyboard key. If a locator is provided, the element is focused first
   * (via CDP DOM resolution so it works in closed shadow roots).
   *
   * Uses CDP Input.dispatchKeyEvent for native keyboard events.
   */
  async press(
    target: Target,
    key: string,
    opts: {
      locator?: Locator;
      focusElement?: (send: (m: string, p?: Record<string, unknown>) => Promise<any>, xpath: string) => Promise<void>;
    } = {},
  ): Promise<void> {
    if (opts.locator && opts.focusElement) {
      await opts.focusElement(
        (m, p) => this.cdpPort.sendCommand(target, m, p),
        opts.locator.xpath,
      );
    }

    const params = mapKeyToCdp(key);
    await this.cdpPort.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      ...params,
    });
    await this.cdpPort.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      ...params,
    });
    this.log('success', `Pressed "${key}".`);
  }
}

/**
 * Map a friendly key name to the params CDP `Input.dispatchKeyEvent` expects.
 * Covers Enter, Tab, Escape, arrow keys, Backspace, Delete, Space — the keys
 * an automation actually needs. For anything else we fall back to treating
 * the key as a single character (best-effort, no synthetic shift handling).
 */
export function mapKeyToCdp(key: string): {
  key: string;
  code: string;
  windowsVirtualKeyCode?: number;
  text?: string;
} {
  switch (key) {
    case 'Enter':
      return { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' };
    case 'Tab':
      return { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 };
    case 'Escape':
      return { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 };
    case 'Backspace':
      return { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 };
    case 'Delete':
      return { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 };
    case 'ArrowDown':
      return { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 };
    case 'ArrowUp':
      return { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 };
    case 'ArrowLeft':
      return { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 };
    case 'ArrowRight':
      return { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 };
    case ' ':
    case 'Space':
      return { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' };
    default:
      return { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, text: key };
  }
}
