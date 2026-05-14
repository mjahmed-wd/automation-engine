/**
 * End-to-end smoke: runs an inlined version of the mega-fixture smoke
 * automation against test-fixtures/all-content.html, then asserts that
 * critical result paragraphs on the fixture reflect the expected outcomes.
 *
 * The JSON is inlined (not imported from automations/) because
 * .gitignore excludes automations/*.json — fresh clones don't have those
 * files. Keeping the smoke spec self-contained means anyone running the
 * suite gets the same baseline regardless of personal automation library.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../fixtures/extension';
import { forceFocus, pasteAndRun, waitForLog } from '../helpers/sidepanel';

// ESM: __dirname doesn't exist, derive from import.meta.url.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(__dirname, '../../test-fixtures/all-content.html');
const FIXTURE_URL = `file://${FIXTURE_PATH}`;

/** Inlined smoke automation. Mirrors automations/phase4-fixture-smoke.json
 *  but with the goto URL computed from the test runner's checkout path so
 *  this works on any developer's machine (and CI). */
const smoke = {
  name: 'E2E smoke — walk every happy-path action',
  tag: 'action',
  steps: [
    { action: 'goto', url: FIXTURE_URL, waitForXPath: "//div[@id='delayed-target']", waitForTimeoutMs: 5000 },
    { action: 'evaluate', expression: "document.getElementById('evaluate-target').dataset.count", saveAs: 'count' },
    { action: 'describe', xpath: "//button[contains(concat(' ', normalize-space(@class), ' '), ' multi-target ')]", saveAs: 'describedMulti' },

    { action: 'fill', xpath: "//input[@id='plain-input']", value: 'hello world' },
    { action: 'fill', xpath: "//div[@id='ce-plain']", value: 'rich text here' },
    { action: 'fill', xpath: "//div[@id='ce-lexical']", value: 'lexical input' },

    { action: 'click', xpath: "//div[@id='pointer-btn']" },

    { action: 'selectOption', xpath: "//select[@id='single-select']", label: 'Green' },
    { action: 'selectOption', xpath: "//select[@id='multi-select']", value: ['apple', 'cherry'] },

    { action: 'hover', xpath: "//div[@id='hover-host']" },
    { action: 'click', xpath: "//button[@id='reveal-btn']", timeoutMs: 5000 },

    { action: 'click', xpath: "//button[@id='confirm-btn']" },

    { action: 'dialog', accept: true, promptText: 'Jubair' },
    { action: 'click', xpath: "//button[@id='prompt-btn']" },

    { action: 'click', xpath: "//button[@id='alert-btn']" },

    { action: 'fill', xpath: "//input[@id='enter-input']", value: 'form submit' },
    { action: 'press', xpath: "//input[@id='enter-input']", key: 'Enter' },

    { action: 'click', xpath: "//button[@id='open-shadow-btn']" },
    { action: 'click', xpath: "//button[@id='closed-shadow-btn']", pierceClosed: true },

    { action: 'fill', xpath: "//input[@id='deep-input']", value: 'deep value' },
  ],
};

test('mega-fixture smoke walks every happy-path action and updates the fixture', async ({
  context,
  sidePanel,
}) => {
  test.setTimeout(90_000);

  // Open the fixture in its own tab — the automation will drive this page.
  const fixture = await context.newPage();
  await fixture.goto(FIXTURE_URL);
  await fixture.locator('#evaluate-target').waitFor();
  // Force document.hasFocus() to return true on the fixture — execCommand
  // based contenteditable fills won't fire their internal beforeinput without
  // window-level focus, which the OS doesn't always grant in E2E.
  await forceFocus(context, fixture);

  // Run the smoke. pasteAndRun() keeps the fixture tab in front so
  // chrome.tabs.query({active:true}) resolves to it, not to the side panel.
  await pasteAndRun(sidePanel, fixture, smoke);

  // Engine logs "Finished" once the script completes.
  await waitForLog(sidePanel, 'Finished', 60_000);

  // Spot-check critical fixture state changes. These six assertions cover
  // the highest-signal subsystems: fill (input + contenteditable), trusted
  // click (pointer-sequence + dialog auto-accept), trusted hover (CSS
  // :hover-revealed child), trusted press (form submit), CDP closed-shadow
  // path, and iframe traversal.
  await expect(fixture.locator('#result-plain-input')).toContainText('filled: hello world');
  // Plain contenteditable — input listener fires reliably and echoes the text.
  await expect(fixture.locator('#result-ce-plain')).toContainText('rich text here');
  // Lexical-style contenteditable: assert on the element's own textContent
  // rather than the listener-dependent result paragraph. The Lexical-style
  // listener depends on a beforeinput event that execCommand only fires when
  // the document has focus — and focus-emulation through CDP doesn't always
  // survive the chrome.debugger session attached by the engine. So we test
  // the strongest invariant we can in E2E: the value is in the element.
  // The listener's `[lexical-applied]` behavior is covered by unit tests.
  await expect(fixture.locator('#ce-lexical')).toContainText('lexical input');
  await expect(fixture.locator('#result-pointer')).toContainText('opened (pointerdown fired)');
  await expect(fixture.locator('#result-single')).toContainText('chose: green');
  await expect(fixture.locator('#result-hover')).toContainText('clicked after hover');
  await expect(fixture.locator('#result-confirm')).toContainText('confirmed: yes');
  await expect(fixture.locator('#result-prompt')).toContainText('name: Jubair');
  await expect(fixture.locator('#result-alert')).toContainText('alert dismissed');
  await expect(fixture.locator('#result-enter')).toContainText('submitted: form submit');
  await expect(fixture.locator('#result-open-shadow')).toContainText('clicked inside open shadow');
  await expect(fixture.locator('#result-closed-shadow')).toContainText('clicked inside closed shadow');

  // The deep-input's result paragraph lives inside the doubly-nested iframe.
  // Playwright's frame traversal: outer iframe → inner iframe → input.
  const outerFrame = fixture.frameLocator('#iframe-host iframe');
  const innerFrame = outerFrame.frameLocator('iframe');
  await expect(innerFrame.locator('#result-iframe')).toContainText('deep filled: deep value');
});
