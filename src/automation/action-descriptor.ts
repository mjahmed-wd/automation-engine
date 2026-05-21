/**
 * ActionDescriptor — Declarative action execution pattern.
 *
 * Part of Phase 6 refactoring to make action handlers more declarative
 * and centralize error context handling.
 */

import type { Locator, LogFn } from './schema';
import type { FrameResult } from './page';
import type { Mode } from './locator';

/**
 * A declarative description of an action to execute. Replaces direct
 * method calls like `page.fill()` with a data structure that can be
 * centrally executed with consistent error handling.
 */
export interface ActionDescriptor<T = any> {
  /** Action name for logging/error messages, e.g. 'fill', 'click'. */
  name: string;
  /** Execution mode — maps to buildActionExpression mode parameter. */
  mode: Mode;
  /** Element locator after substitution. */
  locator: Locator;
  /** Original xpath from step (before substitution), for error messages. */
  originalXPath?: string;
  /** Action-specific options (value for fill, attribute for get, etc.). */
  opts?: T;
  /** Timeout in milliseconds. */
  timeoutMs?: number;
  /** Force CDP path even if no closed shadow detected. */
  pierceClosed?: boolean;
}

/**
 * Result of executing an ActionDescriptor. Same as FrameResult for now,
 * but kept separate for future extensibility (e.g., adding timing info).
 */
export type ActionResult = FrameResult;

