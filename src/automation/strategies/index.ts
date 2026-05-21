/**
 * Action Strategy Pattern for Expression Building
 *
 * This module exports the strategy registry and all strategy implementations.
 * Strategies are registered as singletons at module load time.
 */

// Core interfaces and registry
export type { ActionStrategy, StrategyOpts } from './action-strategy.js';
export { StrategyRegistry } from './strategy-registry.js';
export { buildFatalError, buildNotFoundError } from './error-builder.js';

// Strategies
export { FillStrategy } from './fill-strategy.js';
export type { FillOptions } from './fill-strategy.js';
export { ClickStrategy } from './click-strategy.js';
export type { ClickOptions } from './click-strategy.js';
export { HoverStrategy } from './hover-strategy.js';
export type { HoverOptions } from './hover-strategy.js';
export { GetStrategy } from './get-strategy.js';
export type { GetOptions } from './get-strategy.js';

import { StrategyRegistry } from './strategy-registry.js';
import { FillStrategy } from './fill-strategy.js';
import { ClickStrategy } from './click-strategy.js';
import { HoverStrategy } from './hover-strategy.js';
import { GetStrategy } from './get-strategy.js';

/**
 * Global strategy registry instance.
 * All strategies are registered here at module initialization.
 */
export const strategyRegistry = new StrategyRegistry();

// Register strategies (Phase 3: all action strategies)
strategyRegistry.register(new FillStrategy());
strategyRegistry.register(new ClickStrategy());
strategyRegistry.register(new HoverStrategy());
strategyRegistry.register(new GetStrategy());

// 'find' is an alias for 'get' — both return a value from the matched element.
// 'find' reads better when you're thinking about discovery, 'get' when
// thinking about extraction.
strategyRegistry.registerKey('find', new GetStrategy());
