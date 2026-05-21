/**
 * Background service worker — entry point.
 *
 * Kept deliberately small: opens the side panel, builds a `broadcastLog`
 * that mirrors to the console + sidepanel, and dispatches incoming
 * messages by `type`. Heavier work (running scripts) lives in sibling
 * files. To add a new background-handled action:
 *
 *   1. Create a new sibling file with the function that does the work.
 *   2. Import it here and add an `else if` branch to the dispatcher.
 *
 * Messages dispatched today:
 *   { type: 'listAutomations' }                  → { ok, automations }
 *   { type: 'runJson', json, windowId }          → { ok, outputs } | { ok: false, error }
 *
 * Broadcasts (one-way, sidepanel listens):
 *   { type: 'log', level, message }
 */

import { listAutomations, type LogFn } from '@/src/automation';
import { runJsonAutomation } from './runJsonAutomation';

const broadcastLog: LogFn = (level, message) => {
  if (level === 'error') console.error('[automation]', message);
  else console.log('[automation]', message);
  chrome.runtime.sendMessage({ type: 'log', level, message }).catch(() => {});
};

export default defineBackground(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err: unknown) => console.error('sidePanel error:', err));

  // Notify sidepanel when extension is updated — prompts user to reload
  chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'update') {
      chrome.runtime.sendMessage({
        type: 'log',
        level: 'info',
        message: `Extension updated to ${chrome.runtime.getManifest().version}. Click "Reload Extension" in sidepanel if needed.`,
      });
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'listAutomations') {
      sendResponse({ ok: true, automations: listAutomations() });
      return;
    }
    if (msg?.type === 'runJson') {
      runJsonAutomation(String(msg.json ?? ''), msg.windowId, broadcastLog)
        .then((outputs) => sendResponse({ ok: true, outputs }))
        .catch((err) => {
          broadcastLog('error', `Failed: ${err?.message ?? String(err)}`);
          sendResponse({ ok: false, error: String(err?.message ?? err) });
        });
      return true;
    }
  });
});
