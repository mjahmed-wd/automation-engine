/**
 * Dispatch a real keyboard event via CDP `Input.dispatchKeyEvent`. Used for
 * the case where a form is wired to `@keyup.enter` on an input (Vue
 * convention when there's no `<form>` wrapper), so clicking the visible
 * submit button is a no-op and the only way to submit is to press Enter
 * with the input focused.
 *
 * `xpath` is optional — if provided, the element is focused before the
 * keystroke; if omitted, the keystroke goes to whatever has focus already
 * (typically the input most recently `fill`ed).
 */

import type { BaseStep, RetryFields } from '../base';

export interface PressStep extends BaseStep, RetryFields {
  action: 'press';
  xpath?: string;
  key: string;
  pierceClosed?: boolean;
}
