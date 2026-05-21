import type { Mode } from '../locator.js';

/**
 * Base marker for strategy options. Each strategy extends with its specific options.
 */
export interface StrategyOpts {}

/**
 * Strategy pattern for action expression building.
 *
 * Each mode (fill, click, hover, get) implements this interface to generate
 * the core action block that executes in-page.
 *
 * The buildActionBlock method returns a string containing JavaScript code that
 * will be injected into a template. The code should use {{ELEMENT}} as a
 * placeholder for the element reference (replaced with 'this' for CDP path
 * or 'el' for fast-path).
 *
 * @template TOpts - The specific options this strategy accepts
 */
export interface ActionStrategy<TOpts extends StrategyOpts = StrategyOpts> {
  /** The mode this strategy handles */
  readonly mode: Mode;

  /**
   * Generate the core action block for this strategy.
   * @param opts - Strategy-specific options
   * @returns JavaScript code block as string
   */
  buildActionBlock(opts: TOpts): string;
}
