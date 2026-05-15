/// <reference types="chrome" />

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import JSON5 from 'json5';
import type { AutomationSummary, LogLevel } from '@/src/automation';

interface LogLine {
  id: number;
  ts: string;
  level: LogLevel;
  message: string;
}

interface SavedScript {
  id: string;
  name: string;
  source: string;
  createdAt: number;
  updatedAt: number;
}

const STORAGE_KEY = 'savedScripts';
const EDITOR_PLACEHOLDER =
  '{ "steps": [ { "action": "goto", "url": "..." } ] }';
const EDITOR_HINT =
  'Accepts a full script, a bare array, or a single step. JSON5 comments and trailing commas OK.';

// ====================================================================
// Storage helpers — chrome.storage.local backed
// ====================================================================

function storageAvailable(): boolean {
  return (
    typeof chrome !== 'undefined' &&
    !!chrome.storage &&
    !!chrome.storage.local
  );
}

async function loadSavedScripts(): Promise<SavedScript[]> {
  if (!storageAvailable()) return [];
  const res = await chrome.storage.local.get(STORAGE_KEY);
  const raw = res?.[STORAGE_KEY];
  return Array.isArray(raw) ? (raw as SavedScript[]) : [];
}

async function writeSavedScripts(scripts: SavedScript[]): Promise<void> {
  if (!storageAvailable()) {
    throw new Error(
      'chrome.storage is unavailable — add "storage" to the manifest permissions.',
    );
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: scripts });
}

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Best-effort extraction of a top-level `name` from the editor's content.
 * Returns the trimmed name string, or null if the source doesn't parse or
 * doesn't have a string `name` at the top level (e.g. bare arrays / single
 * steps / parse errors).
 */
function tryExtractName(source: string): string | null {
  try {
    const parsed = JSON5.parse(source);
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof (parsed as any).name === 'string'
    ) {
      const trimmed = (parsed as any).name.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    return null;
  } catch {
    return null;
  }
}

// ====================================================================
// App
// ====================================================================

