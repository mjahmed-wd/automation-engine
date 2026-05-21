/**
 * CDPPort — Low-level Chrome DevTools Protocol messaging interface.
 *
 * Owns the request/response pairing (pending Map), message ID generation,
 * and chrome.debugger event routing. This is the seam that makes all other
 * modules testable — mock CDPPort instead of chrome.debugger.
 *
 * Extracted from Page class during Phase 1 of architecture refactoring.
 */

export type Target = chrome.debugger.Debuggee;

const PROTOCOL_VERSION = '1.3';
const CHILD_CMD_TIMEOUT_MS = 10_000;

interface PendingSlot {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
}

export type EventCallback = (target: Target, method: string, params: any) => void;

export class CDPPort {
  private readonly pending = new Map<number, PendingSlot>();
  private nextMsgId = 1;
  private listener?: EventCallback;
  private detached = false;

  /**
   * Attach chrome.debugger to a target and register the event listener.
   * Call once during initialization.
   */
  async attach(target: Target): Promise<void> {
    if (this.detached) throw new Error('CDPPort: already detached');
    return new Promise((resolve, reject) => {
      chrome.debugger.attach(target, PROTOCOL_VERSION, () => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve();
      });
    });
  }

  /**
   * Detach from all targets and clean up event listener.
   */
  detach(): void {
    this.detached = true;
    if (this.listener) chrome.debugger.onEvent.removeListener(this.listener);
    this.listener = undefined;
    this.pending.clear();
  }

  /**
   * Register callback for CDP events. The callback receives all events
   * from all attached targets. Callers must route based on target.tabId.
   *
   * Special handling: Target.receivedMessageFromTarget is handled internally
   * to resolve pending child-session requests. Other events are forwarded.
   */
  onEvent(callback: EventCallback): void {
    if (this.detached) throw new Error('CDPPort: cannot add listener after detach');
    this.listener = callback;

    chrome.debugger.onEvent.addListener((source, method, params) => {
      if (!this.listener || source.tabId === undefined) return;

      // Child session responses resolve pending requests directly
      if (method === 'Target.receivedMessageFromTarget') {
        let msg: any;
        try {
          msg = JSON.parse((params as { message?: string })?.message ?? '{}');
        } catch {
          return;
        }
        if (msg.id != null && this.pending.has(msg.id)) {
          const slot = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) slot.reject(new Error(msg.error.message ?? `code ${msg.error.code}`));
          else slot.resolve(msg.result);
          return; // Don't forward to callback
        }
      }

      // Forward all other events to the callback
      this.listener(source, method, params);
    });
  }

  /**
   * Send a CDP command and await the response. Used for direct CDP calls
   * (DOM.*, Runtime.*, Page.*, etc.) on the main page target.
   */
  sendCommand<T = any>(
    target: Target,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    if (this.detached) throw new Error('CDPPort: cannot send command after detach');
    return new Promise((resolve, reject) => {
      chrome.debugger.sendCommand(target, method, params, (result) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(`${method}: ${err.message}`));
        else resolve(result as T);
      });
    });
  }

  /**
   * Send a CDP command to a child session (OOPIF or closed shadow root).
   * Uses Target.sendMessageToTarget with request/response pairing.
   */
  sendToChild<T = any>(
    target: Target,
    sessionId: string,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    if (this.detached) throw new Error('CDPPort: cannot send child command after detach');
    return new Promise((resolve, reject) => {
      const id = this.nextMsgId++;
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} (child) timed out`));
        }
      }, CHILD_CMD_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: (v: any) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      });

      this.sendCommand(target, 'Target.sendMessageToTarget', {
        sessionId,
        message: JSON.stringify({ id, method, params }),
      }).catch((err) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      });
    });
  }
}
