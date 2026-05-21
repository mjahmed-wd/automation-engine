/**
 * Automation schema barrel export.
 *
 * This file re-exports all types from the schema directory structure.
 */

// Base types
export * from './schema/base';

// Union type and script types
export * from './schema/union';

// Substitution utilities
export * from './schema/substitution';

// Individual step types
export * from './schema/steps/goto';
export * from './schema/steps/fill';
export * from './schema/steps/get';
export * from './schema/steps/click';
export * from './schema/steps/wait';
export * from './schema/steps/waitFor';
export * from './schema/steps/press';
export * from './schema/steps/evaluate';
export * from './schema/steps/upload';
export * from './schema/steps/selectOption';
export * from './schema/steps/hover';
export * from './schema/steps/dialog';
export * from './schema/steps/describe';
export * from './schema/steps/tab';
export * from './schema/steps/waitForResponse';
export * from './schema/steps/if';
export * from './schema/steps/forEach';
