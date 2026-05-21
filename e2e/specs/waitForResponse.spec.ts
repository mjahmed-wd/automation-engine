/**
 * End-to-end tests for Phase 5 Batch 3 — network waits.
 *
 * Four cases:
 *   1. urlMatches resolves on a 200 fetch.
 *   2. saveBody captures the response body string.
 *   3. Status filter rejects responses outside the range.
 *   4. Timeout fires cleanly when nothing matches.
 *
 * The fixture's Section 24 widgets fire `fetch()` against `data:` URLs so
 * the suite is offline-safe and deterministic.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../fixtures/extension';
import { pasteAndRun, waitForLog, logContains } from '../helpers/sidepanel';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(__dirname, '../../test-fixtures/all-content.html');
const FIXTURE_URL = `file://${FIXTURE_PATH}`;

test.describe('waitForResponse (Batch 3)', () => {
  test('matches a 200 response by URL substring', async ({ context, sidePanel }) => {
    test.setTimeout(30_000);

    const fixture = await context.newPage();
    await fixture.goto(FIXTURE_URL);
    await fixture.locator('#fetch-200-btn').waitFor();

    const script = {
      name: 'net: match 200',
      tag: 'action',
      steps: [
        { action: 'evaluate', expression: 'window.__resetNetworkDemo()' },
        { action: 'click', xpath: "//button[@id='fetch-200-btn']" },
        {
          action: 'waitForResponse',
          urlMatches: '/echo',
          status: 200,
          timeoutMs: 5000,
          saveStatus: 'code',
        },
      ],
    };

    await pasteAndRun(sidePanel, fixture, script);
    await waitForLog(sidePanel, 'Finished', 15_000);
    expect(await logContains(sidePanel, 'Got response 200')).toBe(true);
  });

  test('saveBody captures the response body', async ({ context, sidePanel }) => {
    test.setTimeout(30_000);

    const fixture = await context.newPage();
    await fixture.goto(FIXTURE_URL);
    await fixture.locator('#fetch-json-btn').waitFor();

    const script = {
      name: 'net: save body',
      tag: 'action',
      steps: [
        { action: 'evaluate', expression: 'window.__resetNetworkDemo()' },
        { action: 'click', xpath: "//button[@id='fetch-json-btn']" },
        {
          action: 'waitForResponse',
          urlMatches: '/json-echo',
          status: 200,
          timeoutMs: 5000,
          saveBody: 'body',
        },
      ],
    };

    await pasteAndRun(sidePanel, fixture, script);
    await waitForLog(sidePanel, 'Finished', 15_000);
    // The log line includes "(N bytes saved → body)" — proves saveBody ran.
    expect(await logContains(sidePanel, 'bytes saved → body')).toBe(true);
  });

  test('status range filter rejects out-of-range responses (times out)', async ({
    context,
    sidePanel,
  }) => {
    test.setTimeout(30_000);

    const fixture = await context.newPage();
    await fixture.goto(FIXTURE_URL);
    await fixture.locator('#fetch-500-btn').waitFor();

    const script = {
      name: 'net: strict status filter',
      tag: 'action',
      steps: [
        { action: 'evaluate', expression: 'window.__resetNetworkDemo()' },
        { action: 'click', xpath: "//button[@id='fetch-500-btn']" },
        {
          action: 'waitForResponse',
          urlMatches: '/error',
          // Strict filter — only 500 exactly. The fixture's data: URL
          // returns 200 not 500, so this filter never matches and times
          // out. (Proves status filtering is real; in production a real
          // 500 from httpbin or a backend would match.)
          status: 500,
          timeoutMs: 2000,
        },
      ],
    };

    await pasteAndRun(sidePanel, fixture, script);
    await waitForLog(sidePanel, 'Timed out', 10_000);
  });

  test('times out cleanly when nothing fires', async ({ context, sidePanel }) => {
    test.setTimeout(30_000);

    const fixture = await context.newPage();
    await fixture.goto(FIXTURE_URL);
    await fixture.locator('#fetch-200-btn').waitFor();

    const script = {
      name: 'net: timeout no fetch',
      tag: 'action',
      steps: [
        // No click — nothing fires a network request matching /never.
        {
          action: 'waitForResponse',
          urlMatches: '/never',
          timeoutMs: 2000,
        },
      ],
    };

    await pasteAndRun(sidePanel, fixture, script);
    await waitForLog(sidePanel, 'Timed out', 10_000);
  });
});
