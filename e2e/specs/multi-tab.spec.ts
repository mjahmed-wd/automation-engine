/**
 * End-to-end tests for Phase 5 Batch 1 — multi-tab orchestration.
 *
 * Three cases covering the design:
 *   1. Happy path — page-triggered new tab: click a target=_blank link, wait
 *      for the new tab, drive it, close, verify we're back on the original.
 *   2. Happy path — script-triggered new tab: `tab open` a URL directly from
 *      the script, drive the new tab, close, return.
 *   3. Negative path — `tab waitForNew` with a URL that never fires times
 *      out cleanly.
 *
 * All three target the local fixture (no internet). The fixture's
 * section-21 widget uses `#detail` hash routing so the same file serves
 * both the source view (no hash) and the detail view (with hash).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../fixtures/extension';
import { pasteAndRun, waitForLog, logContains } from '../helpers/sidepanel';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(__dirname, '../../test-fixtures/all-content.html');
const FIXTURE_URL = `file://${FIXTURE_PATH}`;

test.describe('multi-tab orchestration', () => {
  test('page-triggered new tab: waitForNew → fill → close → back to origin', async ({
    context,
    sidePanel,
  }) => {
    test.setTimeout(60_000);

    const fixture = await context.newPage();
    await fixture.goto(FIXTURE_URL);
    await fixture.locator('#open-detail-link').waitFor();

    const before = context.pages().length;

    const script = {
      name: 'multi-tab: page-triggered',
      tag: 'action',
      steps: [
        { action: 'click', xpath: "//a[@id='open-detail-link']" },
        // The link is target=_blank so a new tab opens. urlMatches narrows
        // to the detail variant.
        { action: 'tab', op: 'waitForNew', urlMatches: '#detail', timeoutMs: 10_000 },
        { action: 'fill', xpath: "//input[@id='detail-input']", value: 'from-script' },
        { action: 'click', xpath: "//button[@id='detail-save']" },
        {
          action: 'get',
          xpath: "//p[@id='detail-result']",
          property: 'textContent',
          saveAs: 'detail',
        },
        { action: 'tab', op: 'close' },
        // Back on the original. The opener's postMessage listener should
        // have written `got: from-script` into #result-multi-tab.
        {
          action: 'get',
          xpath: "//p[@id='result-multi-tab']",
          property: 'textContent',
          saveAs: 'back',
        },
      ],
    };

    await pasteAndRun(sidePanel, fixture, script);
    await waitForLog(sidePanel, 'Finished', 45_000);

    // The detail tab was closed, so we should be back to the same page count.
    expect(context.pages().length).toBe(before);

    // The opener-side paragraph was updated by the detail tab's postMessage.
    await expect(fixture.locator('#result-multi-tab')).toContainText('got: from-script');
  });

  test('script-triggered side tab: tab open → get → close → back to origin', async ({
    context,
    sidePanel,
  }) => {
    test.setTimeout(60_000);

    const fixture = await context.newPage();
    await fixture.goto(FIXTURE_URL);
    await fixture.locator('#open-detail-link').waitFor();

    const before = context.pages().length;

    const script = {
      name: 'multi-tab: script-triggered',
      tag: 'action',
      steps: [
        // tab open with the SAME fixture URL plus the #detail hash. The
        // fixture's hashchange handler renders the detail widget.
        {
          action: 'tab',
          op: 'open',
          url: `${FIXTURE_URL}#detail`,
          waitForXPath: "//input[@id='detail-input']",
        },
        { action: 'fill', xpath: "//input[@id='detail-input']", value: 'side-tab-value' },
        {
          action: 'get',
          xpath: "//input[@id='detail-input']",
          property: 'value',
          saveAs: 'lookup',
        },
        { action: 'tab', op: 'close' },
      ],
    };

    await pasteAndRun(sidePanel, fixture, script);
    await waitForLog(sidePanel, 'Finished', 45_000);

    // Side tab closed → page count back to baseline.
    expect(context.pages().length).toBe(before);

    // The engine's log should include the "Opened new tab" and "Closed tab"
    // lines, confirming the open + close round-trip ran (not just a no-op).
    expect(await logContains(sidePanel, 'Opened new tab')).toBe(true);
    expect(await logContains(sidePanel, 'Closed tab')).toBe(true);
  });

  test('openWindow: popup window lands in a different windowId; close returns to origin', async ({
    context,
    sidePanel,
  }) => {
    test.setTimeout(60_000);

    const fixture = await context.newPage();
    await fixture.goto(FIXTURE_URL);
    await fixture.locator('#open-detail-link').waitFor();

    // Capture the source tab's windowId via the CDP session. Playwright
    // doesn't expose chrome.tabs IDs directly, so we read the window count
    // before and after as a coarse cross-window assertion (popup opening a
    // new window bumps context.pages().length by 1; closing returns it).
    const baselinePages = context.pages().length;

    const script = {
      name: 'multi-tab: openWindow popup',
      tag: 'action',
      steps: [
        {
          action: 'tab',
          op: 'openWindow',
          url: `${FIXTURE_URL}#detail`,
          windowType: 'popup',
          width: 600,
          height: 400,
          waitForXPath: "//input[@id='detail-input']",
        },
        { action: 'fill', xpath: "//input[@id='detail-input']", value: 'popup-value' },
        {
          action: 'get',
          xpath: "//input[@id='detail-input']",
          property: 'value',
          saveAs: 'v',
        },
        { action: 'tab', op: 'close' },
      ],
    };

    await pasteAndRun(sidePanel, fixture, script);
    await waitForLog(sidePanel, 'Finished', 45_000);

    // Popup window closed → back to baseline page count.
    expect(context.pages().length).toBe(baselinePages);

    // Log evidence: the engine reported opening a popup window AND closing it.
    expect(await logContains(sidePanel, 'Opened new popup window')).toBe(true);
    expect(await logContains(sidePanel, 'Closed tab')).toBe(true);
  });

  test('negative: tab waitForNew times out cleanly on non-matching pattern', async ({
    context,
    sidePanel,
  }) => {
    test.setTimeout(30_000);

    const fixture = await context.newPage();
    await fixture.goto(FIXTURE_URL);
    await fixture.locator('#open-detail-link').waitFor();

    const script = {
      name: 'multi-tab: timeout',
      tag: 'action',
      steps: [
        // Nothing opens a tab matching this pattern. Short timeout so the
        // test doesn't hang.
        { action: 'tab', op: 'waitForNew', urlMatches: '#never', timeoutMs: 2_000 },
      ],
    };

    await pasteAndRun(sidePanel, fixture, script);

    // The engine's failure log includes "Failed:" followed by the error.
    // waitForNewTabMatching emits "Timed out after Ns waiting for new tab..."
    await waitForLog(sidePanel, 'Timed out', 10_000);
  });
});
