/**
 * End-to-end tests for Phase 5 Batch 4 — conditional + loops.
 *
 * Four cases:
 *   1. if-then path fires when banner is shown.
 *   2. if-else path fires when banner is hidden (instant `wait: false`).
 *   3. forEach iterates over a JSON array, clicks each row.
 *   4. Nested forEach + if: iterate over rows, click each, conditionally
 *      click Retry if a banner appears.
 *
 * All four target the fixture's Section 25 widgets and use the
 * `window.__resetBranchingDemo()` helper for repeatable state.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../fixtures/extension';
import { pasteAndRun, waitForLog } from '../helpers/sidepanel';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(__dirname, '../../test-fixtures/all-content.html');
const FIXTURE_URL = `file://${FIXTURE_PATH}`;

test.describe('branching (Batch 4)', () => {
  test('if-then fires when banner is shown', async ({ context, sidePanel }) => {
    test.setTimeout(30_000);

    const fixture = await context.newPage();
    await fixture.goto(FIXTURE_URL);
    await fixture.locator('#branch-banner-toggle').waitFor();

    const script = {
      name: 'branching: if-then',
      tag: 'action',
      steps: [
        { action: 'evaluate', expression: 'window.__resetBranchingDemo({ banner: true })' },
        {
          action: 'if',
          xpathExists:
            "//div[@id='branch-banner' and not(contains(@style, 'display: none'))]",
          timeoutMs: 500,
          then: [{ action: 'click', xpath: "//button[@id='branch-retry-btn']" }],
          else: [
            {
              action: 'evaluate',
              expression:
                "document.getElementById('branch-result-if').textContent = 'no-banner-path'",
            },
          ],
        },
        {
          action: 'get',
          xpath: "//p[@id='branch-result-if']",
          property: 'textContent',
          saveAs: 'out',
        },
      ],
    };

    await pasteAndRun(sidePanel, fixture, script);
    await waitForLog(sidePanel, 'Finished', 15_000);
    await expect(fixture.locator('#branch-result-if')).toContainText('retried');
  });

  test('if-else fires when banner is hidden (wait: false)', async ({
    context,
    sidePanel,
  }) => {
    test.setTimeout(30_000);

    const fixture = await context.newPage();
    await fixture.goto(FIXTURE_URL);
    await fixture.locator('#branch-banner-toggle').waitFor();

    const script = {
      name: 'branching: if-else instant',
      tag: 'action',
      steps: [
        { action: 'evaluate', expression: 'window.__resetBranchingDemo({ banner: false })' },
        {
          action: 'if',
          xpathExists:
            "//div[@id='branch-banner' and not(contains(@style, 'display: none'))]",
          wait: false,
          then: [{ action: 'click', xpath: "//button[@id='branch-retry-btn']" }],
          else: [
            {
              action: 'evaluate',
              expression:
                "document.getElementById('branch-result-if').textContent = 'no-banner-path'",
            },
          ],
        },
      ],
    };

    await pasteAndRun(sidePanel, fixture, script);
    await waitForLog(sidePanel, 'Finished', 15_000);
    await expect(fixture.locator('#branch-result-if')).toContainText(
      'no-banner-path',
    );
  });

  test('forEach iterates over a JSON array and clicks each row', async ({
    context,
    sidePanel,
  }) => {
    test.setTimeout(30_000);

    const fixture = await context.newPage();
    await fixture.goto(FIXTURE_URL);
    await fixture.locator('.branch-row-btn').first().waitFor();

    const script = {
      name: 'branching: forEach array',
      tag: 'action',
      steps: [
        { action: 'evaluate', expression: 'window.__resetBranchingDemo()' },
        {
          action: 'forEach',
          as: 'id',
          items: ['A', 'B', 'C', 'D', 'E'],
          do: [
            {
              action: 'click',
              xpath:
                "//button[contains(concat(' ', normalize-space(@class), ' '), ' branch-row-btn ') and @data-id='{{id}}']",
            },
          ],
        },
      ],
    };

    await pasteAndRun(sidePanel, fixture, script);
    await waitForLog(sidePanel, 'Finished', 20_000);

    // Verify all 5 row results became "done".
    for (const id of ['A', 'B', 'C', 'D', 'E']) {
      await expect(
        fixture.locator(`.branch-row-result[data-id="${id}"]`),
      ).toContainText('done');
    }
  });

  test('nested forEach + if works end-to-end', async ({ context, sidePanel }) => {
    test.setTimeout(30_000);

    const fixture = await context.newPage();
    await fixture.goto(FIXTURE_URL);
    await fixture.locator('.branch-row-btn').first().waitFor();

    const script = {
      name: 'branching: forEach + if',
      tag: 'action',
      steps: [
        {
          action: 'evaluate',
          expression: 'window.__resetBranchingDemo({ banner: false })',
        },
        {
          action: 'forEach',
          as: 'id',
          items: ['A', 'C', 'E'],
          do: [
            {
              action: 'click',
              xpath:
                "//button[contains(concat(' ', normalize-space(@class), ' '), ' branch-row-btn ') and @data-id='{{id}}']",
            },
            {
              action: 'if',
              xpathExists:
                "//div[@id='branch-banner' and not(contains(@style, 'display: none'))]",
              wait: false,
              then: [
                { action: 'click', xpath: "//button[@id='branch-retry-btn']" },
              ],
            },
          ],
        },
      ],
    };

    await pasteAndRun(sidePanel, fixture, script);
    await waitForLog(sidePanel, 'Finished', 20_000);

    // Only rows A, C, E should be done; B and D should remain pending.
    for (const id of ['A', 'C', 'E']) {
      await expect(
        fixture.locator(`.branch-row-result[data-id="${id}"]`),
      ).toContainText('done');
    }
    for (const id of ['B', 'D']) {
      await expect(
        fixture.locator(`.branch-row-result[data-id="${id}"]`),
      ).toContainText('pending');
    }
  });
});
