/**
 * NetworkMonitor — HTTP response buffering and tracking for `waitForResponse`.
 *
 * Extracted from Page class during Phase 3 of architecture refactoring.
 * Owns per-tab EventWaiters for response buffering and request method tracking.
 * Routes Network.responseReceived and Network.requestWillBeSent CDP events.
 */

import type { LogFn } from './schema';
import { EventWaiter } from './event-waiter';
import type { CDPPort } from './cdp-port';
import type { Target } from './cdp-port';

/**
 * Normalised shape of a network response event.
 */
export interface NetworkResponse {
  requestId: string;
  url: string;
  status: number;
  /** HTTP method (uppercase), reconstructed from Network.requestWillBeSent. */
  method: string;
  /** Whether the response body has been read out. Populated when saveBody: true. */
  bodyRead?: boolean;
}

/**
 * Per-tab network state.
 */
interface TabNetworkState {
  waiter: EventWaiter<NetworkResponse>;
  requestMethods: Map<string, { method: string; at: number }>;
}

interface WaitForResponseOpts {
  urlMatches: string;
  status?: number | number[] | Record<string, number>;
  method?: string;
  timeoutMs?: number;
  saveBody?: boolean;
}

type UrlMatcher = (url: string) => boolean;
type StatusPredicate = (status: number) => boolean;

function buildStatusPredicate(
  status: number | number[] | Record<string, number> | undefined,
): StatusPredicate {
  if (status === undefined) return () => true;
  if (typeof status === 'number') return (s) => s === status;
  if (Array.isArray(status)) return (s) => status.includes(s);
  // Record<string, number> is like { 200: 5, 404: 2 } — status must exist as key
  return (s) => Object.prototype.hasOwnProperty.call(status, s);
}

function describeResponseFilter(opts: WaitForResponseOpts): string {
  const parts = [`url~${opts.urlMatches}`];
  if (opts.status !== undefined) parts.push(`status=${JSON.stringify(opts.status)}`);
  if (opts.method) parts.push(`method=${opts.method}`);
  return parts.join(', ');
}

export class NetworkMonitor {
  private readonly log: LogFn;
  private readonly cdpPort: CDPPort;
  /** Per-tab network state. */
  private readonly tabs = new Map<number, TabNetworkState>();

  constructor(log: LogFn, cdpPort: CDPPort) {
    this.log = log;
    this.cdpPort = cdpPort;
  }

  /**
   * Get or create network state for a tab.
   */
  private getTabState(tabId: number): TabNetworkState {
    let state = this.tabs.get(tabId);
    if (!state) {
      state = {
        waiter: new EventWaiter<NetworkResponse>({
          windowMs: 30_000,
          maxBufferSize: 200,
        }),
        requestMethods: new Map(),
      };
      this.tabs.set(tabId, state);
    }
    return state;
  }

  /**
   * Clean up network state for a tab.
   */
  cleanup(tabId: number): void {
    const state = this.tabs.get(tabId);
    if (state) {
      state.waiter.clear('NetworkMonitor cleanup');
      this.tabs.delete(tabId);
    }
  }

  /**
   * Handle Network.requestWillBeSent CDP event.
   * Records the HTTP method for later lookup in responseReceived.
   */
  onRequest(tabId: number, requestId: string, method: string): void {
    const state = this.getTabState(tabId);
    state.requestMethods.set(requestId, {
      method: method.toUpperCase(),
      at: Date.now(),
    });

    // Prune old entries (>60s) to bound memory.
    const cutoff = Date.now() - 60_000;
    if (state.requestMethods.size > 200) {
      for (const [id, entry] of state.requestMethods) {
        if (entry.at < cutoff) state.requestMethods.delete(id);
      }
    }
  }

  /**
   * Handle Network.responseReceived CDP event.
   * Emits to the EventWaiter for waitForResponse to consume.
   */
  onResponse(tabId: number, requestId: string, url: string, status: number): void {
    const state = this.tabs.get(tabId);
    if (!state) return;

    const methodEntry = state.requestMethods.get(requestId);
    state.requestMethods.delete(requestId);

    state.waiter.emit({
      requestId,
      url,
      status,
      method: methodEntry?.method ?? '',
    });
  }

  /**
   * Wait for the next response matching the predicates.
   * Returns the response, optionally with body if saveBody: true.
   */
  async waitForResponse(
    tabId: number,
    target: Target,
    opts: WaitForResponseOpts,
  ): Promise<NetworkResponse & { body?: string }> {
    const state = this.getTabState(tabId);
    const timeoutMs = opts.timeoutMs ?? 30_000;

    const urlPred: UrlMatcher = (() => {
      try {
        const regex = new RegExp(opts.urlMatches);
        return (url: string) => regex.test(url);
      } catch {
        return () => false;
      }
    })();

    const statusPred = buildStatusPredicate(opts.status);
    const method = opts.method?.toUpperCase();
    const methodPred = method
      ? (m: string) => m === method
      : () => true;

    const predicate = (r: NetworkResponse): boolean =>
      urlPred(r.url) && statusPred(r.status) && methodPred(r.method);

    const matched = await state.waiter.await(
      predicate,
      timeoutMs,
      describeResponseFilter(opts),
    );

    let body: string | undefined;
    if (opts.saveBody) {
      body = await this.fetchResponseBody(target, matched.requestId);
      matched.bodyRead = true;
    }
    return { ...matched, body };
  }

  /**
   * Read the body of a previously-received response via Network.getResponseBody.
   * Decodes base64 transparently.
   */
  private async fetchResponseBody(target: Target, requestId: string): Promise<string> {
    try {
      const res = await this.cdpPort.sendCommand<any>(target, 'Network.getResponseBody', {
        requestId,
      });
      const body = String(res?.body ?? '');
      if (res?.base64Encoded) {
        try {
          return atob(body);
        } catch {
          return body;
        }
      }
      return body;
    } catch (err: any) {
      this.log(
        'info',
        `getResponseBody for ${requestId} failed: ${err?.message ?? err}. Returning empty string.`,
      );
      return '';
    }
  }
}
