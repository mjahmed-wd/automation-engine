/**
 * Tab-API helpers shared by the engine (`page.ts`) and the background
 * dispatcher (`entrypoints/background/tabAccess.ts`). Pure-ish — no module
 * state, no debugger surface, just `chrome.tabs` wrappers.
 *
 * Lives in `src/automation/` rather than `entrypoints/background/` because
 * `Page` (in this folder) needs these helpers for the multi-tab feature, and
 * importing across the folder boundary the other direction would invert our
 * layering.
 *
 * NOTE: the standalone `waitForNewTabMatching` helper that used to live here
 * was removed in Batch 3. Its job is now done by an always-on `EventWaiter`
 * inside `Page` that's populated by `chrome.tabs.onCreated` + `onUpdated`
 * listeners registered at `Page.init` time. See `Page.waitForNewTab` and
 * `event-waiter.ts`. The on-demand listener pattern that used to live here
 * had a race window: `chrome.tabs.onCreated` could fire BEFORE the listener
 * attached if the prior step's `window.open` ran synchronously inside its
 * click handler. EventWaiter's ringbuffer closes that window cleanly.
 */

/** Browser-internal URLs that chrome.debugger.attach() refuses to touch. */
export function isAttachable(url: string | undefined): boolean {
  if (!url) return false;
  return !(
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('edge://') ||
    url.startsWith('brave://') ||
    url.startsWith('about:') ||
    url.startsWith('devtools://')
  );
}

/**
 * Parse a `urlMatches` value into a predicate. Plain strings are substring
 * matches; `/regex/flags` syntax is parsed as a RegExp. Anything malformed
 * falls back to substring so a user typo doesn't throw mid-listener.
 */
export function parseUrlMatcher(pattern: string | undefined): (url: string) => boolean {
  if (!pattern) return () => true;
  const m = pattern.match(/^\/(.+)\/([gimsuy]*)$/);
  if (m) {
    try {
      const re = new RegExp(m[1], m[2]);
      return (url) => re.test(url);
    } catch {
      // Fall through to substring on bad regex.
    }
  }
  return (url) => url.includes(pattern);
}

/**
 * Wait until `tab.status === 'complete'` for the given tab, up to `timeoutMs`.
 *
 * Race-tolerant: in addition to listening for `onUpdated`, also polls
 * `chrome.tabs.get` every 250ms. This catches the case where the
 * `'complete'` event fires before the listener attaches (common in
 * Playwright's persistent context, where event timing differs from a normal
 * user-driven Chrome). Polling overhead is negligible — at most a handful of
 * chrome.tabs.get calls before resolve.
 */
export function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poller);
      chrome.tabs.onUpdated.removeListener(listener);
      err ? reject(err) : resolve();
    };

    const timer = setTimeout(
      () => finish(new Error('Timed out waiting for tab to load')),
      timeoutMs,
    );

    const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(listener);

    // Race fallback: poll the tab status. If the 'complete' event fired
    // before the listener attached (Playwright is fast enough that this
    // happens consistently for file:// loads), the poller catches it
    // within 250ms instead of waiting forever for an event that won't
    // come.
    const poller = setInterval(() => {
      chrome.tabs
        .get(tabId)
        .then((t) => {
          if (t.status === 'complete') finish();
        })
        .catch(() => {
          /* tab may have been closed mid-wait; let timeout handle it */
        });
    }, 250);

    // Immediate check — fast path for already-complete tabs.
    chrome.tabs
      .get(tabId)
      .then((t) => {
        if (t.status === 'complete') finish();
      })
      .catch(() => {});
  });
}
