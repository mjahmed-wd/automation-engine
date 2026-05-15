/**
 * Backwards-compatible re-export shim. The real implementations live in
 * `src/automation/tabs.ts` so that `Page` can use them without inverting the
 * background → automation layering. Existing imports in
 * `runJsonAutomation.ts` keep working.
 */

export {
  isAttachable,
  waitForTabComplete,
  parseUrlMatcher,
  waitForNewTabMatching,
} from '@/src/automation/tabs';
