/**
 * Loader — bundles every JSON file in `automations/` at build time via Vite's
 * `import.meta.glob` and exposes lookup helpers.
 */

import type { AutomationScript, AutomationTag } from './schema';

const modules = import.meta.glob<AutomationScript>('../../automations/*.json', {
  eager: true,
  import: 'default',
});

const automations: Record<string, AutomationScript> = {};
for (const [path, mod] of Object.entries(modules)) {
  const id = path.split('/').pop()!.replace(/\.json$/, '');
  automations[id] = mod;
}

export interface AutomationSummary {
  id: string;
  name: string;
  description?: string;
  tag: AutomationTag;
  variables: Record<string, string>;
  steps: number;
  /** The JSON source as it would appear in the textarea (pretty-printed). */
  source: string;
}

function inferTag(script: AutomationScript): AutomationTag {
  if (script.tag) return script.tag;
  const sideEffects = new Set(['goto', 'fill', 'click']);
  return script.steps.some((s) => sideEffects.has(s.action)) ? 'action' : 'get';
}

export function listAutomations(): AutomationSummary[] {
  return Object.entries(automations).map(([id, script]) => ({
    id,
    name: script.name,
    description: script.description,
    tag: inferTag(script),
    variables: script.variables ?? {},
    steps: script.steps.length,
    source: JSON.stringify(script, null, 2),
  }));
}

export function getAutomation(id: string): AutomationScript | undefined {
  return automations[id];
}
