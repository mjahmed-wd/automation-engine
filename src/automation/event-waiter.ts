/**
 * Generic predicate-keyed event waiter with a race-tolerant ringbuffer.
 *
 * The problem this solves: the engine subscribes to a stream of events
 * (`chrome.tabs.onCreated`, `Network.responseReceived`, etc.) and individual
 * scripted steps want to `await` the next event matching some predicate. The
 * catch is that events may fire BEFORE the step's await begins — e.g.,
 * `chrome.tabs.onCreated` fires synchronously inside the prior step's
 * `window.open` call, and by the time the next step registers a listener
 * the event is already gone. A naive listener-only design leaves the await
 * hanging until its timeout.
 *
 * EventWaiter keeps a small ringbuffer of recent events (default 30s window),
 * and `await(predicate, timeoutMs)` first scans the buffer for a match before
 * registering a future-listener. The race window vanishes.
 *
 * Used by both `tab waitForNew` (Batch 1, refactored here) and
 * `waitForResponse` (Batch 3).
 */
export interface EventWaiterOptions {
  /** How long to keep events in the ringbuffer. Default 30s. */
  windowMs?: number;
  /** Maximum number of buffered events (FIFO eviction). Default 100. */
  maxBufferSize?: number;
}

interface Waiter<T> {
  predicate: (value: T) => boolean;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class EventWaiter<T> {
  private buffer: Array<{ value: T; at: number }> = [];
  private readonly waiters = new Set<Waiter<T>>();
  private readonly windowMs: number;
  private readonly maxBufferSize: number;

  constructor(opts: EventWaiterOptions = {}) {
    this.windowMs = opts.windowMs ?? 30_000;
    this.maxBufferSize = opts.maxBufferSize ?? 100;
  }

  /**
   * Push a new event. Prunes expired buffer entries; notifies and resolves
   * any pending waiter whose predicate now matches. A single emit can
   * resolve multiple waiters if they share a predicate.
   */
  emit(value: T): void {
    this.prune();
    this.buffer.push({ value, at: Date.now() });
    if (this.buffer.length > this.maxBufferSize) this.buffer.shift();
    // Snapshot waiters before iterating — predicate callbacks may resolve and
    // remove themselves from the set, which would mutate the iterator.
    for (const w of [...this.waiters]) {
      let matched = false;
      try {
        matched = w.predicate(value);
      } catch {
        // Bad predicate — treat as non-match. The waiter will time out on
        // its own if no other event matches.
        matched = false;
      }
      if (matched) {
        clearTimeout(w.timer);
        this.waiters.delete(w);
        w.resolve(value);
      }
    }
  }

  /**
   * Resolve with the next value matching `predicate`, or reject after
   * `timeoutMs`. Race-tolerant: the ringbuffer is scanned first, so an
   * event that fired up to `windowMs` before this call will still resolve.
   */
  await(
    predicate: (value: T) => boolean,
    timeoutMs: number,
    errLabel?: string,
  ): Promise<T> {
    this.prune();
    // Buffer scan — race-tolerant fast path.
    for (const entry of this.buffer) {
      let matched = false;
      try {
        matched = predicate(entry.value);
      } catch {
        matched = false;
      }
      if (matched) return Promise.resolve(entry.value);
    }
    // No buffered match — register a future listener with a timeout.
    return new Promise<T>((resolve, reject) => {
      const handle: Waiter<T> = {
        predicate,
        resolve,
        reject,
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        timer: undefined!, // assigned below
      };
      handle.timer = setTimeout(() => {
        this.waiters.delete(handle);
        reject(
          new Error(
            `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${errLabel ?? 'event'}`,
          ),
        );
      }, timeoutMs);
      this.waiters.add(handle);
    });
  }

  /**
   * Forget the buffer and reject any pending waiters with the supplied
   * reason. Useful when a Page detaches and we want pending awaits to fail
   * cleanly rather than hang their callers.
   */
  clear(reason = 'EventWaiter cleared'): void {
    this.buffer.length = 0;
    const pending = [...this.waiters];
    this.waiters.clear();
    for (const w of pending) {
      clearTimeout(w.timer);
      w.reject(new Error(reason));
    }
  }

  /** Current buffered event count. Useful for tests/diagnostics. */
  get bufferSize(): number {
    return this.buffer.length;
  }

  /** Current pending-waiter count. Useful for tests/diagnostics. */
  get waiterCount(): number {
    return this.waiters.size;
  }

  private prune(): void {
    const cutoff = Date.now() - this.windowMs;
    while (this.buffer.length && this.buffer[0].at < cutoff) {
      this.buffer.shift();
    }
  }
}
