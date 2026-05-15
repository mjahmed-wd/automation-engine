# debug-and-automation-wxt

A JSON-driven web automation runner that ships as a Chrome MV3 extension. Think of it as a tiny Playwright that lives inside your own browser: paste a JSON script into the side panel, hit Run, and the engine drives the active tab via `chrome.debugger` + the Chrome DevTools Protocol (CDP).

Built on [WXT](https://wxt.dev/) + React 19 + TypeScript. XPath-only locators with fast-path + CDP fallback. First-class support for closed Shadow DOM, same-origin nested iframes, native dialogs, and custom-event-gated UI libraries (react-select, MUI Select, Headless UI, Radix).

```jsonc
{
  "name": "Pick Green from the first dropdown",
  "tag": "action",
  "steps": [
    { "action": "goto",  "url": "https://react-select.com/home" },
    { "action": "click", "xpath": "(//div[contains(@class, 'select__control')])[1]" },
    { "action": "click", "xpath": "//div[@class='select__option' and normalize-space(.)='Green']" }
  ]
}
```

---

## Table of contents

1. [Quick start](#quick-start)
2. [Script structure](#script-structure)
3. [Action reference](#action-reference)
4. [Locator strategy](#locator-strategy)
5. [Error handling](#error-handling)
6. [Architecture (for contributors)](#architecture-for-contributors)
7. [Testing](#testing)
8. [Known limitations & non-goals](#known-limitations--non-goals)
9. [Phases history](#phases-history)

---

## Quick start

```bash
npm install
npm run build              # builds the extension into .output/chrome-mv3
```

Then in `chrome://extensions`:

1. Enable **Developer mode** (top-right toggle).
2. Click **Load unpacked** → select `.output/chrome-mv3`.
3. (Optional) Toggle **Allow access to file URLs** if you want to use `file://` fixtures.
4. Click the extension icon to open the side panel.
5. Pick a script from the **Insert example…** dropdown, or paste your own, then click **Run**.

### Your first script

Open any site (e.g., `example.com`), then paste this into the side panel:

```jsonc
{
  "name": "Read the page title",
  "tag": "get",
  "steps": [
    { "action": "get", "xpath": "//h1", "property": "textContent", "saveAs": "title" }
  ]
}
```

The log shows `Got "Example Domain" → title`, and the saved output renders below the editor.

For a comprehensive walkthrough of every action with copy-paste JSON and expected outcomes, open `test-fixtures/all-content.html` in the active tab — it's a self-documenting cookbook with **27 scenarios** covering every action and every locator path.

---

## Script structure

Three accepted JSON shapes (auto-detected by the parser):

```jsonc
// 1. Full script — most common
{
  "name": "...",
  "description": "...",         // optional
  "tag": "action" | "get",      // chooses which sidepanel tab the example lives in
  "variables": { "x": "y" },    // optional, available as {{x}} in steps
  "steps": [ {...}, {...} ]
}

// 2. Bare array of steps
[ { "action": "...", ... }, { "action": "...", ... } ]

// 3. Single step
{ "action": "fill", "xpath": "...", "value": "..." }
```

Powered by [JSON5](https://json5.org/) — `// comments`, trailing commas, and single-quoted strings all work.

### Variable substitution

Two kinds, applied per-field:

- **Text substitution (`substituteRaw`)** — for free-text fields like `value` and `url`. Just literal `{{var}}` replacement.
- **XPath substitution (`substituteXPath`)** — for the `xpath` field. Wraps the value as an XPath string literal, including `concat()` escaping when the value contains both `'` and `"`. Surrounding `'…'` or `"…"` quotes around `{{var}}` get stripped, so both `[@name='{{n}}']` and `[@name={{n}}]` produce valid output.

Outputs from earlier `get` / `evaluate` / `describe` steps take precedence over `variables` when keys collide:

```jsonc
{
  "variables": { "name": "fallback" },
  "steps": [
    { "action": "get", "xpath": "//h1", "property": "textContent", "saveAs": "name" },
    { "action": "fill", "xpath": "//input[@id='greeting']", "value": "Hello {{name}}" }
  ]
}
```

---

## Action reference

Fourteen actions, grouped by purpose. Each has a one-paragraph use case and a minimal example. For variants and edge cases, see the corresponding section in `test-fixtures/all-content.html`.

### Navigation

#### `goto`

Navigate the active tab. Optionally wait for an XPath to appear before resolving — useful for SPAs where `tabs.onUpdated 'complete'` fires before the page actually renders.

```jsonc
{ "action": "goto",
  "url": "https://example.com",
  "waitForXPath": "//h1",        // optional
  "waitForTimeoutMs": 10000 }    // optional, defaults to 20s
```

#### `wait`

Plain timed pause. Use sparingly — prefer `waitFor` for element-conditional waits.

```jsonc
{ "action": "wait", "ms": 250 }
```

#### `waitFor`

Wait for an XPath to match an element in the DOM. Doesn't require visibility (use `find` mode). Returns successfully as soon as the element exists.

```jsonc
{ "action": "waitFor", "xpath": "//div[@id='loaded']", "timeoutMs": 10000 }
```

### Interaction

#### `click`

Click an element. Uses a real CDP `Input.dispatchMouseEvent` for trusted clicks, which satisfies frameworks gating on `event.isTrusted` (react-select, MUI Select, Headless UI, Radix). Hit-tests against `elementsFromPoint` to refuse clicks on overlay-covered targets.

```jsonc
{ "action": "click", "xpath": "//button[normalize-space(.)='Save']" }
```

#### `fill`

Type into an `<input>`, `<textarea>`, or `[contenteditable]`. Handles native inputs via the React-aware setter bypass, plain contenteditables via `execCommand('insertText')`, and Lexical/ProseMirror-style editors via the `beforeinput` fallback. Refuses disabled / readonly inputs with a fast fatal.

```jsonc
{ "action": "fill", "xpath": "//input[@name='email']", "value": "x@y.z" }
```

#### `hover`

Move the cursor over an element to trigger CSS `:hover` (via trusted `Input.dispatchMouseEvent({type:'mouseMoved'})`) or JS hover handlers. Required for "hover reveals button → click button" flows.

```jsonc
{ "action": "hover", "xpath": "//div[@class='row'][1]" }
```

#### `press`

Dispatch a keyboard event. With an `xpath`, focuses the element first; without one, the keystroke targets whatever has focus. Useful for forms where Enter submits without a clickable button.

```jsonc
{ "action": "press", "xpath": "//input[@id='search']", "key": "Enter" }
```

### State

#### `get`

Read an element's value, attribute, property, or text. Optional regex extracts a capture group from the result.

```jsonc
{ "action": "get",
  "xpath": "//span[@id='total']",
  "property": "textContent",       // or "value", or any property
  "regex": "\\$([0-9.]+)",         // optional
  "saveAs": "totalAmount" }
```

Default property: `value` for `<input>` / `<textarea>` / `<select>`, `innerText` for everything else.

#### `evaluate`

Arbitrary JS escape hatch — runs in the main frame via `Runtime.evaluate` with `awaitPromise: true`. Use when no other action fits (read SPA state, compute derived values, trigger native browser actions).

```jsonc
{ "action": "evaluate",
  "expression": "document.querySelectorAll('.row').length",
  "saveAs": "rowCount" }
```

Multiple statements need an IIFE: `(() => { let n = 0; ... return n; })()`.

#### `describe`

Side-effect-free diagnostic. Returns `{ matchCount, matches: [...] }` for an XPath — match count plus metadata (frame, tag, id, name, classes, text snippet) for the first 5. Use it to debug an XPath without running a real action.

```jsonc
{ "action": "describe", "xpath": "//button", "saveAs": "info" }
```

### Specialized

#### `upload`

Attach files to an `<input type="file">` via CDP `DOM.setFileInputFiles` — the only reliable path since `input.files` is read-only and synthetic clicks don't open the OS picker. Requires absolute local paths.

```jsonc
{ "action": "upload",
  "xpath": "//input[@type='file']",
  "files": "/Users/me/sample.csv" }
```

#### `selectOption`

Pick option(s) in a native `<select>` — sets `select.value` (single) or toggles `option.selected` (multi) and dispatches `change`. Multi-select uses "set to exactly these" semantics.

```jsonc
{ "action": "selectOption", "xpath": "//select[@id='country']", "label": "Bangladesh" }
{ "action": "selectOption", "xpath": "//select[@multiple]", "value": ["red", "blue"] }
```

#### `dialog`

Pre-arm the response for the next native dialog (`alert` / `confirm` / `prompt` / `beforeunload`). Default is auto-accept, so scripts never hang on a stray `confirm("Are you sure?")`. Use this step to override for one specific dialog (e.g., to test cancel paths or supply a `prompt` response).

```jsonc
{ "action": "dialog", "accept": false },
{ "action": "click", "xpath": "//button[normalize-space(.)='Delete']" }
```

The arming is one-shot — subsequent dialogs revert to auto-accept.

---

## Locator strategy

XPath only. One language for every DOM construct: light DOM, open Shadow roots, closed Shadow roots, same-origin iframes, text relations.

### Three resolution paths

Every locator-using action follows the same routing logic:

1. **Fast path** — `Runtime.evaluate` runs an IIFE that walks light DOM + open Shadow roots + same-origin iframes via `document.evaluate` and recursion. ~10ms typical.
2. **CDP DOM walk** — `DOM.getDocument({pierce: true})` returns the full pierced tree (including closed shadow). We collect every `Document` / `ShadowRoot` / `contentDocument` nodeId, then `Runtime.callFunctionOn` each to evaluate XPath scoped to that root. Slower but covers closed shadow.
3. **OOPIF child sessions** — for cross-origin iframes, `Target.setAutoAttach` with `flatten: false` gives us per-frame CDP sessions; we route XPath queries to each child session via `Target.sendMessageToTarget` envelopes.

### Closed-shadow auto-detection

On every `goto`, `click`, and `waitFor`, the engine runs a one-shot `DOM.getDocument({pierce: true})` walk to check for any `shadowRootType: 'closed'`. If found, the `hasClosedShadow` flag flips and subsequent actions skip the fast path entirely (it can't see closed shadow). On a fresh `goto`, the flag resets.

### `pierceClosed` override

Three-state on most action steps:

- `pierceClosed: true` → always use CDP DOM walk, even when the page has no detected closed shadow.
- `pierceClosed: false` → always use the fast path, even when closed shadow was detected (escape hatch for false positives).
- omitted → use the auto-detected `hasClosedShadow` flag.

### Iframe handling

- **Same-origin iframes** — `deepEval` recurses into `iframe.contentDocument` automatically. No flag needed.
- **Cross-origin iframes (OOPIFs)** — auto-attached via `Target.setAutoAttach`. XPath queries fan out to all attached child sessions. Trusted clicks fall back to synthetic event dispatch when the resolved coordinates don't map cleanly to the main viewport.
- **Doubly-nested cross-origin iframes (OOPIF inside OOPIF)** — *not* auto-attached. See [Known limitations](#known-limitations--non-goals).

### Quote handling in XPath substitution

`substituteXPath` builds XPath string literals safely:

- No quote in value → `'hello'`
- Single quote in value → `"O'Brien"`
- Double quote in value → `'say "hi"'`
- Both quote types → `concat('a', "'", 'b"c')`

This means `{{firstName}}` containing `O'Brien` substitutes correctly into `[@name='{{firstName}}']` without breaking the XPath.

---

## Error handling

### Structured "Failed to … " messages

When a locator misses, the error includes the action verb, the original `{{var}}`-templated XPath, the resolved value, and (when they differ) the resolved XPath:

```
Failed to fill //input[@name='{{field}}'] → "Md. jubair": Locator not found within 2s (max inputs seen in any frame: 12)
  resolved xpath: //input[@name='firstName']
```

The wrapper is added at the action-handler boundary by `withLocatorContext` (see `src/automation/errors.ts`). FatalActionError messages pass through unchanged.

### `FatalActionError`

A typed error thrown when the engine *finds* the target but refuses to act on it. Stops the search loop immediately — no point polling for 20s when the verdict won't change. Triggered by:

| Action | Reason |
|---|---|
| `fill` | input is `disabled` or `readOnly` |
| `click` | target is overlay-covered (hit-test detected another element on top) |
| `selectOption` | XPath doesn't match a `<select>`, target is disabled, or no option matched the label/value |

Self-describing messages (`Cannot fill input[name="email"]: it is disabled`), so the panel log tells you exactly what the engine refused.

### Per-step `timeoutMs`

Every locator-using action accepts `timeoutMs` to override the default 20s search budget. The budget is shared across the fast path and the CDP fallback — `timeoutMs: 2000` means the entire action gives up at ~2s, not 4s.

```jsonc
{ "action": "click", "xpath": "//button[@id='maybe-there']", "timeoutMs": 2000 }
```

### Parse-time validation

Typo'd action names (`"clik"`) and missing required fields (`fill` without `value`) fail *before* the debugger attaches and the script starts navigating. The validator runs inside `parseAutomation` immediately after JSON5 parsing — error messages include the step index and the offending field:

```
Step 2: unknown action "clik". Known: goto, fill, get, click, wait, waitFor, press, evaluate, upload, selectOption, hover, dialog, describe
```

### Reading the panel log

Three log levels, each color-coded in the side panel:

- `info` (gray) — engine state changes (`Attaching debugger…`, `Navigating to…`)
- `success` (green) — action completed
- `error` (red) — fatal or terminal failure

The log auto-scrolls. Click **Clear** to reset.

---

## Architecture (for contributors)

### File-by-file map

```
src/automation/
├── schema.ts              Step types + AutomationStep union, substituteRaw / substituteXPath / xpathStringLiteral
├── parse.ts               JSON5 parse + validateScript (the per-action validator map)
├── interpreter.ts         runScript — walks AutomationStep[] and dispatches via the action registry
├── locator.ts             buildActionExpression / buildResolveExpression / buildDescribeExpression / buildCallFunctionExpression
├── page.ts                Page class — chrome.debugger client, runUntilFound, cdpFindAndAct, cdpResolveXPath, dialog handling
├── errors.ts              withLocatorContext wrapper for structured action-handler errors
├── loader.ts              import.meta.glob loader for automations/*.json
├── index.ts               barrel export
└── actions/
    ├── index.ts           Registry: { goto: gotoAction, fill: fillAction, ... }
    ├── goto.ts
    ├── fill.ts
    ├── get.ts
    ├── click.ts
    ├── wait.ts
    ├── waitFor.ts
    ├── press.ts
    ├── evaluate.ts
    ├── upload.ts
    ├── selectOption.ts
    ├── hover.ts
    ├── dialog.ts
    └── describe.ts

entrypoints/
├── background/            Service worker — message dispatcher + automation runner
│   ├── index.ts           defineBackground + sidePanel setup + onMessage dispatcher + broadcastLog
│   ├── runJsonAutomation.ts   The script-running function; takes LogFn as a parameter
│   └── tabAccess.ts       isAttachable + waitForTabComplete helpers
└── sidepanel/             React UI
    ├── App.tsx
    ├── main.tsx
    ├── style.css
    └── index.html

automations/               Local script library — gitignored except .gitkeep
                           import.meta.glob picks up every *.json at build time

test-fixtures/
└── all-content.html       Self-documenting fixture: 27 scenarios with copy-paste JSON,
                           expected outcomes, and a Try-it block per case. Doubles as
                           the smoke-automation target.

e2e/                       Playwright suite
├── fixtures/extension.ts  Persistent-context fixture loading the built extension
├── helpers/sidepanel.ts   pasteAndRun, waitForLog, forceFocus
└── specs/
    ├── smoke.spec.ts
    └── fatal-paths.spec.ts

src/automation/*.test.ts   Vitest unit tests (schema, parse, locator)
```

### How to add a new action

Five steps, each touching one file:

1. **`schema.ts`** — define `<Name>Step` interface and add it to the `AutomationStep` union.
2. **`page.ts`** — add a `page.<name>(locator, opts)` method (or extend an existing one). For locator-using actions, route through `runAction` to inherit shadow-detection + fast/CDP split. For one-shot CDP-only actions (like `press`, `upload`, `selectOption`), call `cdpResolveXPath` + `callFunctionOn` directly.
3. **(optional) `locator.ts`** — if the action needs a new IIFE shape, add a `Mode` entry and an action-block branch in `buildActionExpression` (and mirror in `buildCallFunctionExpression` for CDP path consistency).
4. **`actions/<name>.ts`** — handler that resolves the locator, applies substitution, calls the page method (wrapped in `withLocatorContext` for structured errors).
5. **`actions/index.ts`** — add `<name>: <name>Action` to the registry. **`parse.ts`** — add a validator for the new action's required fields to `stepValidators`.

The Vitest registry-consistency test will fail if you forget step 5's validator entry.

### WXT version pinning

WXT is pinned to `0.19.16` in `package.json`. Newer versions (0.19.29+) have a rolldown / `@wxt-dev/module-react` bug that breaks the build on this codebase. Verify the bug is gone before bumping — try a clean install + build with the new version on a branch first.

---

## Testing

Two test tiers + one manual smoke target.

### Unit tests (Vitest + jsdom)

Pure-function tests for `schema.ts` (substitution, XPath escaping), `parse.ts` (JSON5 + validators + registry consistency), `locator.ts` (buildDescribeExpression IIFE, evaluated in jsdom).

```bash
npm test           # one-shot
npm run test:watch # watch mode
```

54 tests, runs in under 2 seconds. No browser, no extension load.

### E2E tests (Playwright)

Launches a persistent Chromium context with the built extension loaded, drives automations through the side panel, asserts on fixture state + panel logs.

```bash
npx playwright install chromium   # one-time
npm run test:e2e                  # builds extension first, then runs suite
npm run test:e2e:ui               # interactive UI
```

4 tests — one full mega-fixture smoke + 3 fatal-path scenarios. Runs in ~2-3 minutes. Headed mode is required (Chrome refuses extensions in headless), so CI on Linux needs `xvfb-run`.

Three E2E-specific shims live in the test setup; touch them only if you understand the comments first:

- **ESM `__dirname` derivation** — `package.json` has `"type": "module"`, so each E2E file derives `__dirname` from `import.meta.url`.
- **CDP `Emulation.setFocusEmulationEnabled`** — fires when the test creates the fixture page so `document.execCommand('insertText')` can fire its internal `beforeinput` event.
- **No-op dialog listener** — registered on every page in the persistent context to opt out of Playwright's auto-dismiss, letting the extension's CDP `Page.javascriptDialogOpening` handler win the race.

### Manual smoke (the cookbook)

`test-fixtures/all-content.html` is the canonical regression target. After any refactor of `page.ts`, `locator.ts`, or any action handler:

1. Open the fixture in the active tab.
2. Run `phase4-fixture-smoke.json` from the dropdown (lives in your `automations/` folder).
3. Watch the panel log: every action should report green, every result paragraph in the fixture should reflect the expected outcome.

The fixture also serves as a paste-and-run cookbook — each section has a 📋 Copy JSON button and an Expected outcome paragraph, covering 27 scenarios across 14 actions plus 4 real-world examples (MUI, react-select, W3Schools, Shepherd).

---

## Known limitations & non-goals

These are *not* bugs — they're explicit scope choices.

- **Doubly-nested OOPIFs are not auto-attached.** Cross-origin iframe inside another cross-origin iframe is invisible to the engine. Same-origin nesting works at any depth via `deepEval` recursion.
- **`evaluate` runs in the main frame only.** Reach into same-origin iframes from inside your expression (`document.querySelector('iframe').contentWindow.…`); cross-origin iframe evaluation isn't supported.
- **`upload` requires absolute file paths.** Relative paths get rejected at action-handler time. Chrome resolves relative paths against an unpredictable cwd.
- **No built-in credentials handling.** Secrets currently live in script `variables`, which means they're in the JSON. A `chrome.storage.local`-backed `{{secrets.password}}` mechanism is a future-phase candidate.
- **No multi-tab orchestration.** The engine drives one active tab per script run. Switching tabs mid-script isn't supported. Future-phase candidate.
- **No screenshots-on-failure.** `Page.captureScreenshot` is a one-call wrapper away — included on the future-phase shortlist.
- **No recorder.** Scripts are written by hand. A click-recorder UI would be a major UX leap and a major implementation investment.
- **One `<select>`-per-action.** `selectOption` works on one select at a time. Bulk operations require multiple steps.

---

## Phases history

Mapping commit history to milestones:

- **Phase 0 / 0.5** — XPath canonical (replaced multi-language locators with XPath-only) and auto-CDP routing for closed-shadow pages.
- **Phase 1** — Action correctness: `FatalActionError` + disabled/readonly rejection, contenteditable fill (plain + Lexical-style), tighter visibility predicate (opacity, pointer-events), overlay hit-test on click.
- **Phase 2** — New actions: `evaluate`, `upload`, `selectOption`, `hover`. (`press` predates this phase.)
- **Phase 3** — Frame & navigation hardening: `goto.waitForXPath` for SPA-aware navigation, native dialog handling (`Page.enable` + `Page.handleJavaScriptDialog`).
- **Phase 4** — DX & error reporting: structured error messages, `describe` action, parse-time JSON validation, Vitest unit suite, Playwright E2E suite, mega-fixture cookbook (`all-content.html`), background folder refactor, this README.

Skipped scope (explicitly): nested-iframe forwarding (low real-world need for CRM workflows; revisit if a concrete use case surfaces).
