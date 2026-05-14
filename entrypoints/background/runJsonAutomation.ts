/**
 * Run a JSON automation script against the active tab.
 *
 * Parses the script, queries the active tab in the requesting window,
 * does the chrome:// pre-flight navigation if needed, attaches the
 * debugger via `Page`, runs the script through the interpreter, and
 * returns the collected outputs. Always detaches the debugger in the
 * finally block so a failed script doesn't leak the session.
 *
 * `log` is passed in from index.ts so this function stays standalone-
 * testable: pass a stub LogFn in a future Vitest setup if we want to
 * verify behavior without a real side-panel.
 */

import {
  Page,
  parseAutomation,
  runScript,
  substituteRaw,
  type ExecutionContext,
  type LogFn,
} from '@/src/automation';

import { isAttachable, waitForTabComplete } from './tabAccess';

export async function runJsonAutomation(
  json: string,
  windowId: number | undefined,
  log: LogFn,
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
        log,
      };
      const targetUrl = substituteRaw((first as any).url, preCtx);
      log(
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
    log,
  };

  const page = await Page.create(tab.id, log);
  try {
    await runScript(script, ctx, page);
    return ctx.outputs;
  } finally {
    await page.detach();
  }
}
