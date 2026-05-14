import type { ExecutionContext, UploadStep } from '../schema';
import { resolveLocator, substituteRaw } from '../schema';
import type { Page } from '../page';

/**
 * Attach files to an `<input type="file">` via CDP. Files must be absolute
 * paths on the machine running Chrome — page-JS can't write to
 * `input.files`, so this is the only mechanism that actually works.
 *
 * `{{var}}` interpolation is applied to each file path so you can drive
 * paths from script variables:
 *
 *   {
 *     "action": "upload",
 *     "xpath": "//input[@type='file']",
 *     "files": ["{{receiptPath}}"]
 *   }
 */
export async function uploadAction(step: UploadStep, ctx: ExecutionContext, page: Page) {
  if (!step.xpath) {
    throw new Error('upload: "xpath" is required.');
  }
  if (step.files == null) {
    throw new Error('upload: "files" is required (string or array of absolute paths).');
  }
  const raw = Array.isArray(step.files) ? step.files : [step.files];
  if (raw.length === 0) {
    throw new Error('upload: "files" must contain at least one path.');
  }
  const files = raw.map((f) => substituteRaw(String(f), ctx));
  const locator = resolveLocator(step, ctx);
  await page.upload(locator, files, {
    pierceClosed: step.pierceClosed,
    timeoutMs: step.timeoutMs,
  });
}
