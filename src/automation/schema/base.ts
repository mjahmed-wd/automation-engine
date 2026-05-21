/**
 * Base types for automation schema.
 */

export interface Locator {
  xpath: string;
}

export interface BaseStep {
  action: string;
}

/**
 * Retry fields (Phase 5 Batch 2) — mixed into every locator-using step.
 *
 * Why a mixin rather than fields on `BaseStep`: not every step is retry-eligible.
 * `wait` is a pure sleep (nothing to retry), `goto` and `dialog` are one-shot
 * navigation/arming. Keeping the fields out of those interfaces makes typos
 * (`{"action":"wait","ms":100,"retries":3}`) catch at parse time.
 *
 * Retry semantics:
 *   - `retries` is the number of ADDITIONAL attempts after the first. Total
 *     attempts = retries + 1. Default 0 (current single-attempt behavior).
 *   - `retryDelay` is milliseconds between attempts. Default 500.
 *   - `FatalActionError` with reason `'disabled'`, `'read-only'`, `'no-match'`,
 *     `'not-a-select'`, or `'unknown'` DOES NOT retry — those states won't
 *     fix themselves.
 *   - `FatalActionError` with reason `'covered'` DOES retry by default —
 *     toast banners, loading spinners, and modal scrims routinely self-dismiss.
 *   - Validator caps `retries` at 5 to prevent runaway scripts (worst-case
 *     time per step ~= (retries+1) × timeoutMs + retries × retryDelay).
 */
export interface RetryFields {
  retries?: number;
  retryDelay?: number;
}

export type LogLevel = 'info' | 'success' | 'error';
export type LogFn = (level: LogLevel, message: string) => void;

export interface ExecutionContext {
  variables: Record<string, string>;
  outputs: Record<string, string>;
  log: LogFn;
}
