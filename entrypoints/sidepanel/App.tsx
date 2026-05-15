/// <reference types="chrome" />

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AutomationSummary, AutomationTag, LogLevel } from '@/src/automation';

interface LogLine {
  id: number;
  ts: string;
  level: LogLevel;
  message: string;
}

const TABS: { id: AutomationTag; label: string }[] = [
  { id: 'action', label: 'Action' },
  { id: 'get', label: 'Get values' },
];

const PLACEHOLDERS: Record<AutomationTag, string> = {
  action: '{ "steps": [ { "action": "goto", "url": "..." } ] }',
  get: '{ "action": "get", "xpath": "//h1", "saveAs": "title" }',
};

const HINTS: Record<AutomationTag, string> = {
  action:
    'XPath locator. Accepts a full script, a bare array, or a single step. Comments and trailing commas OK.',
  get: 'XPath locator. Reads attribute, property, or value. Optional regex extracts a match.',
};

export function App() {
  const [activeTab, setActiveTab] = useState<AutomationTag>('action');
  const [examples, setExamples] = useState<AutomationSummary[]>([]);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const logIdRef = useRef(0);

  // ---- log stream from background ----
  useEffect(() => {
    const handler = (msg: any) => {
      if (msg?.type === 'log') {
        const level = (msg.level as LogLevel) ?? 'info';
        const message = String(msg.message ?? '');
        setLogs((curr) =>
          curr.concat({
            id: ++logIdRef.current,
            ts: new Date().toLocaleTimeString(),
            level,
            message,
          }),
        );
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, []);

  // ---- load examples once ----
  useEffect(() => {
    chrome.runtime
      .sendMessage({ type: 'listAutomations' })
      .then((res) => {
        if (res?.ok) setExamples(res.automations as AutomationSummary[]);
      })
      .catch(() => {
        /* sidepanel just opened before bg booted; harmless */
      });
  }, []);

  const examplesByTag = useMemo(() => {
    const map: Record<AutomationTag, AutomationSummary[]> = { action: [], get: [] };
    for (const e of examples) map[e.tag].push(e);
    return map;
  }, [examples]);

  const appendLog = useCallback((level: LogLevel, message: string) => {
    setLogs((curr) =>
      curr.concat({
        id: ++logIdRef.current,
        ts: new Date().toLocaleTimeString(),
        level,
        message,
      }),
    );
  }, []);

  const clearLog = useCallback(() => setLogs([]), []);

  return (
    <main className="app">
      <header>
        <h1>Automation Engine</h1>
        <p className="subtitle">JSON-driven · chrome.debugger / CDP</p>
      </header>

      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tab${activeTab === t.id ? ' active' : ''}`}
            role="tab"
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <Pane
        tag="action"
        active={activeTab === 'action'}
        examples={examplesByTag.action}
        onLog={appendLog}
      />
      <Pane
        tag="get"
        active={activeTab === 'get'}
        examples={examplesByTag.get}
        onLog={appendLog}
      />

      <section className="card log-card">
        <header className="log-header">
          <h2>Log</h2>
          <button type="button" className="ghost" onClick={clearLog}>
            Clear
          </button>
        </header>
        <LogList lines={logs} />
      </section>

      <footer>
        <small>
          Powered by WXT · drop a JSON file in <code>automations/</code> to add a new
          template.
        </small>
      </footer>
    </main>
  );
}

// ====================================================================
// Pane — one tab's contents (editor + run + outputs)
// ====================================================================

interface PaneProps {
  tag: AutomationTag;
  active: boolean;
  examples: AutomationSummary[];
  onLog: (level: LogLevel, message: string) => void;
}

function Pane({ tag, active, examples, onLog }: PaneProps) {
  const [json, setJson] = useState('');
  const [outputs, setOutputs] = useState<Record<string, string> | null>(null);
  const [running, setRunning] = useState(false);

  const insertExample = useCallback(
    (id: string) => {
      const ex = examples.find((e) => e.id === id);
      if (ex) setJson(ex.source);
    },
    [examples],
  );

  const run = useCallback(async () => {
    const trimmed = json.trim();
    if (!trimmed) {
      onLog('error', 'Editor is empty.');
      return;
    }
    setRunning(true);
    setOutputs(null);
    onLog('info', `▶ Run (${tag})`);
    try {
      const win = await chrome.windows.getCurrent();
      const res = await chrome.runtime.sendMessage({
        type: 'runJson',
        json: trimmed,
        windowId: win.id,
      });
      if (!res?.ok) {
        onLog('error', res?.error ?? 'Unknown failure');
        return;
      }
      const got = res.outputs as Record<string, string> | undefined;
      if (got && Object.keys(got).length > 0) setOutputs(got);
    } catch (err) {
      onLog('error', (err as Error).message);
    } finally {
      setRunning(false);
    }
  }, [json, onLog, tag]);

  return (
    <section className={`pane${active ? ' active' : ''}`} data-pane={tag}>
      <div className="pane-toolbar">
        <select
          className="examples"
          value=""
          onChange={(e) => {
            const v = e.target.value;
            if (v) insertExample(v);
            e.target.value = '';
          }}
        >
          <option value="">Insert example…</option>
          {examples.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      </div>
      <textarea
        className="json-editor"
        spellCheck={false}
        autoComplete="off"
        placeholder={PLACEHOLDERS[tag]}
        value={json}
        onChange={(e) => setJson(e.target.value)}
      />
      <div className="pane-footer">
        <button type="button" className="run" disabled={running} onClick={run}>
          {running ? 'Running…' : 'Run'}
        </button>
        <span className="hint">{HINTS[tag]}</span>
      </div>
      {outputs && Object.keys(outputs).length > 0 && (
        <pre className={`outputs${tag === 'get' ? ' prominent' : ''}`}>
          {Object.entries(outputs)
            .map(([k, v]) => `${k}: ${v === '' ? '(empty)' : v}`)
            .join('\n')}
        </pre>
      )}
    </section>
  );
}

// ====================================================================
// LogList — autoscrolls to the bottom on new lines
// ====================================================================

function LogList({ lines }: { lines: LogLine[] }) {
  const ulRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (ulRef.current) {
      ulRef.current.scrollTop = ulRef.current.scrollHeight;
    }
  }, [lines]);
  return (
    <ul className="log" ref={ulRef} aria-live="polite">
      {lines.map((line) => (
        <li key={line.id} className={`log-line log-${line.level}`}>
          <span className="ts">{line.ts}</span>
          <span className="msg">{line.message}</span>
        </li>
      ))}
    </ul>
  );
}
