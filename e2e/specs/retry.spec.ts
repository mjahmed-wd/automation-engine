/**
 * End-to-end tests for Phase 5 Batch 2 — step retry policy.
 *
 * Three cases:
 *   1. Baseline: a `click` with `timeoutMs: 500` and no retries fails-fast
 *      against a button that doesn't appear for 1.2s.
 *   2. With `retries: 3, retryDelay: 500`, the same target succeeds — the
 *      side panel log shows multiple "Attempt N/4 failed" lines before
 *      "Step click succeeded on retry K".
 *   3. Covered-overlay scenario: a button under an auto-dismissing overlay.
 *      A click with retries waits past the dismissal and lands on the
 *      underlying button. This pins the policy decision that `covered`
 *      reasons retry by default (Batch 2 design).
 *
 * The fixture's section 23 widgets are designed for these tests:
 *   - #late-btn: hidden on load, revealed by setTimeout(1200ms)
 *   - #retry-covered-btn: overlay removes itself via setTimeout(1500ms)
 * Both timers restart on every page load, so the spec navigates fresh
 * before each scenario.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../fixtures/extension';
import { pasteAndRun, waitForLog, logContains } from '../helpers/sidepanel';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(__dirname, '../../test-fixtures/all-content.html');
const FIXTURE_URL = `file://${FIXTURE_PATH}`;

test.describe('retry policy (Batch 2)', () => {
  test('baseline: no retries → click fails fast on the late-appearing button', async ({
    context,
    sidePanel,
  }) => {
    test.setTimeout(30_000);

    const fixture = await context.newPage();
    await fixture.goto(FIXTURE_URL);
    await fixture.locator('#evaluate-target').waitFor();

    const script = {
      name: 'retry baseline: no retries',
      tag: 'action',
      steps: [
        // Reset starts a fresh 1.2s timer so the late button is hidden when
        // the click attempt fires. Without this, the human/CI runner's setup
        // delay would let the page-load timer fire before the click runs and
        // the test would silently pass for the wrong reason.
        { action: 'evaluate', expression: 'window.__resetRetryDemo()' },
        // 500ms timeout, no retries → the button (1.2s delay) is never seen.
        {
          action: 'click',
          xpath: "//button[@id='late-btn']",
          timeoutMs: 500,
        },
      ],
    };

    await pasteAndRun(sidePanel, fixture, script);
    // The run should end in a Failed: line containing the not-found message.
    await waitForLog(sidePanel, 'Failed', 10_000);
    // And the result paragraph must still say "not clicked".
    await expect(fixture.locator('#result-late')).toContainText('not clicked');
  });

  test('with retries: late-appearing button succeeds after retries', async ({
    context,
    sidePanel,
  }) => {
    test.setTimeout(30_000);

    // Fresh page → 1.2s timer resets again. (Re-using the previous page
    // would leave the button already visible.)
    const fixture = await context.newPage();
    await fixture.goto(FIXTURE_URL);
    await fixture.locator('#evaluate-target').waitFor();

    const script = {
      name: 'retry: late button',
      tag: 'action',
      steps: [
        { action: 'evaluate', expression: 'window.__resetRetryDemo()' },
        {
          action: 'click',
          xpath: "//button[@id='late-btn']",
          timeoutMs: 500,
          retries: 3,
          retryDelay: 500,
        },
      ],
    };

    await pasteAndRun(sidePanel, fixture, script);
    await waitForLog(sidePanel, 'Finished', 20_000);

    // Side panel log should show at least one retry attempt before success.
    expect(await logContains(sidePanel, 'Retrying in 500ms')).toBe(true);
    expect(await logContains(sidePanel, 'succeeded on retry')).toBe(true);

    // Result paragraph confirms the click landed.
    await expect(fixture.locator('#result-late')).toContainText('clicked');
  });

  test('covered overlay: click retries past the auto-dismiss', async ({
    context,
    sidePanel,
  }) => {
    test.setTimeout(30_000);

    const fixture = await context.newPage();
    await fixture.goto(FIXTURE_URL);
    await fixture.locator('#evaluate-target').waitFor();

    const script = {
      name: 'retry: covered overlay clears',
      tag: 'action',
      steps: [
        { action: 'evaluate', expression: 'window.__resetRetryDemo()' },
        {
          action: 'click',
          xpath: "//button[@id='retry-covered-btn']",
          timeoutMs: 1000,
          retries: 3,
          retryDelay: 700,
        },
      ],
    };

    await pasteAndRun(sidePanel, fixture, script);
    await waitForLog(sidePanel, 'Finished', 20_000);

    // Click went through after the overlay cleared.
    await expect(fixture.locator('#retry-result-covered')).toContainText('clicked');
  });
});
