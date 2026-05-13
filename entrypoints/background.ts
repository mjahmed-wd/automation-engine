/**
 * Background service worker — message dispatcher.
 *
 *   { type: 'listAutomations' }                   -> automation summaries (for the example dropdown)
 *   { type: 'runJson', json, windowId }           -> parses + runs a JSON automation, returns outputs
 *
 * Broadcasts:
 *   { type: 'log', level, message }               -> sidepanel
 */

import {
  Page,
  listAutomations,
  parseAutomation,
  runScript,
  substituteRaw,
  type ExecutionContext,
  type LogFn,
} from '@/src/automation';

export default defineBackground(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err: unknown) => console.error('sidePanel error:', err));

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'listAutomations') {
      sendResponse({ ok: true, automations: listAutomations() });
      return;
    }
    if (msg?.type === 'runJson') {
      runJsonAutomation(String(msg.json ?? ''), msg.windowId)
        .then((outputs) => sendResponse({ ok: true, outputs }))
        .catch((err) => {
          broadcastLog('error', `Failed: ${err?.message ?? String(err)}`);
          sendResponse({ ok: false, error: String(err?.message ?? err) });
        });
      return true;
    }
  });
});

const broadcastLog: LogFn = (level, message) => {
  if (level === 'error') console.error('[automation]', message);
  else console.log('[automation]', message);
  chrome.runtime.sendMessage({ type: 'log', level, message }).catch(() => {});
};

/** Browser-internal URLs that chrome.debugger.attach() refuses to touch. */
function isAttachable(url: string | undefined): boolean {
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

/** Wait until tab.status === 'complete', up to timeoutMs. */
function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
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

async function runJsonAutomation(
  json: string,
  windowId: number | undefined,
): Promise<Record<string, string>> {
  // Parse first so a typo fails before we attach the debugger.
  const script = parseAutomation(json);

  const query: chrome.tabs.QueryInfo = { active: true };
  if (typeof windowId === 'number') query.windowId = windowId;
  else query.lastFocusedWindow = true;
  const [tab] = await chrome.tabs.query(query);
  if (!tab?.id) throw new Error('Could not find an active tab');

  // Pre-flight: chrome.debugger.attach() refuses chrome://, chrome-extension://,
  // about:blank, etc. If the script starts with `goto`, navigate the tab via
  // the regular tabs API first (no debugger needed), then attach.
  if (!isAttachable(tab.url)) {
    const first = script.steps[0];
    if (first && first.action === 'goto' && (first as any).url) {
      const preCtx: ExecutionContext = {
        variables: { ...(script.variables ?? {}) },
        outputs: {},
        log: broadcastLog,
      };
      const targetUrl = substituteRaw((first as any).url, preCtx);
      broadcastLog(
        'info',
        `Tab is on ${tab.url ?? 'an internal page'} — pre-navigating to ${targetUrl} before attach.`,
      );
      await chrome.tabs.update(tab.id, { url: targetUrl, active: true });
      await waitForTabComplete(tab.id, 30_000);
    } else {
      throw new Error(
        `Cannot run automation on ${tab.url ?? 'this page'} — Chrome blocks debugger access to ` +
          `chrome:// / chrome-extension:// / about: URLs. Either navigate to a normal site first, ` +
          `or start your script with a "goto" step.`,
      );
    }
  }

  const ctx: ExecutionContext = {
    variables: {},
    outputs: {},
    log: broadcastLog,
  };

  const page = await Page.create(tab.id, broadcastLog);
  try {
    await runScript(script, ctx, page);
    return ctx.outputs;
  } finally {
    await page.detach();
  }
}
