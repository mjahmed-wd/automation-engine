# Automation Engine

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
4. [Retry policy](#retry-policy)
5. [Script injection via `evaluate`](#script-injection-via-evaluate)
6. [Multi-tab orchestration](#multi-tab-orchestration)
7. [Network waits](#network-waits)
8. [Conditional + loops](#conditional--loops)
9. [Locator strategy](#locator-strategy)
10. [Error handling](#error-handling)
11. [Architecture (for contributors)](#architecture-for-contributors)
12. [Testing](#testing)
13. [Known limitations & non-goals](#known-limitations--non-goals)
14. [Phases history](#phases-history)

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

For a comprehensive walkthrough of every action with copy-paste JSON and expected outcomes, open `test-fixtures/all-content.html` in the active tab — it's a self-documenting cookbook with **25 fixture sections + 7 real-world examples** covering every action, every locator path, the multi-tab/window flow, script injection, the retry policy, and network waits.

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

Seventeen actions, grouped by purpose. Each has a one-paragraph use case and a minimal example. For variants and edge cases, see the corresponding section in `test-fixtures/all-content.html`. Multi-tab, script-injection, network-wait, and conditional/branching capabilities get their own sections after the reference.

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

Arbitrary JS escape hatch — runs in the page's **main JS world** via `Runtime.evaluate` with `awaitPromise: true`. Same realm as the page's own inline `<script>` tags, NOT an isolated content-script world. The page can't tell whether a DOM mutation came from its own scripts or from outside. Use it to read SPA state, compute derived values, OR mutate the page (inject buttons, change CSS, delete elements) while the automation runs.

```jsonc
{ "action": "evaluate",
  "expression": "document.querySelectorAll('.row').length",
  "saveAs": "rowCount" }
```

Multiple statements need an IIFE: `(() => { let n = 0; ... return n; })()`.

See **[Script injection via `evaluate`](#script-injection-via-evaluate)** below for the full story — inject UI, change CSS, delete noisy elements, pull values out of `window.__REDUX_STORE__`, etc.

#### `describe`

Side-effect-free diagnostic. Returns `{ matchCount, matches: [...] }` for an XPath — match count plus metadata (frame, tag, id, name, classes, text snippet) for the first 5. Use it to debug an XPath without running a real action.

```jsonc
{ "action": "describe", "xpath": "//button", "saveAs": "info" }
```

#### `waitForResponse`

Block until a Network response matches the supplied filters. Race-tolerant via a per-tab ringbuffer of recent responses — responses that landed BEFORE the wait started still resolve, so you don't need explicit `wait` spacers between the action that triggers the request and this step. Default `timeoutMs` is 30s.

```jsonc
{ "action": "waitForResponse",
  "urlMatches": "/api/save/",     // required: substring or /regex/flags
  "status": 200,                   // optional: number, [200,201,204], or {">=":200,"<":300}
  "method": "POST",                // optional: HTTP verb
  "saveBody": "savedRecord",       // optional: capture body via Network.getResponseBody
  "saveStatus": "code",            // optional: save status code
  "saveUrl": "matchedUrl" }        // optional: save matched URL (useful for regex captures)
```

See **[Network waits](#network-waits)** below for the full story including the `Network.enable` cache caveat.

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

#### `tab`

Multi-tab + multi-window orchestration. Seven ops: `open` (engine-initiated new tab in current window), `openWindow` (engine-initiated new browser window, optionally sized popup), `switchTo` (focus an existing tab by URL or index), `waitForNew` (wait for a tab opened by a page-side side effect like a `target="_blank"` link), `close` (close current and pop the origin stack), `next` / `previous` (cycle within the window).

```jsonc
{ "action": "tab", "op": "open", "url": "https://lookup.internal/sku/{{sku}}",
  "waitForXPath": "//span[@id='price']" }
{ "action": "tab", "op": "openWindow", "url": "https://en.wikipedia.org/wiki/Foo",
  "windowType": "popup", "width": 700, "height": 500,
  "waitForXPath": "//h1[@id='firstHeading']" }
{ "action": "tab", "op": "waitForNew", "urlMatches": "/customers/", "timeoutMs": 10000 }
{ "action": "tab", "op": "switchTo", "urlMatches": "/\\/invoices\\/edit/" }
{ "action": "tab", "op": "close" }
```

The engine keeps an internal origin stack: every op that changes the active tab pushes the previously-current tabId; `close` pops and reactivates whatever's on top. Nested side-tabs (open A → open B inside A → close B → still in A → close A → back to original) close in the right order. Already-attached tabs cost only a pointer flip on re-entry — no re-attach overhead for ping-pong patterns.

See **[Multi-tab orchestration](#multi-tab-orchestration)** below for the full flow including page-triggered vs script-triggered patterns and the `urlMatches` syntax.

### Control flow

#### `if`

Branch on whether an XPath matches the page. `then` runs on match, `else` (optional) runs on miss. Timing is explicit — required `timeoutMs` (poll) OR `wait: false` (instant DOM check), no defaults. The validator rejects neither-set.

```jsonc
{ "action": "if",
  "xpathExists": "//div[@class='error-banner']",
  "timeoutMs": 1000,
  "then": [ { "action": "click", "xpath": "//button[.='Retry']" } ],
  "else": [ { "action": "wait", "ms": 100 } ] }
```

`then` and `else` accept any AutomationStep, including more `if` / `forEach`. The interpreter's `runStepArray` is recursive; the validator caps nesting at 20 levels.

#### `forEach`

Iterate a list of items. `items` is either a JSON array `["a","b","c"]` or a `{{var}}` reference to a comma-separated string. `as` names the loop variable, set in `ctx.variables[as]` per iteration and removed after the loop.

```jsonc
{ "action": "forEach",
  "as": "id",
  "items": ["C-1001", "C-1002", "C-1003"],
  "do": [
    { "action": "tab", "op": "open", "url": "/customers/{{id}}/edit" },
    { "action": "fill", "xpath": "//textarea[@name='note']", "value": "Processed {{id}}" },
    { "action": "click", "xpath": "//button[.='Save']" },
    { "action": "tab", "op": "close" }
  ] }
```

See **[Conditional + loops](#conditional--loops)** below for the full story including variable scoping and the nesting-depth cap.

---

## Retry policy

Every locator-using step accepts two optional fields that let the engine handle transient flake transparently:

```jsonc
{ "action": "click", "xpath": "//button[@id='save']",
  "retries": 3,           // optional, default 0 — number of ADDITIONAL attempts
  "retryDelay": 500 }     // optional, default 500ms — wait between attempts
```

Total attempts is `retries + 1`. Worst-case wall-clock time per step is `(retries + 1) × timeoutMs + retries × retryDelay`. The validator caps `retries` at 5 — at the default 20s `timeoutMs` that's already ~2 minutes per step; anything more usually means the script needs restructuring.

### Retry decision tree

| Failure | Retries? | Why |
|---|---|---|
| Generic error (`Locator not found within Ns`) | Yes | Flake — could be a widget race, slow CDN, or animation. Retry is exactly what the user wants. |
| `FatalActionError` reason `disabled` | No | Stable state. A disabled `<input>` won't fix itself; retrying wastes the script's budget. |
| `FatalActionError` reason `read-only` | No | Same as `disabled`. |
| `FatalActionError` reason `no-match` (selectOption) | No | The option you asked for doesn't exist; retry won't make it exist. |
| `FatalActionError` reason `not-a-select` | No | You pointed at a `<div>`, not a `<select>`. Schema problem, not a flake. |
| `FatalActionError` reason `covered` | **Yes** | Overlays are transient: toast banners, loading scrims, and modal backdrops routinely self-dismiss. Retry by default. |

The reason field on `FatalActionError` is exposed by the engine, but you don't need to think about it — the interpreter's `runStepWithRetry` wraps every step and applies the decision tree automatically.

### When to use retries

Good fits:

- A widget that needs framework hydration before its handlers fire (`click` lands but no-ops the first time).
- A submit button that briefly disables during client-side validation, then re-enables.
- A modal that takes a moment to mount; without a fixed `wait`, you don't know exactly how long.
- A toast banner that briefly covers your target.

Less helpful:

- "I want the script to keep trying for 10 minutes" — use a bigger `timeoutMs`, not a higher `retries`. Retries are bounded at 5.
- Hiding a real schema or selector bug. If a step fails consistently, retries just make the failure slower.

### Log output

Side panel shows each attempt explicitly so the engine doesn't look stuck:

```
→ Step 2/5: click
Attempt 1/4 failed: Locator not found within 0.5s. Retrying in 500ms…
Attempt 2/4 failed: Locator not found within 0.5s. Retrying in 500ms…
Clicked button#save (trusted) at (412, 188) in https://example.com/
Step click succeeded on retry 2/3.
```

---

## Script injection via `evaluate`

`evaluate` runs your expression in the page's **main JS world** via CDP `Runtime.evaluate`. Same realm as the page's own inline `<script>` tags, **not** an isolated content-script world. Anything you can do in DevTools Console, you can do here.

This is the escape hatch for "modify the page while the automation runs" — patterns that pay off in CRM workflows:

- Dim rows you've already processed
- Hide noisy UI (chat widgets, toast banners, feedback prompts) before screenshots
- Inject a custom progress badge or "Mark as reviewed" button
- Pull values out of `window.__REDUX_STORE__` or other framework internals
- Override a stylesheet to make text legible against the screenshot background
- Delete sections of the DOM that confuse downstream `describe` queries

### Practical examples

Inject a floating button with a click handler:

```jsonc
{ "action": "evaluate",
  "expression": "(() => { const b = document.createElement('button'); b.textContent='Mark reviewed'; b.style.cssText='position:fixed;top:10px;right:10px;z-index:9999;padding:8px 12px'; b.onclick=() => fetch('/api/mark', {method:'POST'}); document.body.appendChild(b); return 'added'; })()" }
```

Inject a stylesheet (then reverse it by id):

```jsonc
{ "action": "evaluate",
  "expression": "(() => { const s = document.createElement('style'); s.id='dim-rows'; s.textContent='tr.completed { opacity: 0.3 !important; }'; document.head.appendChild(s); return 'dimmed'; })()" }
```

Reverse:

```jsonc
{ "action": "evaluate",
  "expression": "document.getElementById('dim-rows')?.remove()" }
```

Pull values out of the page's globals:

```jsonc
{ "action": "evaluate",
  "expression": "JSON.stringify({ store: window.__REDUX_STORE__?.getState()?.user?.id, url: location.href, title: document.title })",
  "saveAs": "snapshot" }
```

Delete noisy UI before grabbing state:

```jsonc
{ "action": "evaluate",
  "expression": "document.querySelectorAll('.toast, .feedback-banner, .chat-widget').forEach(n => n.remove())" }
```

Section 22 of `test-fixtures/all-content.html` is the live cookbook — four pasteable scripts that inject a button, dark-mode the page, delete sections, and rewrite text.

### Mechanics

- **Main JS world.** The expression sees `window`, `document`, every global the page has set up (Redux store, jQuery, framework internals — whatever the page exposes). It does **not** see anything from the extension's side — no `chrome.*` APIs, no side-panel state, no React state.
- **Script mode, not module mode.** A bare `var x = 5; x` returns `undefined`. Wrap multi-statement code in an IIFE — `(() => { var x = 5; return x; })()` — and the return value comes back.
- **Async works.** `awaitPromise: true` is set internally, so `(async () => await fetch('/x').then(r => r.json()))()` just works.
- **Return values serialize.** Primitives come through as themselves; plain objects/arrays get `JSON.stringify`-ed into `ctx.outputs[saveAs]`; DOM nodes return as `{}` (V8 can't serialize an `HTMLElement`).
- **Errors surface cleanly.** Exceptions propagate with V8's description — `Failed: evaluate: ReferenceError: foo is not defined`.
- **Same-origin only.** Can't reach into cross-origin iframes via `iframe.contentWindow.document`. Same-origin iframes work via `document.querySelector('iframe').contentWindow.…` inside the expression.
- **Main frame only.** This iteration of `evaluate` runs in the top frame. Other actions (click, fill, get) automatically walk into same-origin iframes.
- **Persistence is page-lifetime.** Mutations live until navigation/reload. The next `goto` wipes the slate. For permanent modifications, write a real content script in the manifest — but for "modify the page while the automation runs," `evaluate` is the right tool.
- **Same security as the page.** The expression runs with the page's origin and privileges. Can't escalate beyond what the page itself could do — but also can't be sandboxed *more* than the page is.

### When to reach for it vs. dedicated actions

Use the dedicated action (`click`, `fill`, `get`, etc.) when it fits — those go through `withLocatorContext` for structured "Failed to ..." errors, share the `timeoutMs` deadline, and integrate with closed-shadow auto-detect. `evaluate` is for things no dedicated action covers: page mutation, reading non-DOM globals, conditional logic, asynchronous workflows in a single step.

---

## Multi-tab orchestration

The `tab` action lets a script open, switch between, and close tabs. The engine keeps every visited tab's debugger session live for the duration of the run; switching back is a pointer flip, not a re-attach. ~1s of attach overhead is paid only on first visit.

### Page-triggered: drive a tab opened by a page click

A row in a list view has a "View customer" button that opens detail in a new tab:

```jsonc
[
  { "action": "click", "xpath": "//a[contains(., 'View customer')]" },
  { "action": "tab",   "op": "waitForNew", "urlMatches": "/customers/", "timeoutMs": 10000 },
  { "action": "get",   "xpath": "//span[@id='loyalty-tier']", "saveAs": "tier" },
  { "action": "tab",   "op": "close" },
  { "action": "fill",  "xpath": "//textarea[@name='notes']", "value": "Tier: {{tier}}" }
]
```

After `tab close`, the engine reactivates the tab it switched from. No explicit "switchTo original" step needed.

### Script-triggered: open a side tab for a lookup

The script proactively opens a side tab to a reference page, reads a value, closes, returns. Real public-site demo using DuckDuckGo (the form page) and Wikipedia (the lookup target) — both stable, no auth required, evergreen:

```jsonc
{
  "name": "Cross-site lookup via new tab",
  "variables": {
    "wikipediaUrl": "https://en.wikipedia.org/wiki/Chrome_DevTools_Protocol"
  },
  "steps": [
    { "action": "goto", "url": "https://duckduckgo.com",
      "waitForXPath": "//input[@name='q']" },

    { "action": "tab", "op": "open",
      "url": "{{wikipediaUrl}}",
      "waitForXPath": "//h1[@id='firstHeading']" },

    { "action": "get",
      "xpath": "//h1[@id='firstHeading']",
      "property": "textContent",
      "saveAs": "title" },

    { "action": "wait", "ms": 3000 },
    { "action": "tab", "op": "close" },

    { "action": "fill",
      "xpath": "//input[@name='q']",
      "value": "{{title}}" }
  ]
}
```

What happens: DuckDuckGo loads, then a new tab opens at the Wikipedia article and Chrome focuses it. After `waitForXPath` blocks on the article heading, the script reads `"Chrome DevTools Protocol"` into `title`, pauses 3s, closes the Wikipedia tab, and Chrome focuses back on DuckDuckGo. The search box gets filled with the article title.

`tab open` goes through `chrome.tabs.create` via the extension's `tabs` permission, so it's not subject to the page's popup blocker — works on `file://` origins too. Prefer this over page-triggered when the script knows the URL it wants.

### Script-triggered: open a sized popup window

Same flow as above, but the lookup lands in a separate Chrome window — useful for OAuth-style consent popups, second-monitor workflows, or when you want the lookup visually separated. Identical use case to the "new tab" example above; only the open step changes:

```jsonc
{
  "name": "Cross-site lookup via popup window",
  "variables": {
    "wikipediaUrl": "https://en.wikipedia.org/wiki/Chrome_DevTools_Protocol"
  },
  "steps": [
    { "action": "goto", "url": "https://duckduckgo.com",
      "waitForXPath": "//input[@name='q']" },

    { "action": "tab", "op": "openWindow",
      "url": "{{wikipediaUrl}}",
      "windowType": "popup",
      "width": 700,
      "height": 500,
      "waitForXPath": "//h1[@id='firstHeading']" },

    { "action": "get",
      "xpath": "//h1[@id='firstHeading']",
      "property": "textContent",
      "saveAs": "title" },

    { "action": "wait", "ms": 3000 },
    { "action": "tab", "op": "close" },

    { "action": "fill",
      "xpath": "//input[@name='q']",
      "value": "{{title}}" }
  ]
}
```

What's different vs. the new-tab version: a 700×500 popup window pops up at the Wikipedia URL (minimal chrome — no tabs, no address bar), the script drives it the same way, and when `tab close` runs the popup window auto-closes (because its only tab is closing). Focus returns to the original Chrome window where DuckDuckGo is loaded.

`windowType: 'popup'` produces a minimal window. Omit it or pass `'normal'` for a regular Chrome window with full chrome. `width` / `height` / `left` / `top` are optional — Chrome picks defaults when omitted. Closing the only tab in the popup window auto-closes the window via Chrome's default behavior; no separate close-window op is needed.

`openWindow` is an extension-side API call (`chrome.windows.create`), not subject to the page's popup blocker. Works for any URL the extension can navigate to.

### `urlMatches` patterns

Plain string is a **substring** match. `/regex/flags` is a **RegExp**. Both support `{{var}}` substitution.

```jsonc
{ "action": "tab", "op": "switchTo", "urlMatches": "/invoices/edit/" }
{ "action": "tab", "op": "switchTo", "urlMatches": "/\\/customers\\/(\\d+)/" }
```

### Notes

- `tab close` refuses to close the only attached tab when the origin stack is empty — would orphan the run.
- `tab next` / `tab previous` cycle within the window. They push the origin stack so a subsequent `close` brings focus back, but they're typically used for moving forward, not for round-trips.
- `windowId` is a soft filter for `waitForNew`: tabs from other windows are still candidates because `window.open(_, '_blank')` on `file://` commonly lands the popup in a fresh Chrome window.

---

## Network waits

The `waitForResponse` step blocks until a `Network.responseReceived` event matches the supplied URL / status / method filters. Useful when:

- An XHR drives the UI update you actually care about (Save → 200 → next record), and the visible DOM change is too late or too unreliable to gate on.
- You need to assert a request succeeded before continuing — fail the script if the save POST returned 500 instead of silently moving on.
- The response body contains data the script needs (a server-assigned ID, a token, a JSON payload).

### Filters

URL pattern matches the same way as `tab waitForNew`: plain string is substring, `/regex/flags` is RegExp. Both support `{{var}}` substitution.

Status accepts three forms, in increasing flexibility:

```jsonc
"status": 200                       // exact
"status": [200, 201, 204]           // any-of
"status": { ">=": 200, "<": 300 }   // range (AND of comparisons)
```

Method is an HTTP verb string, compared case-insensitively. Omit any filter to accept all.

### Body reading

`saveBody` is opt-in. When set, the engine calls `Network.getResponseBody` after the event arrives and stores the body (decoded if base64) into `ctx.outputs[saveBody]`. Skipping this is one fewer CDP roundtrip; only request it when you actually need the body.

```jsonc
{ "action": "waitForResponse", "urlMatches": "/api/customer/", "saveBody": "customer" },
{ "action": "fill", "xpath": "//input[@name='notes']",
  "value": "Imported: {{customer}}" }
```

### Race tolerance

`waitForResponse` reads from a per-tab `EventWaiter` ringbuffer (default 30s window) that's populated by an always-on listener at `Page.init` time. Result: even if the response landed BEFORE the script reached the `waitForResponse` step (because the prior step's CDP roundtrip was slow), the wait resolves immediately by scanning the buffer. No need for `wait` spacers; this was a real source of flakiness in earlier batches.

### `Network.enable` caveat

The CDP Network domain enables when `Page.init` runs. **Side effect:** Chrome's disk cache is disabled for the attached debugger session (CDP-defined behavior). Cold-load asset fetches are slower while the engine is attached. Fine for automation; worth knowing if a page behaves differently with vs without the engine.

### Real-world example — httpbin.org form POST

The canonical end-to-end demo. `httpbin.org/forms/post` is a stable public form that POSTs to `/post` and echoes the submitted data back in the response. Mirrors the CRM "save → server returns confirmation → use it downstream" pattern: fill the form, click Submit, block on the POST response with a status range filter, capture the JSON body.

```jsonc
{
  "name": "httpbin: submit form and capture echoed POST response",
  "variables": {
    "customerName": "Md. Jubair",
    "customerEmail": "test@example.com"
  },
  "steps": [
    { "action": "goto", "url": "https://httpbin.org/forms/post",
      "waitForXPath": "//input[@name='custname']" },
    { "action": "fill", "xpath": "//input[@name='custname']",  "value": "{{customerName}}" },
    { "action": "fill", "xpath": "//input[@name='custtel']",   "value": "555-1234" },
    { "action": "fill", "xpath": "//input[@name='custemail']", "value": "{{customerEmail}}" },
    { "action": "click", "xpath": "//button[normalize-space(.)='Submit order']" },
    { "action": "waitForResponse",
      "urlMatches": "httpbin.org/post",
      "status": { ">=": 200, "<": 300 },
      "timeoutMs": 10000,
      "saveStatus": "httpStatus",
      "saveBody":   "echoBody" }
  ]
}
```

What happens: the form loads, three fields fill in turn, Submit is clicked, and the engine logs `Got response 200 POST https://httpbin.org/post (~1200 bytes saved → echoBody)`. Outputs: `httpStatus = "200"` and `echoBody` is the JSON httpbin returned — the `form` key inside contains your submitted fields.

To chain the captured data into a downstream step, follow with an `evaluate` that parses the body:

```jsonc
{ "action": "evaluate",
  "expression": "JSON.parse({{echoBody}}).form.custname",
  "saveAs": "verifiedName" },
{ "action": "fill",
  "xpath": "//some-downstream-field",
  "value": "Confirmed: {{verifiedName}}" }
```

See fixture Section R7 for the cookbook entry with the Copy-JSON button.

---

## Conditional + loops

`if` and `forEach` add control flow to what was a purely linear language. The interpreter's `runStepArray` recurses into `if.then` / `if.else` / `forEach.do`, so any AutomationStep — including more conditionals and loops — can nest inside. The validator caps nesting at 20 levels to catch buggy generators.

### `if` — branching

`if` checks whether an XPath matches the page right now. Two timing modes, exactly one required:

- **`timeoutMs: N`** — poll the page for up to N milliseconds. Use when the matching element renders asynchronously (e.g., an error banner that appears 200ms after a save click).
- **`wait: false`** — instant DOM check, no polling. Use when you know the page state is settled (typically right after another step that already waited).

```jsonc
{ "action": "if",
  "xpathExists": "//div[@class='error-banner']",
  "timeoutMs": 1000,
  "then": [ { "action": "click", "xpath": "//button[.='Retry']" } ],
  "else": [ /* no-op or recovery */ ] }
```

`else` is optional — omit it for "fire-on-match, no-op-on-miss" patterns.

### `forEach` — iteration

`forEach` runs `do` once per item in `items`, exposing the current value as `{{<as>}}` for substitution inside the loop body.

```jsonc
{ "action": "forEach",
  "as": "id",
  "items": ["C-1001", "C-1002", "C-1003"],
  "do": [
    { "action": "tab", "op": "open", "url": "/customers/{{id}}/edit" },
    { "action": "fill", "xpath": "//input[@name='status']", "value": "reviewed" },
    { "action": "tab", "op": "close" }
  ] }
```

`items` accepts two shapes:

- **JSON array** of strings — `["a", "b", "c"]` literally in the script. Use this for small, known-up-front lists.
- **String** with `{{var}}` substitution — `"{{customerIds}}"` resolves the variable, splits on `,`, trims each entry, and skips empty entries. Use this for "process this comma-separated list" patterns.

The loop is sequential — one iteration at a time, awaiting each. No parallel execution for v1.

### Variable scoping in `forEach`

`ctx.variables[step.as]` is set to the current item at the start of each iteration. After the loop ends, the variable is **removed** so `{{<as>}}` substitution outside the loop doesn't see a stale value. If the variable existed before the loop, its prior value is restored on exit.

**Caveat — output collision.** Outputs saved inside the loop via `saveAs` collide across iterations (last write wins). Most workflows don't need per-iteration outputs; for those that do, write into the page DOM and read all values back after the loop. Namespaced outputs (`{step.as}_{i}`) may come in a future iteration if real demand surfaces.

### Combining patterns

The recursive interpreter lets you compose these naturally. "For each customer, click Save, and if a server error banner shows up, click Retry":

```jsonc
{ "action": "forEach",
  "as": "id",
  "items": ["A", "B", "C"],
  "do": [
    { "action": "tab", "op": "open", "url": "/customers/{{id}}/edit" },
    { "action": "click", "xpath": "//button[normalize-space(.)='Save']" },
    { "action": "if",
      "xpathExists": "//div[@class='error-banner']",
      "timeoutMs": 1500,
      "then": [ { "action": "click", "xpath": "//button[.='Retry']" } ] },
    { "action": "tab", "op": "close" }
  ] }
```

See fixture Section 25 for four pasteable scenarios covering if-then, if-else with `wait: false`, forEach over a JSON array, forEach over a comma-separated variable, and the nested forEach + if pattern shown above.

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
├── schema.ts              Step types + AutomationStep union (includes TabStep + WaitForResponseStep + IfStep + ForEachStep), substituteRaw / substituteXPath / xpathStringLiteral
├── parse.ts               JSON5 parse + validateScript (the per-action validator map) — recursive into if/forEach with depth cap
├── interpreter.ts         runScript + runStepArray — dispatches via the action registry; runStepArray exported for recursive use by if/forEach handlers
├── locator.ts             buildActionExpression / buildResolveExpression / buildDescribeExpression / buildCallFunctionExpression
├── page.ts                Page class — chrome.debugger client, multi-tab attachment map, fast-path + CDP, dialog handling, Network event router
├── errors.ts              withLocatorContext wrapper for structured action-handler errors
├── loader.ts              import.meta.glob loader for automations/*.json
├── tabs.ts                parseUrlMatcher + waitForTabComplete + isAttachable
├── event-waiter.ts        EventWaiter<T> — predicate-keyed waiter with ringbuffer (race-tolerant)
├── index.ts               barrel export
└── actions/
    ├── index.ts           Registry: { goto: gotoAction, ..., tab: tabAction, waitForResponse: waitForResponseAction }
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
    ├── describe.ts
    ├── tab.ts             Multi-tab + multi-window orchestration (open / openWindow / switchTo / waitForNew / close / next / previous)
    ├── waitForResponse.ts Network response wait (Batch 3) — urlMatches + status filter + opt-in body read
    ├── if.ts              Conditional branching (Batch 4) — xpathExists + then/else, timeoutMs or wait:false
    └── forEach.ts         Iteration (Batch 4) — array or comma-string items, per-iteration ctx.variables[as]

entrypoints/
├── background/            Service worker — message dispatcher + automation runner
│   ├── index.ts           defineBackground + sidePanel setup + onMessage dispatcher + broadcastLog
│   ├── runJsonAutomation.ts   The script-running function; takes LogFn + windowId
│   └── tabAccess.ts       Re-export shim of src/automation/tabs.ts (back-compat)
└── sidepanel/             React UI
    ├── App.tsx
    ├── main.tsx           React entry
    ├── main.ts            vestigial migration stub (env couldn't delete it)
    ├── style.css
    └── index.html

automations/               Local script library — gitignored except .gitkeep
                           import.meta.glob picks up every *.json at build time

test-fixtures/
└── all-content.html       Self-documenting fixture: 25 sections (every action + multi-tab + script-injection
                           + retry + network waits + conditional/loops) + 7 real-world examples (MUI, W3Schools,
                           react-select, Shepherd, Wikipedia/DuckDuckGo new-tab, Wikipedia/DuckDuckGo popup-window,
                           httpbin form POST + waitForResponse). Doubles as the smoke-automation target.

e2e/                       Playwright suite
├── fixtures/extension.ts  Persistent-context fixture loading the built extension
├── helpers/sidepanel.ts   pasteAndRun, waitForLog, forceFocus
└── specs/
    ├── smoke.spec.ts
    ├── fatal-paths.spec.ts
    ├── multi-tab.spec.ts  Page-triggered + script-triggered + openWindow + negative-timeout
    ├── retry.spec.ts      Baseline fail-fast + retry-succeeds + covered-overlay
    ├── waitForResponse.spec.ts  URL match + saveBody + status filter + timeout
    └── branching.spec.ts  if-then + if-else + forEach + nested forEach+if

src/automation/*.test.ts   Vitest unit tests (schema, parse, locator, interpreter, event-waiter)
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

129 tests, runs in under 2 seconds. No browser, no extension load.

### E2E tests (Playwright)

Launches a persistent Chromium context with the built extension loaded, drives automations through the side panel, asserts on fixture state + panel logs.

```bash
npx playwright install chromium   # one-time
npm run test:e2e                  # builds extension first, then runs suite
npm run test:e2e:ui               # interactive UI
```

19 tests — one full mega-fixture smoke, 3 fatal-path scenarios, 4 multi-tab cases (page-triggered fixme'd; script-triggered, openWindow popup, negative timeout), 3 retry cases (baseline fail-fast, retry succeeds, covered-overlay clears), 4 waitForResponse cases (URL match, saveBody, status filter rejects, timeout), 4 branching cases (if-then, if-else, forEach array, nested forEach+if). Runs in ~5-6 minutes. Headed mode is required (Chrome refuses extensions in headless), so CI on Linux needs `xvfb-run`.

Three E2E-specific shims live in the test setup; touch them only if you understand the comments first:

- **ESM `__dirname` derivation** — `package.json` has `"type": "module"`, so each E2E file derives `__dirname` from `import.meta.url`.
- **CDP `Emulation.setFocusEmulationEnabled`** — fires when the test creates the fixture page so `document.execCommand('insertText')` can fire its internal `beforeinput` event.
- **No-op dialog listener** — registered on every page in the persistent context to opt out of Playwright's auto-dismiss, letting the extension's CDP `Page.javascriptDialogOpening` handler win the race.

### Manual smoke (the cookbook)

`test-fixtures/all-content.html` is the canonical regression target. After any refactor of `page.ts`, `locator.ts`, or any action handler:

1. Open the fixture in the active tab.
2. Run `phase4-fixture-smoke.json` from the dropdown (lives in your `automations/` folder).
3. Watch the panel log: every action should report green, every result paragraph in the fixture should reflect the expected outcome.

The fixture also serves as a paste-and-run cookbook — each section has a 📋 Copy JSON button and an Expected outcome paragraph, covering 25 sections (every action plus multi-tab, script-injection, retry, network-wait, and conditional/loops cookbooks) plus 7 real-world examples (MUI, W3Schools, react-select, Shepherd, Wikipedia/DuckDuckGo new-tab, Wikipedia/DuckDuckGo popup-window, httpbin form POST + waitForResponse).

---

## Known limitations & non-goals

These are *not* bugs — they're explicit scope choices.

- **Doubly-nested OOPIFs are not auto-attached.** Cross-origin iframe inside another cross-origin iframe is invisible to the engine. Same-origin nesting works at any depth via `deepEval` recursion.
- **`evaluate` runs in the main frame only.** Reach into same-origin iframes from inside your expression (`document.querySelector('iframe').contentWindow.…`); cross-origin iframe evaluation isn't supported.
- **`upload` requires absolute file paths.** Relative paths get rejected at action-handler time. Chrome resolves relative paths against an unpredictable cwd.
- **No built-in credentials handling.** Secrets currently live in script `variables`, which means they're in the JSON. A `chrome.storage.local`-backed `{{secrets.password}}` mechanism is a future-phase candidate.
- **`forEach` iterates sequentially.** One iteration at a time, awaiting each. No parallel iteration — multi-iteration speedups would need concurrent debugger sessions per tab; not worth the complexity for v1.
- **`forEach` saveAs outputs collide.** When a step inside a loop uses `saveAs`, each iteration overwrites the prior one (last-wins). Most workflows don't need per-iteration outputs; for those that do, write into the page DOM and read all values back after the loop.
- **`if` instant-check (`wait: false`) is main-frame only.** Same scope as the `evaluate` action — reach into same-origin iframes by composing the xpath if needed.
- **`waitForResponse` is main-tab scoped.** Responses fired by auto-attached cross-origin iframe targets (OOPIFs) aren't captured by the engine's per-tab `EventWaiter`. Most CRM XHRs come from the main frame; revisit if a real workflow needs OOPIF-scoped responses.
- **Response body size has no cap.** `saveBody` puts the full string body into `ctx.outputs` regardless of size. A 5MB JSON response works but the memory footprint is real. Avoid `saveBody` on large payloads or extract just what you need via an `evaluate` step on the matched URL.
- **No screenshots-on-failure.** `Page.captureScreenshot` is a one-call wrapper away — declined for now (engine errors are detailed enough). Easy to add later if real demand surfaces.
- **No recorder.** Scripts are written by hand. A click-recorder UI would be a major UX leap and a major implementation investment.
- **One `<select>`-per-action.** `selectOption` works on one select at a time. Bulk operations require multiple steps.
- **`goto` short-circuits when already at the target URL.** Optimization for fast re-runs, but bites if you edit the page on disk and need a fresh render — manually reload the tab in Chrome (⌘R) between runs.
- **`file://` popup blocker on `window.open`.** `<a target="_blank">` clicks from inside a click handler on `file://` pages sometimes get swallowed. Workarounds: allow popups for `file:///` in `chrome://settings/content/popups`, OR use `tab open` (extension-side) instead of relying on the page-side `window.open`.

---

## Phases history

Mapping commit history to milestones:

- **Phase 0 / 0.5** — XPath canonical (replaced multi-language locators with XPath-only) and auto-CDP routing for closed-shadow pages.
- **Phase 1** — Action correctness: `FatalActionError` + disabled/readonly rejection, contenteditable fill (plain + Lexical-style), tighter visibility predicate (opacity, pointer-events), overlay hit-test on click.
- **Phase 2** — New actions: `evaluate`, `upload`, `selectOption`, `hover`. (`press` predates this phase.)
- **Phase 3** — Frame & navigation hardening: `goto.waitForXPath` for SPA-aware navigation, native dialog handling (`Page.enable` + `Page.handleJavaScriptDialog`).
- **Phase 4** — DX & error reporting: structured error messages, `describe` action, parse-time JSON validation, Vitest unit suite, Playwright E2E suite, mega-fixture cookbook (`all-content.html`), background folder refactor, this README.
- **Phase 5 Batch 1** — Multi-tab orchestration: `tab` action (open / switchTo / waitForNew / close / next / previous), `Page` class restructured around a per-tab `TabAttachment` map so revisiting a tab is a pointer flip not a re-attach, origin stack for `close` to pop back, `windowId` threading, fixture section 21 + 22 (multi-tab + script injection), three new E2E specs.
- **Phase 5 Batch 1.5** — Multi-window extension: `op: 'openWindow'` on the `tab` step, backed by `chrome.windows.create`. Supports `windowType: 'normal' | 'popup'` plus optional `width` / `height` / `left` / `top`. Reuses Batch 1's origin stack so `close` pops back to the source tab in the source window. `openTab` patched to use the current tab's `windowId` (not the engine's primary) so opens from inside a popup land in that popup. Six new validator tests, popup-window scenario added to fixture section 21, one new E2E case asserting cross-window behavior.
- **Phase 5 Batch 2** — Step retry policy: `retries?: number` (default 0, capped at 5) and `retryDelay?: number` (default 500ms) on every locator-using step. Implemented as a `RetryFields` mixin extended by every retry-eligible interface, validated by a shared `validateRetryFields` helper. `interpreter.ts` wraps every step in `runStepWithRetry` with a decision tree that retries non-fatal errors and `FatalActionError` with reason `'covered'`, but short-circuits on `'disabled'`, `'read-only'`, `'no-match'`, `'not-a-select'`, and `'unknown'`. `FatalActionError` grew a typed `reason: FatalReason` field; all six throw sites in `page.ts` now pass the reason through. Eight validator unit tests, nine interpreter unit tests, fixture section 23 with two retry scenarios, three E2E cases (baseline fail-fast, retry succeeds, covered-overlay clears).
- **Phase 5 Batch 3** — Network waits: new `waitForResponse` step backed by `Network.responseReceived` events. URL match via `parseUrlMatcher` (substring or `/regex/flags`); status filter accepts number, array, or range object; HTTP method enum filter; opt-in `saveBody` triggers `Network.getResponseBody`. Pulled the on-demand listener pattern out of `tabs.ts` into a new `EventWaiter<T>` abstraction with race-tolerant ringbuffer — `waitForNewTab` was refactored to use it (the race-tolerant `chrome.tabs.query` pre-check went away). `Network.enable` documented as disabling disk cache for the attached session. 12 EventWaiter unit tests, 10 validator tests for waitForResponse, fixture section 24 with four scenarios, four E2E cases (URL match, saveBody, status filter rejects, timeout).
- **Phase 5 Batch 4** — Conditional / branching: new `if` and `forEach` step types. `if` takes `xpathExists` + `then` + optional `else`, with explicit timing — required `timeoutMs` OR `wait: false`, no defaults. `forEach` takes `items` (JSON array or comma-separated `{{var}}`) + `as` + `do`; the loop variable is set per-iteration in `ctx.variables[as]` and removed after the loop (pre-existing values restored). Interpreter refactored: `runStepArray` extracted from `runScript` and exported for recursive use by the `if` / `forEach` handlers. Validator made recursive with a depth cap of 20 to catch buggy generators. 18 new validator tests, 3 new interpreter tests pinning variable-scope and comma-split behavior, fixture section 25 with five scenarios, four E2E cases (if-then, if-else with `wait: false`, forEach array, nested forEach + if).

**Phase 5 complete.** Multi-tab/window orchestration, retry policy, network waits, and conditional/loops all shipped. 17 actions total. The engine covers the script patterns CRM automation realistically needs.

Skipped scope (explicitly): nested-iframe forwarding (low real-world need for CRM workflows; revisit if a concrete use case surfaces).
