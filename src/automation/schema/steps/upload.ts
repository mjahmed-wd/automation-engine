/**
 * Inject files into a real `<input type="file">` via CDP
 * `DOM.setFileInputFiles`. There's no page-JS equivalent — `input.files` is
 * read-only and synthetic clicks can't open the native OS picker. This is the
 * only path that actually works.
 *
 * Requirements:
 *   - `xpath` must resolve to a real `<input type="file">`, not a styled
 *     wrapper button. Many sites hide the real input and surface a "Choose
 *     file" button instead — target the input directly (often
 *     `position:absolute; opacity:0`).
 *   - `files` must be **absolute** local paths on the machine running Chrome.
 *     Relative paths get resolved against an unpredictable cwd; we reject
 *     them up-front rather than fail silently in the browser.
 *
 *   { "action": "upload", "xpath": "//input[@type='file']", "files": "/Users/me/sample.csv" }
 */

import type { BaseStep, RetryFields } from '../base';

export interface UploadStep extends BaseStep, RetryFields {
  action: 'upload';
  xpath: string;
  files: string | string[];
  /** Accepted for parity; `cdpResolveXPath` already pierces closed shadow. */
  pierceClosed?: boolean;
  /** How long to poll for the file input to appear in the DOM. Default 20s. */
  timeoutMs?: number;
}
