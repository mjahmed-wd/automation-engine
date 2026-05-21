import type { Mode } from '../locator.js';
import type { ActionStrategy, StrategyOpts } from './action-strategy.js';

/**
 * Registry for action strategies, mapping modes to their implementations.
 *
 * Strategies are registered as singletons and retrieved by mode key.
 * The registry enforces that each mode has exactly one strategy.
 */
export class StrategyRegistry {
  private strategies = new Map<Mode, ActionStrategy>();

  /**
   * Register a strategy for its mode.
   * @throws Error if a strategy is already registered for this mode
   */
  register<TOpts extends StrategyOpts>(strategy: ActionStrategy<TOpts>): void {
    if (this.strategies.has(strategy.mode)) {
      throw new Error(`Strategy already registered for mode: ${strategy.mode}`);
    }
    this.strategies.set(strategy.mode, strategy);
  }

  /**
   * Register a strategy for a specific mode key.
   * Useful for aliases (e.g., 'find' → GetStrategy).
   * @throws Error if a strategy is already registered for this mode
   */
  registerKey<TOpts extends StrategyOpts>(
    mode: Mode,
    strategy: ActionStrategy<TOpts>,
  ): void {
    if (this.strategies.has(mode)) {
      throw new Error(`Strategy already registered for mode: ${mode}`);
    }
    this.strategies.set(mode, strategy);
  }

  /**
   * Get the strategy for a given mode.
   * @throws Error if no strategy is registered for this mode
   */
  get(mode: Mode): ActionStrategy {
    const strategy = this.strategies.get(mode);
    if (!strategy) {
      throw new Error(`No strategy registered for mode: ${mode}`);
    }
    return strategy;
  }

  /**
   * Check if a mode has a registered strategy.
   */
  has(mode: Mode): boolean {
    return this.strategies.has(mode);
  }

  /**
   * Get all registered modes.
   */
  modes(): Mode[] {
    return Array.from(this.strategies.keys());
  }
}
