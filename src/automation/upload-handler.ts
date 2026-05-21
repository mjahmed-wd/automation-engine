/**
 * UploadHandler — File input detection and DOM.setFileInputFiles.
 *
 * Extracted from Page class during Phase 5 of architecture refactoring.
 * Owns file path validation, file input detection, and CDP file upload.
 */

import type { LogFn, Locator } from './schema';
import type { CDPPort } from './cdp-port';
import type { Target } from './cdp-port';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class UploadHandler {
  private readonly log: LogFn;
  private readonly cdpPort: CDPPort;

  constructor(log: LogFn, cdpPort: CDPPort) {
    this.log = log;
    this.cdpPort = cdpPort;
  }

  /**
   * Upload files to a file input element.
   *
   * Validates paths are absolute, polls for the input to appear, verifies it's
   * actually a file input (not a styled wrapper), then uses CDP to set files.
   */
  async upload(
    target: Target,
    locator: Locator,
    files: string[],
    opts: {
      timeoutMs?: number;
      resolveXPath: (send: (m: string, p?: Record<string, unknown>) => Promise<any>, xpath: string) => Promise<number | null>;
    },
  ): Promise<void> {
    for (const f of files) {
      if (!isAbsoluteFilePath(f)) {
        throw new Error(
          `upload: file path must be absolute — got '${f}'. ` +
            'Chrome resolves relative paths against an unpredictable cwd, so we require an absolute path on the local filesystem.',
        );
      }
    }

    const send = (m: string, p?: Record<string, unknown>) =>
      this.cdpPort.sendCommand(target, m, p);

    const timeoutMs = opts.timeoutMs ?? 20_000;
    const deadline = Date.now() + timeoutMs;
    let nodeId: number | null = null;

    // Poll for the input to appear.
    while (true) {
      nodeId = await opts.resolveXPath(send, locator.xpath);
      if (nodeId) break;
      if (Date.now() >= deadline) {
        throw new Error(
          `upload: locator not found within ${Math.round(timeoutMs / 1000)}s — '${locator.xpath}'`,
        );
      }
      await sleep(500);
    }

    // Verify it's actually a file input.
    const resolved = await send('DOM.resolveNode', { nodeId });
    const objectId = resolved?.object?.objectId;
    if (objectId) {
      try {
        const check = await send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration:
            'function () { return { tag: this.tagName, type: (this.type || "").toLowerCase() }; }',
          returnByValue: true,
        });
        const meta = check?.result?.value as { tag?: string; type?: string } | undefined;
        if (meta?.tag !== 'INPUT' || meta?.type !== 'file') {
          const got = meta?.tag
            ? `<${meta.tag.toLowerCase()}${meta.type ? ` type="${meta.type}"` : ''}>`
            : 'unknown';
          throw new Error(
            `upload: target is not an <input type="file"> (got ${got}). ` +
              "Many sites hide the real input behind a styled wrapper button — point the xpath at the input itself, not the wrapper.",
          );
        }
      } finally {
        await send('Runtime.releaseObject', { objectId }).catch(() => {});
      }
    }

    await send('DOM.setFileInputFiles', { nodeId, files });
    this.log(
      'success',
      `Uploaded ${files.length} file${files.length === 1 ? '' : 's'} into '${locator.xpath}'.`,
    );
  }
}

/**
 * Cross-platform absolute-path heuristic for `DOM.setFileInputFiles`.
 *   - Unix / macOS: starts with `/`
 *   - Windows drive: `C:\…` or `C:/…`
 *   - Windows UNC:   `\\server\share\…`
 * Anything else we treat as relative and reject up-front.
 */
export function isAbsoluteFilePath(p: string): boolean {
  if (!p) return false;
  if (p.startsWith('/')) return true;
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;
  if (p.startsWith('\\\\')) return true;
  return false;
}
