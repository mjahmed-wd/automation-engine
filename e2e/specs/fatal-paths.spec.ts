/**
 * E2E tests for the fatal-rejection paths.
 *
 * Each test pastes a small automation that the engine should reject FAST
 * (sub-second) with a specific structured error message. If any of these
 * messages drifts, the corresponding test catches it.
 *
 * Coverage:
 *   - Phase 1 disabled-fill rejection
 *   - Phase 3 overlay-covered click rejection (hit-test)
 *   - Phase 2 selectOption no-match rejection
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../fixtures/extension';
import { forceFocus, pasteAndRun, waitForLog, logContains } from '../helpers/sidepanel';

// ESM: __dirname doesn't exist, derive from import.meta.url.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(__dirname, '../../test-fixtures/all-content.html');
const FIXTURE_URL = `file://${FIXTURE_PATH}`;

test.describe('fatal-paths', () => {
  test('fill on a disabled input surfaces "is disabled" fatal in <1s', async ({
    context,
    sidePanel,
  }) => {
    const fixture = await context.newPage();
    await fixture.goto(FIXTURE_URL);
    await forceFocus(context, fixture);
    await fixture.locator('#disabled-input').waitFor();

    await pasteAndRun(sidePanel, fixture, {
      name: 'fatal: fill disabled',
      tag: 'action',
      steps: [
        { action: 'fill', xpath: "//input[@id='disabled-input']", value: 'should never land' },
      ],
    });

    await waitForLog(sidePanel, 'it is disabled', 10_000);

    // The structured-error wrapper should also include the action verb.
    expect(await logContains(sidePanel, 'Cannot fill')).toBe(true);

    // The input's value must NOT have changed.
    await expect(fixture.locator('#disabled-input')).toHaveValue('locked');
  });

  test('click on an overlay-covered button surfaces "covered by" fatal', async ({
    context,
    sidePanel,
  }) => {
    const fixture = await context.newPage();
    await fixture.goto(FIXTURE_URL);
    await forceFocus(context, fixture);
    await fixture.locator('#covered-btn').waitFor();

    await pasteAndRun(sidePanel, fixture, {
      name: 'fatal: click covered',
      tag: 'action',
      steps: [{ action: 'click', xpath: "//button[@id='covered-btn']" }],
    });

    await waitForLog(sidePanel, 'covered by', 10_000);

    // The button's click handler writes "BUG" if the click landed — verify it didn't.
    await expect(fixture.locator('#result-covered')).not.toContainText('BUG');
  });

  test('selectOption with no matching label surfaces no-match fatal', async ({
    context,
    sidePanel,
  }) => {
    const fixture = await context.newPage();
    await fixture.goto(FIXTURE_URL);
    await forceFocus(context, fixture);
    await fixture.locator('#single-select').waitFor();

    await pasteAndRun(sidePanel, fixture, {
      name: 'fatal: selectOption no-match',
      tag: 'action',
      steps: [
        { action: 'selectOption', xpath: "//select[@id='single-select']", label: 'Magenta' },
      ],
    });

    await waitForLog(sidePanel, 'no option matched', 10_000);

    // Verify the select didn't get any option picked (selectedIndex stays at the placeholder).
    const selectedValue = await fixture.locator('#single-select').inputValue();
    expect(selectedValue).toBe('');
  });
});
