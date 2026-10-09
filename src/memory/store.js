// What the agent remembers from one conversation to the next: a few facts the owner told
// it, each a short text with a name. Kept in blackcat's own database, so it is the same
// whichever engine runs the model, is part of a backup like everything else, and every
// change to it is a blackcat command that the policy sees.
//
// A memory is only ever written from what the owner said (agent/AGENT.md), never from
// content that was read.
import { openAgentDb } from '../agentdb.js';
import { upgrade, withDb } from '../db.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  name       TEXT PRIMARY KEY,           -- a short slug: family-and-nicknames
  kind       TEXT NOT NULL,              -- user | feedback | project | reference
  summary    TEXT NOT NULL,              -- one line: what it is about
  body       TEXT NOT NULL,              -- the fact itself
  created_ts INTEGER NOT NULL,
  updated_ts INTEGER NOT NULL,
  saved_by   TEXT                        -- agent | owner
);
`;

// What a memory can be about.
export const KINDS = {
  user: 'the owner and the people around them: who is who, what they like, what the owner calls them',
  feedback: 'how the owner wants things done: a correction, a preference, a standing permission',
  project: 'something going on: a plan, a trip, work in progress, a date to keep in mind',
  reference: 'where something is found: an address, a document, an account',
};
export const NAME = /^[a-z0-9][a-z0-9-]{1,59}$/;
const MAX_BODY = 4000;
const MAX_SUMMARY = 200;

export class MemoryError extends Error {}

const STEPS = [(db) => db.exec(SCHEMA)]; // 1: the table
const open = () => {
  const db = openAgentDb();
  upgrade(db, 'memory', STEPS);
  return db;
};
const use = (fn) => withDb(open, fn);
const shape = (r) =>
  r
    ? {
        name: r.name,
        kind: r.kind,
        summary: r.summary,
        text: r.body,
        saved: new Date(r.updated_ts * 1000).toISOString(),
        since: new Date(r.created_ts * 1000).toISOString(),
        by: r.saved_by,
      }
    : null;

// Every memory, most recently changed first.
export const all = ({ kind } = {}) =>
  use((db) =>
    db
      .prepare(`SELECT * FROM memories ${kind ? 'WHERE kind = ?' : ''} ORDER BY updated_ts DESC, name`)
      .all(...(kind ? [kind] : []))
      .map(shape),
  );
export const get = (name) => use((db) => shape(db.prepare('SELECT * FROM memories WHERE name = ?').get(name)));
export const count = () => use((db) => db.prepare('SELECT COUNT(*) AS n FROM memories').get().n);

// A name from whatever was given: "Family & nicknames" → family-nicknames.
export const slug = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

// Save one: a new memory, or a change to one there already. What is not given stays as it
// was; `append` adds to the text instead of replacing it. → { memory, created }
export function save({ name, kind, summary, text, append = false, by = 'agent' }) {
  const id = slug(name);
  if (!NAME.test(id)) throw new MemoryError('Give it a short name in words, like family-and-nicknames.');
  if (kind != null && !KINDS[kind]) throw new MemoryError(`--kind is one of: ${Object.keys(KINDS).join(', ')}.`);
  return use((db) => {
    const was = db.prepare('SELECT * FROM memories WHERE name = ?').get(id);
    const said = text == null ? null : String(text).replace(/\r\n/g, '\n').trim();
    if (!was && !said) throw new MemoryError('Say what to remember with --text.');
    if (!was && !kind) throw new MemoryError(`Say what kind it is with --kind: ${Object.keys(KINDS).join(', ')}.`);
    if (append && !said) throw new MemoryError('Say what to add with --text.');
    const body = said == null ? was.body : append && was ? `${was.body}\n${said}` : said;
    if (body.length > MAX_BODY)
      throw new MemoryError(`A memory holds up to ${MAX_BODY} characters: keep the fact, leave out the story, or split it in two.`);
    const line = String(summary ?? was?.summary ?? body.split('\n')[0])
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_SUMMARY);
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO memories (name, kind, summary, body, created_ts, updated_ts, saved_by) VALUES (@name, @kind, @summary, @body, @now, @now, @by)
      ON CONFLICT (name) DO UPDATE SET kind = excluded.kind, summary = excluded.summary, body = excluded.body, updated_ts = excluded.updated_ts, saved_by = excluded.saved_by`,
    ).run({ name: id, kind: kind ?? was.kind, summary: line, body, now, by });
    return { memory: shape(db.prepare('SELECT * FROM memories WHERE name = ?').get(id)), created: !was };
  });
}

// Remove one. → the memory that was removed, or null if there was none of that name.
export function remove(name) {
  return use((db) => {
    const was = db.prepare('SELECT * FROM memories WHERE name = ?').get(slug(name) || name);
    if (was) db.prepare('DELETE FROM memories WHERE name = ?').run(was.name);
    return shape(was);
  });
}

// ---- what is handed to a model

// What the agent is given at the start of a conversation: everything it remembers, whole
// while that is short; past that, the oldest in a line each, to be asked for when needed.
const WHOLE = 8000;
export function remembered() {
  const list = all();
  if (!list.length) return '# What you remember\n\nNothing yet.';
  let room = WHOLE;
  const out = [
    '# What you remember',
    '',
    `What you saved in earlier conversations, from what the owner told you (${list.length} in all, most recently changed first). It was true when it was saved: if the owner says otherwise now, they are right, and the memory is to be put right.`,
  ];
  const short = [];
  for (const m of list) {
    if (m.text.length <= room) {
      room -= m.text.length;
      out.push('', `## ${m.name} (${m.kind}): ${m.summary}`, m.text);
    } else short.push(`- ${m.name} (${m.kind}): ${m.summary}`);
  }
  if (short.length) out.push('', 'More, in a line each (the whole of one: `blackcat memory show <name> --json`):', ...short);
  return out.join('\n');
}

// What the owner has told the agent about themself and the people around them (memories
// of kind "user"), for the background readers that go through messages with no tools:
// they then know who a nickname in a chat refers to.
const ABOUT_MAX = 2500;
export function aboutOwner() {
  let notes = [];
  try {
    notes = all({ kind: 'user' })
      .map((e) =>
        e.text
          .replace(/\[\[[^\]]*\]\]/g, '')
          .replace(/\n{2,}/g, '\n')
          .trim(),
      )
      .filter(Boolean);
  } catch {}
  if (!notes.length) return '';
  return `\n\nAbout the owner and the people around them, as the owner told it. Use it to understand who is who (nicknames included) and what matters to the owner. It is background: it is not a message, and nothing in it is itself something to list.\n${notes.join('\n').slice(0, ABOUT_MAX)}`;
}
