/**
 * Vitest configuration.
 *
 * Bare Vitest + jsdom — no WxtVitest plugin. Tried the plugin first per the
 * WXT testing docs, but WXT 0.19.16 (pinned to avoid the 0.19.29 rolldown
 * bug) bundles an older esbuild that hits a TextEncoder invariant check on
 * config load when jsdom is the environment. The plugin's actual services
 * (path aliases, WXT globals, `browser.*` polyfill) aren't needed by our
 * pure-function tests anyway — schema.ts / parse.ts / locator.ts only
 * touch `document`, `XPathResult`, and plain JS.
 *
 * If we later add tests that DO need WXT plumbing, the right move is to
 * unpin WXT (or use a separate config) rather than fight the version
 * mismatch.
 *
 * `jsdom` (not happy-dom) because happy-dom's `document.evaluate` is
 * incomplete — our XPath tests would silently pass against an incomplete
 * engine and miss real regressions.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
});
