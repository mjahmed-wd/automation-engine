/**
 * EventRouter — Routes CDP events to appropriate handlers.
 *
 * Extracted from Page class during Phase 5 of architecture refactoring.
 * Owns routing of Target, Page, and Network events to TabManager,
 * NetworkMonitor, and CDPPort.
 */

import type { LogFn } from './schema';
import type { CDPPort } from './cdp-port';
import type { TabAttachment } from './tab-manager';
import { NetworkMonitor } from './network-monitor';

export class EventRouter {
  private readonly log: LogFn;
  private readonly cdpPort: CDPPort;
  private readonly networkMonitor: NetworkMonitor;
  private readonly getAttachment: (tabId: number) => TabAttachment | undefined;

  constructor(
    log: LogFn,
    cdpPort: CDPPort,
    networkMonitor: NetworkMonitor,
    getAttachment: (tabId: number) => TabAttachment | undefined,
  ) {
    this.log = log;
    this.cdpPort = cdpPort;
    this.networkMonitor = networkMonitor;
    this.getAttachment = getAttachment;
  }

  /**
   * Route a CDP event to the appropriate handler. Events are routed per-tab:
   * writes go to the attachment that fired the event, NOT the current
   * attachment. A dialog on a backgrounded tab still consumes that tab's
   * arming, not the active tab's.
   */
  onEvent(sourceTabId: number, method: string, params: any): void {
    const attachment = this.getAttachment(sourceTabId);
    if (!attachment) return;

    if (method === 'Target.attachedToTarget') {
      attachment.childSessions.set(params.sessionId, params.targetInfo);
      this.log('info', `Auto-attached ${params.targetInfo.type}: ${params.targetInfo.url}`);
    } else if (method === 'Target.detachedFromTarget') {
      attachment.childSessions.delete(params.sessionId);
      attachment.cdpReadyChildren.delete(params.sessionId);
    } else if (method === 'Page.javascriptDialogOpening') {
      this.handleDialogOpening(attachment, params);
    } else if (method === 'Network.requestWillBeSent') {
      const reqId: string | undefined = params?.requestId;
      const reqMethod: string | undefined = params?.request?.method;
      if (reqId && reqMethod) {
        this.networkMonitor.onRequest(sourceTabId, reqId, reqMethod);
      }
    } else if (method === 'Network.responseReceived') {
      const reqId: string | undefined = params?.requestId;
      const response = params?.response;
      if (!reqId || !response) return;
      this.networkMonitor.onResponse(
        sourceTabId,
        reqId,
        String(response.url ?? ''),
        Number(response.status ?? 0),
      );
    }
  }

  private handleDialogOpening(attachment: TabAttachment, params: any): void {
    // The JS thread is blocked until we respond. Resolve the one-shot
    // response if armed, else auto-accept so the script doesn't hang.
    const armed = attachment.nextDialogResponse;
    attachment.nextDialogResponse = null;
    const response = armed ?? { accept: true, promptText: '' };
    const dialogType: string = params?.type ?? 'dialog';
    const messageQuoted = params?.message ? `"${String(params.message)}"` : '';
    const choice = response.accept
      ? response.promptText
        ? `accept with "${response.promptText}"`
        : 'accept'
      : 'cancel';
    this.log(
      'info',
      `Dialog ${dialogType}(${messageQuoted}) → ${choice}${armed ? '' : ' (default)'}`,
    );
    this.cdpPort.sendCommand(attachment.target, 'Page.handleJavaScriptDialog', {
      accept: response.accept,
      promptText: response.promptText,
    }).catch((err: any) =>
      this.log('error', `handleJavaScriptDialog failed: ${err?.message ?? err}`),
    );
  }
}
