/**
 * Tab-API helpers shared by the engine (`page.ts`) and the background
 * dispatcher (`entrypoints/background/tabAccess.ts`). Pure-ish — no module
 * state, no debugger surface, just `chrome.tabs` wrappers.
 *
 * Lives in `src/automation/` rather than `entrypoints/background/` because
 * `Page` (in this folder) needs `parseUrlMatcher` + `waitForNewTabMatching`
 * for the multi-tab feature, and importing across the folder boundary the
 * other direction would invert our layering.
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

/** Wait until `tab.status === 'complete'` for the given tab, up to `timeoutMs`. */
export function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Timed out waiting for tab to load'));
    }, timeoutMs);
    const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => {
      if (t.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });
}

/**
 * Wait for a new tab to open in the given window whose URL matches `pattern`.
 *
 * Why both onCreated AND onUpdated: `chrome.tabs.onCreated` fires immediately
 * with `tab.url === ''` (or `'about:blank'`) and the real URL arrives later
 * via `chrome.tabs.onUpdated`. Matching on `onCreated` alone would miss the
 * real URL; matching on `onUpdated` alone would race for tabs that finish
 * loading before our listener attaches. We watch onCreated to learn the new
 * tab's id, then onUpdated to learn its URL.
 *
 * `windowId` is treated as a preference, not a hard filter. New tabs from the
 * same window are always candidates; tabs from OTHER windows are also added
 * because `window.open(_, '_blank')` on file:// origins commonly lands the
 * popup in a fresh Chrome window. Without this relaxation a strict windowId
 * gate would silently never resolve — the right tab would exist but be
 * invisible. URL matching is the real filter; window membership is
 * informational (logged but not enforced).
 *
 * Listeners cleanup on resolve / reject / timeout.
 */
export function waitForNewTabMatching(
  windowId: number | undefined,
  pattern: string | undefined,
  timeoutMs: number,
): Promise<number> {
  const matches = parseUrlMatcher(pattern);
  return new Promise<number>((resolve, reject) => {
    const candidates = new Set<number>();

    const cleanup = () => {
      clearTimeout(timer);
      chrome.tabs.onCreated.removeListener(onCreated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };

    const onCreated = (tab: chrome.tabs.Tab) => {
      if (tab.id === undefined) return;
      // Accept tabs from any window — popup window placement is unpredictable
      // and the URL match is what really gates resolution. Track windowId
      // mismatch for logs only; don't reject the tab.
      if (windowId !== undefined && tab.windowId !== windowId) {
        // Different-window candidate: still a valid match if URL fits.
      }
      candidates.add(tab.id);
      // Some pages set the URL synchronously enough that the initial Tab has
      // it. If so, take the shortcut.
      const url = tab.pendingUrl ?? tab.url ?? '';
      if (url && matches(url)) {
        cleanup();
        resolve(tab.id);
      }
    };

    const onUpdated = (
      tabId: number,
      _info: chrome.tabs.TabChangeInfo,
      tab: chrome.tabs.Tab,
    ) => {
      if (!candidates.has(tabId)) return;
      const url = tab.url ?? tab.pendingUrl ?? '';
      if (!url) return;
      if (matches(url)) {
        cleanup();
        resolve(tabId);
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for new tab` +
            (pattern ? ` matching '${pattern}'` : ''),
        ),
      );
    }, timeoutMs);

    chrome.tabs.onCreated.addListener(onCreated);
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}
