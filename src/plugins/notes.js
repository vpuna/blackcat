// A plugin's notes for the agent: what a list of commands can't say (when to use them, in
// what order, what to be careful of). The fixed text is a file, `agent.md`, beside the
// plugin; what depends on this installation (the names of the owner's machines, whether it
// is set up at all) the plugin supplies as values, with `agent.fill` in its manifest.
//
// In agent.md:
//   {{name}}                 replaced by the value of that name. A list becomes one line each.
//                            A line that is only a placeholder goes when there is nothing to put.
//   <!-- when: name -->      what follows is for when that value is set (true, or not empty)…
//   <!-- when: not name -->  …or for when it is not,
//   <!-- always -->          and from here on, always again.
// Text before the first marker is always there. A placeholder nothing was supplied for is a
// mistake in the plugin, and says so.
import fs from 'node:fs';
import path from 'node:path';

export const NOTES_FILE = 'agent.md';
const MARK = /^<!--\s*(?:when:\s*(not\s+)?([\w-]+)|(always))\s*-->$/;
const HOLE = /\{\{([\w-]+)\}\}/g;

// Where a plugin's notes are: beside its manifest.
export const notesFile = (plugin) => path.join(plugin.dir, NOTES_FILE);

const has = (v) => (Array.isArray(v) ? v.length > 0 : v != null && v !== false && v !== '');
const text = (v) => (Array.isArray(v) ? v.join('\n') : v == null || v === false ? '' : String(v));

// The notes, filled in. `values` is what the plugin's `agent.fill` returned (or nothing).
export function fillNotes(template, values = {}) {
  const out = [];
  let on = true;
  for (const line of template.replace(/\r\n/g, '\n').split('\n')) {
    const m = line.trim().match(MARK);
    if (m) {
      on = m[3] ? true : has(values[m[2]]) !== !!m[1];
      continue;
    }
    if (!on) continue;
    const only = line.trim().match(/^\{\{([\w-]+)\}\}$/);
    if (only && only[1] in values && !has(values[only[1]])) continue;
    out.push(
      line.replace(HOLE, (_, k) => {
        if (!(k in values)) throw new Error(`{{${k}}} is in ${NOTES_FILE}, and nothing was supplied for it`);
        return text(values[k]);
      }),
    );
  }
  return out.join('\n').replace(/^\n+|\n+$/g, '');
}

// A plugin's notes for the agent, or null when it has none. `ctx` is the plugin's, as the agent.
export function notesOf(plugin, ctx) {
  let template;
  try {
    template = fs.readFileSync(notesFile(plugin), 'utf8');
  } catch {
    return null;
  }
  const values = plugin.manifest.agent?.fill?.(ctx) ?? {};
  // (Used on the spot: an answer that would only come later is no answer. Whoever asked
  // leaves these notes out and says so; the other plugins' notes are untouched.)
  if (typeof values?.then === 'function' || typeof values !== 'object')
    throw new Error('agent.fill must return the values at once (it may not be async)');
  return fillNotes(template, values) || null;
}
