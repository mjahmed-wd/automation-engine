/**
 * SelectHandler — Native select element interaction.
 *
 * Extracted from Page class during Phase 5 of architecture refactoring.
 * Owns select option selection, polling for element appearance, and
 * option matching by value or label.
 */

import type { LogFn, Locator } from './schema';
import type { CDPPort } from './cdp-port';
import type { Target } from './cdp-port';
import { FatalActionError } from './dom-executor';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Coerce the in-page IIFE's reason string onto our typed FatalReason enum.
 */
function coerceFatalReason(s: string | undefined): 'disabled' | 'read-only' | 'covered' | 'no-match' | 'not-a-select' | 'unknown' {
  switch (s) {
    case 'disabled':
    case 'read-only':
    case 'covered':
    case 'no-match':
    case 'not-a-select':
      return s;
    default:
      return 'unknown';
  }
}

export class SelectHandler {
  private readonly log: LogFn;
  private readonly cdpPort: CDPPort;

  constructor(log: LogFn, cdpPort: CDPPort) {
    this.log = log;
    this.cdpPort = cdpPort;
  }

  /**
   * Pick option(s) in a native `<select>`. Resolves the select via
   * XPath resolution (with polling), then runs an in-page iterator that
   * sets `selectedIndex` (single) or toggles `option.selected` per-option
   * (multi), then dispatches `input` + `change`. Returns the count of
   * options that ended up selected.
   *
   * Failure modes that surface as FatalActionError (no point in retrying):
   *   - resolved element isn't a `<select>` (probably a custom dropdown)
   *   - the select is disabled
   *   - no option matched the requested value(s)/label(s)
   */
  async selectOption(
    target: Target,
    locator: Locator,
    wants: string[],
    opts: {
      useLabel?: boolean;
      timeoutMs?: number;
      resolveXPath: (send: (m: string, p?: Record<string, unknown>) => Promise<any>, xpath: string) => Promise<number | null>;
    },
  ): Promise<number> {
    const send = (m: string, p?: Record<string, unknown>) =>
      this.cdpPort.sendCommand(target, m, p);

    const timeoutMs = opts.timeoutMs ?? 20_000;
    const deadline = Date.now() + timeoutMs;
    let nodeId: number | null = null;

    // Poll for the select to appear.
    while (true) {
      nodeId = await opts.resolveXPath(send, locator.xpath);
      if (nodeId) break;
      if (Date.now() >= deadline) {
        throw new Error(
          `selectOption: locator not found within ${Math.round(timeoutMs / 1000)}s — '${locator.xpath}'`,
        );
      }
      await sleep(500);
    }

    const resolved = await send('DOM.resolveNode', { nodeId });
    const objectId = resolved?.object?.objectId;
    if (!objectId) {
      throw new Error('selectOption: could not resolve element to an object.');
    }

    // In-page iterator. Returns either {ok:true, selected:n} or a fatal
    // sentinel — we surface fatal as FatalActionError so the run loop
    // stops politely instead of doing CDP retries.
    const fnDecl = `function (wants, useLabel) {
      if (this.tagName !== 'SELECT') {
        return {
          ok: false,
          fatal: true,
          reason: 'not-a-select',
          message: 'selectOption: target is not <select> (got <' + (this.tagName ? this.tagName.toLowerCase() : '?') + '>).',
        };
      }
      if (this.disabled) {
        return {
          ok: false,
          fatal: true,
          reason: 'disabled',
          message: 'selectOption: <select> is disabled.',
        };
      }
      var wantSet = {};
      for (var w = 0; w < wants.length; w++) wantSet[String(wants[w])] = true;
      var multi = this.multiple === true;
      var selected = 0;
      var firstMatchIdx = -1;
      for (var i = 0; i < this.options.length; i++) {
        var opt = this.options[i];
        var key = useLabel ? (opt.label || '').trim() : String(opt.value);
        var match = Object.prototype.hasOwnProperty.call(wantSet, key);
        if (multi) {
          opt.selected = match;
          if (match) selected++;
        } else if (match && firstMatchIdx === -1) {
          firstMatchIdx = i;
        }
      }
      if (!multi) {
        if (firstMatchIdx === -1) {
          return {
            ok: false,
            fatal: true,
            reason: 'no-match',
            message: 'selectOption: no option matched ' + JSON.stringify(wants) + (useLabel ? ' (by label)' : ' (by value)') + '.',
          };
        }
        this.selectedIndex = firstMatchIdx;
        selected = 1;
      } else if (selected === 0) {
        return {
          ok: false,
          fatal: true,
          reason: 'no-match',
          message: 'selectOption: no option matched ' + JSON.stringify(wants) + (useLabel ? ' (by label)' : ' (by value)') + '.',
        };
      }
      this.dispatchEvent(new Event('input', { bubbles: true }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, selected: selected };
    }`;

    let count = 0;
    try {
      const res = await send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: fnDecl,
        arguments: [{ value: wants }, { value: opts.useLabel === true }],
        returnByValue: true,
      });
      if (res?.exceptionDetails) {
        throw new Error(
          res.exceptionDetails.exception?.description ??
            res.exceptionDetails.text ??
            'selectOption: callFunctionOn failed',
        );
      }
      const result = res?.result?.value as
        | { ok: boolean; fatal?: boolean; reason?: string; message?: string; selected?: number }
        | undefined;
      if (result?.fatal) {
        throw new FatalActionError(
          result.message ?? 'selectOption rejected',
          coerceFatalReason(result.reason),
        );
      }
      count = result?.selected ?? 0;
    } finally {
      await send('Runtime.releaseObject', { objectId }).catch(() => {});
    }

    this.log(
      'success',
      `Selected ${count} option${count === 1 ? '' : 's'} in '${locator.xpath}'.`,
    );
    return count;
  }
}
