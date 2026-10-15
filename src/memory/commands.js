import pc from 'picocolors';
import { KINDS, MemoryError, all, get, remove, save } from './store.js';

const when = (iso) =>
  new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export function list(i, fail) {
  if (i.kind && !KINDS[i.kind]) return fail(`--kind is one of: ${Object.keys(KINDS).join(', ')}.`);
  const memories = all({ kind: i.kind });
  if (!memories.length)
    return { text: i.kind ? `Nothing of kind "${i.kind}" is remembered.` : 'The agent has no saved memories.', data: { memories: [] } };
  const text = [
    ...memories.flatMap((m) => [`${pc.bold(m.name)}  ${pc.dim(`${m.kind} · ${when(m.saved)}`)}`, `  ${m.text.split('\n').join('\n  ')}`]),
    pc.dim(`\n${memories.length} memor${memories.length === 1 ? 'y' : 'ies'} · remove one with: bc memory remove <name>`),
  ].join('\n');
  return { text, data: { memories } };
}

export function show(i, fail) {
  const m = get(i.name);
  if (!m) return fail(`No memory called "${i.name}". See: bc memory list`);
  return {
    text: `${pc.bold(m.name)}  ${pc.dim(`${m.kind} · ${m.summary}`)}\n${pc.dim(`saved ${when(m.saved)}, first ${when(m.since)}`)}\n\n${m.text}`,
    data: m,
  };
}

export function saveOne(i, fail, caller) {
  let r;
  try {
    r = save({
      name: i.name,
      kind: i.kind,
      summary: i.summary,
      text: i.text,
      append: !!i.append,
      by: caller === 'agent' ? 'agent' : 'owner',
    });
  } catch (e) {
    if (e instanceof MemoryError) return fail(e.message);
    throw e;
  }
  return {
    text: `${r.created ? 'Remembered' : 'Changed'}: ${r.memory.name} (${r.memory.kind}).`,
    data: { ...r.memory, created: r.created },
  };
}

export function removeOne(i, fail) {
  const was = remove(i.name);
  if (!was) return fail(`No memory called "${i.name}". See: bc memory list`);
  return { text: `Forgot "${was.name}".`, data: { removed: was.name } };
}
