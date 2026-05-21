# Release Notes

All notable changes to this project will be documented in this file.

## [0.0.2] - 2025-01-21

### Breaking Changes
None

### Added
- **ActionDescriptor pattern** - Declarative action execution with centralized error handling
- **InputExecutor module** - CDP Input.dispatch* operations (click, hover, keypress)
- **UploadHandler module** - File input detection and upload via DOM.setFileInputFiles
- **SelectHandler module** - Select option interaction with value/label/index support
- **EventRouter module** - CDP event routing to handlers
- **Navigator module** - Page navigation logic (goto)
- **serialization utility** - serializeEvalResult for CDP result handling

### Changed
- **Page class reduced** from 2,342 → 991 lines (58% reduction)
- **Page now acts as thin orchestrator** delegating to specialized modules:
  - CDPPort (CDP messaging)
  - TabManager (tab lifecycle)
  - NetworkMonitor (network events)
  - DOMExecutor (element discovery)
  - InputExecutor (CDP Input operations)
  - UploadHandler (file uploads)
  - SelectHandler (select interactions)
  - EventRouter (event routing)
  - Navigator (navigation)
- **Action handlers simplified** - fill, click, get, hover, waitFor now use ActionDescriptor pattern
- **Error context centralized** - Page.executeAction handles structured errors

### Fixed
- Improved testability through better module separation
- Removed circular dependencies between modules

### Internal
- 7-phase refactoring completed (see [Appendix](#appendix-002-refactoring-details) for technical details)
- All tests passing
- E2E tests verified

---

## [0.0.1] - Initial release

### Added
- JSON-driven web automation for Chrome extensions
- Core actions: goto, fill, click, get, hover, waitFor, evaluate, press, upload, selectOption, wait, describe
- Multi-tab orchestration with tab action (open, openWindow, switchTo, waitForNew, close, next, previous)
- Network response waiting with waitForResponse
- Conditional and loop control flow (if, forEach)
- XPath-only locators with automatic:
  - Shadow-piercing (open and closed Shadow DOM)
  - Same-origin iframe traversal
  - OOPIF (cross-origin iframe) attachment
- Side panel UI with script storage (chrome.storage.local)
- Variable substitution (text and XPath-safe)
- Retry policy with per-step configuration

---

## Appendix: 0.0.2 Refactoring Details

*Technical details for contributors — the "why" behind the changes.*

### Overview

The Page class was refactored from a 2,342-line monolith into a thin orchestrator (991 lines) by extracting focused modules. This improves testability, maintainability, and AI-navigability.

### Phase 1: CDPPort extraction
Extracted CDP messaging wrapper around `chrome.debugger` with send/target methods.

### Phase 2: TabManager extraction
Extracted multi-tab attachment and lifecycle management (446 lines).

### Phase 3: NetworkMonitor extraction
Extracted network event tracking and waitForResponse functionality (211 lines).

### Phase 4: DOMExecutor extraction
Extracted element discovery via fast-path (IIFE) and CDP DOM walk fallback (637 lines).

### Phase 5: Refactor Page to thin orchestrator
- 5.1: Extract InputExecutor (CDP Input.dispatch* operations) - 132 lines
- 5.2: Extract UploadHandler (file input logic) - 113 lines
- 5.3: Extract SelectHandler (select option logic) - 183 lines
- 5.4: Simplify click/hover using shared cdpResolveAndVerify
- 5.5: Extract EventRouter (CDP event routing) - 93 lines
- 5.6: Extract cdpDescribe to DOMExecutor
- 5.7: Extract Navigator (goto navigation logic) - 69 lines
- 5.8: Extract serializeEvalResult to serialization utility
- 5.9: Remove dead code (attachTab, cdpResolveXPath wrapper, coerceFatalReason)

### Phase 6: Deepen Action Wrappers
- 6.1: Create ActionDescriptor pattern (action-descriptor.ts)
- 6.2: Add Page.executeAction as central execution point
- 6.3: Simplify action handlers (fill, click, get, hover, waitFor)
- 6.4: Centralize error context in executeAction

### Phase 7: Final Cleanup
- 7.1: Audit exports (removed unused NetworkResponse re-export)
- 7.2: Remove dead code (unused 'send' variable in upload)
- 7.3: Update documentation
- 7.4: Final metrics verified

### Module Dependency Graph (Post-Refactoring)

```
Page (orchestrator)
 ├── CDPPort (CDP messaging)
 ├── TabManager (tab lifecycle)
 ├── NetworkMonitor (network events)
 ├── DOMExecutor (element discovery)
 ├── InputExecutor (CDP Input operations)
 ├── UploadHandler (file uploads)
 ├── SelectHandler (select interactions)
 ├── EventRouter (event routing)
 └── Navigator (navigation)

Action Handlers
 └── Page.executeAction()

Interpreter
 └── Action Handlers
```

### Notes
- No changes to external APIs — action step interfaces remain stable
- Backward compatible — existing automations continue to work
- Each module can be tested in isolation with mock CDPPort
- Clear module boundaries make code easier to understand and navigate
