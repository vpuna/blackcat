// Simple commands learned from the agent. When the owner's words led the agent to do one simple
// thing and nothing else (a light switched, a shortcut run: what a plugin's `chat.learn` says it
// can be asked for in words of its quick route), the words are kept with what was done. The same
// words next time, a small typo apart, go to that plugin's quick route without the agent.
// Nothing is learned from a turn that asked the owner, failed, or did more than look besides.
// What a learned wording does is the quick route's own: it asks first where that asks.
//   chat.learn(command, tokens, { ctx }) → (a promise of) words its quick route takes | 'look' (changes
//   nothing: the turn may still be learned) | null (not something to learn)
import { AGENT_DB } from '../agentdb.js';
import { openSqlite, upgrade, withDb } from '../db.js';
import { log } from '../log.js';
import { pluginAccess } from '../plugins/access.js';
import { loaded, makeCtx } from '../plugins/registry.js';
import { now } from '../util/time.js';
import { chatHooks } from './hooks.js';

const STEPS = [
  (db) =>
    db.exec(
      'CREATE TABLE learned (wording TEXT PRIMARY KEY, plugin TEXT NOT NULL, words TEXT NOT NULL, made INTEGER NOT NULL, used INTEGER, uses INTEGER NOT NULL DEFAULT 0)',
    ),
];
const use = (fn) =>
  withDb(() => {
    const db = openSqlite(AGENT_DB);
    upgrade(db, 'learned', STEPS);
    return db;
  }, fn);

// Words that change nothing of what is asked. ("on", "off" and "not" are never among them.)
const FILLER = new Set(
  'hey hi ok okay please kindly can could would will you blackcat black cat bc the a an my our for me now just thanks thank'.split(' '),
);
// The owner's words as they are kept and looked up: "Can you turn ON the kitchen light?" is
// "turn on kitchen light". → null for what is too long to be a simple command.
export function wording(text) {
  const w = String(text ?? '')
    .toLowerCase()
    .replace(/n['’]t\b/g, ' not')
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .split(/\s+/)
    .filter((x) => x && !FILLER.has(x));
  return w.length && w.length <= 10 ? w.join(' ') : null;
}

// One letter added, left out, changed or two swapped.
function oneOff(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  if (i === a.length && i === b.length) return true;
  const rest = (x, y) => a.slice(x) === b.slice(y);
  return rest(i + 1, i + 1) || rest(i + 1, i) || rest(i, i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && rest(i + 2, i + 2));
}

// After a turn of the agent's (brain.js afterTurn).
export async function learnFrom({ said, ran }) {
  const key = said && String(said).length <= 120 ? wording(said) : null;
  if (!key) return;
  let found = null;
  for (const r of ran) {
    // (Only what was simply allowed: not what the owner was asked about, nor refused or failed.)
    if (r.failed || r.tool !== 'Bash' || r.decision !== 'allowed') return;
    const pa = pluginAccess(String(r.command ?? ''));
    const learn = pa?.command && chatHooks(pa.plugin).learn;
    if (!learn) return;
    const got = await learn(pa.command, pa.tokens, { ctx: makeCtx(pa.plugin, { caller: 'owner', surface: 'chat' }) });
    if (got === 'look') continue;
    if (!got || found) return; // something else, or a second thing done
    found = { plugin: pa.plugin.name, words: got };
  }
  if (!found) return;
  use((db) =>
    db
      .prepare(
        `INSERT INTO learned (wording, plugin, words, made) VALUES (?, ?, ?, ?)
         ON CONFLICT (wording) DO UPDATE SET plugin = excluded.plugin, words = excluded.words, made = excluded.made`,
      )
      .run(key, found.plugin, found.words, now()),
  );
  log(`learned: "${key}" is ${found.plugin} "${found.words}"`);
}

// The learned wording these words are, the same or a small typo apart (in a word of four letters
// or more, so that "on" is never "off"); null when none is, or more than one might be.
export function recall(text) {
  const key = wording(text);
  if (!key) return null;
  const rows = use((db) => db.prepare('SELECT rowid AS id, * FROM learned').all());
  const exact = rows.find((r) => r.wording === key);
  if (exact) return exact;
  const said = key.split(' ');
  const near = rows.filter((r) => {
    const w = r.wording.split(' ');
    return w.length === said.length && w.every((x, i) => x === said[i] || (x.length >= 4 && said[i].length >= 4 && oneOff(x, said[i])));
  });
  return near.length === 1 ? near[0] : null;
}

export const usedOnce = (id) => use((db) => db.prepare('UPDATE learned SET uses = uses + 1, used = ? WHERE rowid = ?').run(now(), id));
export const forget = (id) => use((db) => db.prepare('DELETE FROM learned WHERE rowid = ?').run(id).changes > 0);
export const listLearned = () => use((db) => db.prepare('SELECT rowid AS id, * FROM learned ORDER BY made DESC').all());

// The plugin a learned wording goes to, while it is still there and still has a quick route.
export const pluginOf = (l) => loaded().find((p) => p.name === l.plugin && chatHooks(p).quick) ?? null;
