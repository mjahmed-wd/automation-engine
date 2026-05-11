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
  chrome.runtime.sendMessage({ type: 'log', level, message }).catch(() => {
    /* sidepanel may be closed */
  });
};

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