export function App() {
  const [examples, setExamples] = useState<AutomationSummary[]>([]);
  const [savedScripts, setSavedScripts] = useState<SavedScript[]>([]);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const logIdRef = useRef(0);

  const [json, setJson] = useState('');
  const [outputs, setOutputs] = useState<Record<string, string> | null>(null);
  const [running, setRunning] = useState(false);
  const [savePromptOpen, setSavePromptOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const saveInputRef = useRef<HTMLInputElement>(null);

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

  // ---- load saved scripts + watch for changes ----
  useEffect(() => {
    loadSavedScripts().then(setSavedScripts).catch(() => {});
    if (!storageAvailable() || !chrome.storage.onChanged) return;
    const listener = (
      changes: { [key: string]: chrome.storage.StorageChange },
      area: string,
    ) => {
      if (area === 'local' && changes[STORAGE_KEY]) {
        const next = changes[STORAGE_KEY].newValue;
        setSavedScripts(Array.isArray(next) ? (next as SavedScript[]) : []);
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  // ---- focus save input when prompt opens ----
  useEffect(() => {
    if (savePromptOpen) {
      saveInputRef.current?.focus();
      saveInputRef.current?.select();
    }
  }, [savePromptOpen]);

  const clearLog = useCallback(() => setLogs([]), []);

  const sortedSaved = useMemo(
    () => [...savedScripts].sort((a, b) => a.name.localeCompare(b.name)),
    [savedScripts],
  );

  // ---- dropdown insert ----
  const insertFromDropdown = useCallback(
    (value: string) => {
      // value format: "example:<id>" or "saved:<id>"
      const [kind, id] = value.split(':', 2);
      if (kind === 'example') {
        const ex = examples.find((e) => e.id === id);
        if (ex) setJson(ex.source);
      } else if (kind === 'saved') {
        const s = savedScripts.find((x) => x.id === id);
        if (s) setJson(s.source);
      }
    },
    [examples, savedScripts],
  );

  // ---- run ----
  const run = useCallback(async () => {
    const trimmed = json.trim();
    if (!trimmed) {
      appendLog('error', 'Editor is empty.');
      return;
    }
    setRunning(true);
    setOutputs(null);
    appendLog('info', '▶ Run');
    try {
      const win = await chrome.windows.getCurrent();
      const res = await chrome.runtime.sendMessage({
        type: 'runJson',
        json: trimmed,
        windowId: win.id,
      });
      if (!res?.ok) {
        appendLog('error', res?.error ?? 'Unknown failure');
        return;
      }
      const got = res.outputs as Record<string, string> | undefined;
      if (got && Object.keys(got).length > 0) setOutputs(got);
    } catch (err) {
      appendLog('error', (err as Error).message);
    } finally {
      setRunning(false);
    }
  }, [json, appendLog]);

  // ---- save core: write a SavedScript under the given name ----
  const persistSave = useCallback(
    async (name: string) => {
      const source = json;
      const now = Date.now();
      const existing = savedScripts.find(
        (s) => s.name.toLowerCase() === name.toLowerCase(),
      );
      let next: SavedScript[];
      if (existing) {
        const overwrite = window.confirm(
          `A script named "${existing.name}" already exists.\n\nOK to overwrite, Cancel to save as a new copy.`,
        );
        if (overwrite) {
          next = savedScripts.map((s) =>
            s.id === existing.id ? { ...s, source, updatedAt: now } : s,
          );
          appendLog('success', `Saved "${existing.name}" (overwritten).`);
        } else {
          const copyName = uniqueName(name, savedScripts);
          next = savedScripts.concat({
            id: newId(),
            name: copyName,
            source,
            createdAt: now,
            updatedAt: now,
          });
          appendLog('success', `Saved as "${copyName}".`);
        }
      } else {
        next = savedScripts.concat({
          id: newId(),
          name,
          source,
          createdAt: now,
          updatedAt: now,
        });
        appendLog('success', `Saved as "${name}".`);
      }
      try {
        await writeSavedScripts(next);
        setSavedScripts(next);
      } catch (err) {
        appendLog('error', (err as Error).message);
      }
    },
    [json, savedScripts, appendLog],
  );

  // ---- save entry point: auto-pick name from JSON, else open inline input ----
  const handleSave = useCallback(() => {
    const trimmed = json.trim();
    if (!trimmed) {
      appendLog('error', 'Nothing to save — editor is empty.');
      return;
    }
    const auto = tryExtractName(trimmed);
    if (auto) {
      void persistSave(auto);
      return;
    }
    setSaveName('');
    setSavePromptOpen(true);
  }, [json, appendLog, persistSave]);

  const closeSavePrompt = useCallback(() => {
    setSavePromptOpen(false);
    setSaveName('');
  }, []);

  const commitSave = useCallback(async () => {
    const name = saveName.trim();
    if (!name) return;
    await persistSave(name);
    closeSavePrompt();
  }, [saveName, persistSave, closeSavePrompt]);

  return (
    <main className="app">
      <header>
        <h1>Automation Engine</h1>
        <p className="subtitle">JSON-driven · chrome.debugger / CDP</p>
      </header>

      <section className="editor-section">
        <div className="pane-toolbar">
          <select
            className="examples"
            value=""
            onChange={(e) => {
              const v = e.target.value;
              if (v) insertFromDropdown(v);
              e.target.value = '';
            }}
          >
            <option value="">Insert script…</option>
            {examples.length > 0 && (
              <optgroup label="Examples">
                {examples.map((ex) => (
                  <option key={ex.id} value={`example:${ex.id}`}>
                    {ex.name}
                  </option>
                ))}
              </optgroup>
            )}
            {sortedSaved.length > 0 && (
              <optgroup label="My scripts">
                {sortedSaved.map((s) => (
                  <option key={s.id} value={`saved:${s.id}`}>
                    {s.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>

        <textarea
          className="json-editor"
          spellCheck={false}
          autoComplete="off"
          placeholder={EDITOR_PLACEHOLDER}
          value={json}
          onChange={(e) => setJson(e.target.value)}
        />

        <div className="pane-footer">
          <button type="button" className="run" disabled={running} onClick={run}>
            {running ? 'Running…' : 'Run'}
          </button>
          <button
            type="button"
            className="save-btn"
            onClick={handleSave}
            disabled={savePromptOpen}
          >
            Save
          </button>
        </div>
        <p className="hint">{EDITOR_HINT}</p>

        {savePromptOpen && (
          <div className="save-prompt">
            <input
              ref={saveInputRef}
              type="text"
              className="save-name"
              placeholder="Name this script"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void commitSave();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  closeSavePrompt();
                }
              }}
            />
            <button
              type="button"
              className="run save-confirm"
              disabled={!saveName.trim()}
              onClick={() => void commitSave()}
            >
              Save
            </button>
            <button type="button" className="ghost" onClick={closeSavePrompt}>
              Cancel
            </button>
          </div>
        )}

        {outputs && Object.keys(outputs).length > 0 && (
          <pre className="outputs prominent">
            {Object.entries(outputs)
              .map(([k, v]) => `${k}: ${v === '' ? '(empty)' : v}`)
              .join('\n')}
          </pre>
        )}
      </section>

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
        <a
          className="docs-link"
          href="https://github.com/mjahmed-wd/automation-engine/blob/main/README.md"
          target="_blank"
          rel="noopener noreferrer"
        >
          Documentation ↗
        </a>
      </footer>
    </main>
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

// ====================================================================
// helpers
// ====================================================================

function uniqueName(base: string, scripts: SavedScript[]): string {
  const taken = new Set(scripts.map((s) => s.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base} (${i})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} (${Date.now()})`;
}
