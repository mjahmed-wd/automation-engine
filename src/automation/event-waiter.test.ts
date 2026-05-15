/**
 * Unit tests for EventWaiter — the predicate-keyed waiter with ringbuffer
 * that backs `tab waitForNew` and `waitForResponse`.
 *
 * Key invariants to pin:
 *   - emit before await still resolves (the race-tolerance the abstraction
 *     exists to provide)
 *   - emit after await resolves
 *   - timeout rejects with a useful label
 *   - ringbuffer prunes by time and by size
 *   - clear() rejects pending waiters and empties the buffer
 *   - predicate throws are tolerated (waiter continues waiting)
 *   - multiple waiters can be awaiting concurrently
 */

import { describe, expect, it, vi } from 'vitest';
import { EventWaiter } from './event-waiter';

describe('EventWaiter — basic emit/await', () => {
  it('await resolves immediately when a buffered event matches (emit-before-await)', async () => {
    const w = new EventWaiter<{ url: string }>();
    w.emit({ url: '/foo' });
    w.emit({ url: '/bar' });
    const result = await w.await((v) => v.url === '/bar', 1000);
    expect(result.url).toBe('/bar');
  });

  it('await resolves when a matching event arrives later (emit-after-await)', async () => {
    const w = new EventWaiter<{ url: string }>();
    const pending = w.await((v) => v.url === '/late', 1000);
    setTimeout(() => w.emit({ url: '/late' }), 10);
    const result = await pending;
    expect(result.url).toBe('/late');
  });

  it('await rejects with a useful message on timeout', async () => {
    const w = new EventWaiter<{ url: string }>();
    await expect(
      w.await((v) => v.url === '/never', 50, "URL matching '/never'"),
    ).rejects.toThrow(/Timed out after 0s waiting for URL matching '\/never'/);
  });

  it('ignores non-matching events in the buffer', async () => {
    const w = new EventWaiter<{ url: string }>();
    w.emit({ url: '/foo' });
    w.emit({ url: '/bar' });
    w.emit({ url: '/baz' });
    const result = await w.await((v) => v.url === '/bar', 100);
    expect(result.url).toBe('/bar');
  });
});

describe('EventWaiter — ringbuffer eviction', () => {
  it('prunes events older than windowMs', async () => {
    // Use a tiny window so we don't have to wait long in the test.
    const w = new EventWaiter<{ url: string }>({ windowMs: 20 });
    w.emit({ url: '/old' });
    await new Promise<void>((r) => setTimeout(r, 30));
    // Now /old is past the window; another emit triggers a prune.
    w.emit({ url: '/new' });
    expect(w.bufferSize).toBe(1);
    // Awaiting /old should fall through to a future-listener (and time out).
    await expect(
      w.await((v) => v.url === '/old', 30, "'/old'"),
    ).rejects.toThrow(/Timed out/);
  });

  it('caps buffer at maxBufferSize via FIFO eviction', () => {
    const w = new EventWaiter<{ i: number }>({ maxBufferSize: 3 });
    w.emit({ i: 1 });
    w.emit({ i: 2 });
    w.emit({ i: 3 });
    w.emit({ i: 4 });
    expect(w.bufferSize).toBe(3);
    // i=1 was evicted, so awaiting it falls through to the future-listener.
    return expect(
      w.await((v) => v.i === 1, 20, 'evicted'),
    ).rejects.toThrow(/Timed out/);
  });
});

describe('EventWaiter — clear() behavior', () => {
  it('clear() rejects pending waiters with the supplied reason', async () => {
    const w = new EventWaiter<{ url: string }>();
    const pending = w.await((v) => v.url === '/never', 5_000);
    w.clear('detach in progress');
    await expect(pending).rejects.toThrow(/detach in progress/);
  });

  it('clear() empties the buffer', () => {
    const w = new EventWaiter<{ url: string }>();
    w.emit({ url: '/x' });
    expect(w.bufferSize).toBe(1);
    w.clear();
    expect(w.bufferSize).toBe(0);
    expect(w.waiterCount).toBe(0);
  });
});

describe('EventWaiter — error tolerance', () => {
  it("tolerates a throwing predicate and keeps the waiter waiting", async () => {
    const w = new EventWaiter<{ url: string }>();
    let firstCall = true;
    const predicate = (v: { url: string }) => {
      if (firstCall) {
        firstCall = false;
        throw new Error('first-call boom');
      }
      return v.url === '/second';
    };
    const pending = w.await(predicate, 200);
    w.emit({ url: '/triggers-throw' }); // predicate throws on this
    setTimeout(() => w.emit({ url: '/second' }), 10); // predicate succeeds
    const result = await pending;
    expect(result.url).toBe('/second');
  });
});

describe('EventWaiter — concurrent waiters', () => {
  it('resolves multiple waiters that match the same emit', async () => {
    const w = new EventWaiter<{ url: string }>();
    const a = w.await((v) => v.url.includes('match'), 200);
    const b = w.await((v) => v.url === '/match', 200);
    w.emit({ url: '/match' });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.url).toBe('/match');
    expect(rb.url).toBe('/match');
  });

  it("resolves only the waiter whose predicate matches", async () => {
    const w = new EventWaiter<{ url: string }>();
    const wantsBar = w.await((v) => v.url === '/bar', 50);
    const wantsBaz = w.await((v) => v.url === '/baz', 5_000);
    w.emit({ url: '/bar' });
    expect(await wantsBar).toEqual({ url: '/bar' });
    // wantsBaz is still pending; emit and verify it resolves.
    w.emit({ url: '/baz' });
    expect(await wantsBaz).toEqual({ url: '/baz' });
  });
});

describe('EventWaiter — diagnostics', () => {
  it('bufferSize / waiterCount expose internal state', async () => {
    const w = new EventWaiter<{ i: number }>();
    expect(w.bufferSize).toBe(0);
    expect(w.waiterCount).toBe(0);
    w.emit({ i: 1 });
    expect(w.bufferSize).toBe(1);
    const pending = w.await((v) => v.i === 99, 1000);
    expect(w.waiterCount).toBe(1);
    // Tidy up so the test doesn't leak a pending timer.
    w.clear();
    await expect(pending).rejects.toThrow();
  });
});
