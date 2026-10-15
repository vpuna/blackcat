// What blackcat did, and what it cost: every call to the model (with its tokens, model and
// time), every command the agent ran (with how it was allowed and how it ended), scheduled
// work that did something, and anything else worth noting. One table of entries, plus
// running totals per day that are kept long after the entries themselves are gone.
//
// What is never recorded: what was said. Not your messages, not the agent's replies, not what
// a search returned. An entry says that a chat turn happened, what it ran and what it used.
//
// Recording must never get in the way of the thing being recorded: record() does not throw.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { load } from '../config.js';
import { getMeta, openAgentDb, setMeta } from '../agentdb.js';
import { upgrade, withDb } from '../db.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS activity (
  id          INTEGER PRIMARY KEY,
  ts          INTEGER NOT NULL,
  kind        TEXT NOT NULL,              -- model | command | job | event
  category    TEXT NOT NULL DEFAULT '',   -- chat, "watch: School notices", "blackcat msg", "mail/sync", …
  surface     TEXT,                       -- chat | terminal | job
  ok          INTEGER NOT NULL DEFAULT 1,
  ms          INTEGER,                    -- how long it took
  model       TEXT,
  tokens_in   INTEGER,                    -- input sent fresh
  tokens_out  INTEGER,
  cache_read  INTEGER,                    -- input reused from an earlier call (cheap)
  cache_write INTEGER,                    -- input stored for reuse
  cost        REAL,                       -- US dollars at list price
  turn_id     INTEGER,                    -- the conversation turn it was part of, if any
  summary     TEXT,                       -- one line a person can read
  data        TEXT                        -- JSON: whatever else is known about this kind of entry
);
CREATE INDEX IF NOT EXISTS activity_ts ON activity (ts);
CREATE INDEX IF NOT EXISTS activity_kind ON activity (kind, ts);
CREATE TABLE IF NOT EXISTS activity_daily (
  day TEXT NOT NULL, kind TEXT NOT NULL, category TEXT NOT NULL, model TEXT NOT NULL DEFAULT '',
  n INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, ms INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind, category, model)
);
`;

// model: a call to the model · command: something the agent ran · job: scheduled work
// event: something that happened · owner: something the owner did directly (a tap, a typed
// command, a change to how blackcat is set up) · sent: something blackcat sent the owner unasked
export const KINDS = ['model', 'command', 'job', 'event', 'owner', 'sent'];
// on: record at all · days: how long entries are kept · totalsDays: how long the daily totals are kept
// commands: how much of a command the agent ran is kept: auto | full | short | off
// cost: show the dollar figure (it is the list price, not what a subscription charges)
export const DEFAULTS = { on: true, days: 30, totalsDays: 365, commands: 'auto', cost: true };
export const settings = () => ({ ...DEFAULTS, ...load().activity });

// Who set it off, and which piece of work it was part of. The daily totals are kept apart
// by who, and remember the slowest of what they count.
const WORK = `
ALTER TABLE activity ADD COLUMN who TEXT;                        -- owner | agent | dev | blackcat (nothing: from before this was kept)
ALTER TABLE activity ADD COLUMN work TEXT;                       -- the piece of work it was part of
ALTER TABLE activity ADD COLUMN lead INTEGER NOT NULL DEFAULT 0; -- 1: the entry that stands for the whole piece of work
CREATE INDEX activity_work ON activity (work);
CREATE TABLE activity_daily_new (
  day TEXT NOT NULL, kind TEXT NOT NULL, category TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', who TEXT NOT NULL DEFAULT '',
  n INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, ms INTEGER NOT NULL DEFAULT 0, slowest INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind, category, model, who)
);
INSERT INTO activity_daily_new (day, kind, category, model, n, failed, ms, tokens_in, tokens_out, cache_read, cache_write, cost)
  SELECT day, kind, category, model, n, failed, ms, tokens_in, tokens_out, cache_read, cache_write, cost FROM activity_daily;
DROP TABLE activity_daily;
ALTER TABLE activity_daily_new RENAME TO activity_daily;
`;
const STEPS = [(db) => db.exec(SCHEMA), (db) => db.exec(WORK)];

// ---- who, and which piece of work ----
//
// Everything blackcat does is a piece of work with an id: a chat turn, a look by a watch,
// a scheduled job, a command at a terminal. Every entry made while it goes on carries the
// id, so the whole of it can be read back in order, with where its time went.
//
// Who set it off:
//   owner     the owner, in the chat or at a terminal
//   agent     the agent, by a command it ran
//   blackcat  blackcat itself: a schedule, a message arriving, a service
//   dev       a developer session: a command typed by a coding assistant working on
//             blackcat (Claude Code marks the commands it runs). On the record like
//             everything else, and left out of what is shown unless asked for.
// What the agent runs is the agent's, whatever else its environment says: its engine may
// be the same program a developer session is.
export const WHO = ['owner', 'agent', 'blackcat', 'dev'];
export function processWho(env = process.env) {
  if (env.BLACKCAT_CALLER === 'agent') return 'agent';
  if (env.BLACKCAT_JOB || env.BLACKCAT_SERVICE) return 'blackcat';
  return env.CLAUDECODE ? 'dev' : 'owner';
}
const current = new AsyncLocalStorage();
export const newWork = () => `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
// The agent's commands are started by its engine, which was given its environment once,
// when the conversation began: the turn they belong to is looked up, by the chat.
const turnKey = (chat) => `activity_turn:${chat ?? 'terminal'}`;
export function turnWork(chat, id, who) {
  try {
    withDb(openAgentDb, (db) => setMeta(db, turnKey(chat), id ? `${id} ${who ?? ''}` : ''));
  } catch {}
}
let ofTurnNow;
function agentTurn() {
  if (ofTurnNow !== undefined) return ofTurnNow;
  ofTurnNow = { id: null, who: null };
  try {
    const [id, who] = String(withDb(openAgentDb, (db) => getMeta(db, turnKey(process.env.BLACKCAT_CHAT_ID))) ?? '').split(' ');
    ofTurnNow = { id: id || null, who: who || null };
  } catch {}
  return ofTurnNow;
}
export const workNow = () =>
  current.getStore()?.id ?? (process.env.BLACKCAT_WORK || (process.env.BLACKCAT_CALLER === 'agent' ? agentTurn().id : null));
// (In a service, what the owner set off is the owner's: a tap, a message. A developer
// session stays one whatever it does.)
// What the agent runs in a turn of a developer session's chat is part of that session.
export function whoNow() {
  const p = processWho();
  if (p === 'agent') return agentTurn().who === 'dev' ? 'dev' : 'agent';
  return p === 'dev' ? p : (current.getStore()?.who ?? p);
}

// Do a piece of work. Everything recorded while `fn` runs carries its id, and when it is
// over one entry stands for the whole: what it was, how long it took, how it ended.
//   what    { kind, category, summary, surface, who, data }
//   fn      may return came({ did, data, ok, idle }) to say what came of it; `idle` (nothing
//           to do) is counted and not listed. Whatever it returns is handed back as it is.
// Inside another piece of work it is a part of that one, and has no id of its own.
const CAME = Symbol('what came of it');
export const came = (said) => ({ ...said, [CAME]: true });
export async function work(what, fn) {
  const outer = current.getStore();
  // (Inside other work, in this process or the one that started it, it is a part of that.)
  const part = !!outer || !!workNow();
  const id = outer?.id ?? workNow() ?? newWork();
  const who = what.who ?? outer?.who;
  const t0 = Date.now();
  const end = (r, ok, extra) => {
    const said = r?.[CAME] ? r : {};
    record({
      ...what,
      who,
      work: id,
      lead: !part,
      ok: said.ok === false ? false : ok,
      ms: Date.now() - t0,
      summary: said.did ?? what.summary ?? (extra?.error ? `failed: ${extra.error}` : null),
      data: { ...(typeof what.data === 'function' ? what.data() : what.data), ...said.data, ...extra },
      countOnly: said.idle === true,
    });
  };
  return current.run({ id, who }, async () => {
    try {
      const r = await fn(id);
      end(r, true);
      return r;
    } catch (e) {
      end(null, false, { error: whyShort(e) });
      throw e;
    }
  });
}
// Work handed to another process to do (a request left for a service): who asked, to be
// kept with the request, and what the one doing it wraps the work in.
export const askedBy = () => ({ work: workNow() ?? newWork(), who: whoNow() });
export const asAsked = (by, fn) => (by?.work ? current.run({ id: by.work, who: WHO.includes(by.who) ? by.who : undefined }, fn) : fn());
export function openActivityDb() {
  const db = openAgentDb();
  upgrade(db, 'activity', STEPS, { base: 2, owns: ['activity'] });
  return db;
}
const dayOf = (ts) => {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
// (Nothing given is nothing known, not zero.)
const num = (x) => (x != null && x !== '' && Number.isFinite(Number(x)) ? Number(x) : null);
// The extra details of an entry, as JSON. Too much of it is dropped rather than cut in half.
function tidyData(data) {
  if (!data || !Object.keys(data).length) return null;
  const text = JSON.stringify(data);
  return text.length <= 4000 ? text : JSON.stringify({ note: 'details too large to keep' });
}

// Add an entry. `countOnly` adds to the day's totals without keeping an entry (a scheduled
// run that found nothing to do: there are hundreds a day). → the entry's id, or null.
export function record(entry) {
  try {
    const s = settings();
    if (!s.on || !KINDS.includes(entry?.kind)) return null;
    if (entry.kind === 'command' && s.commands === 'off') return null;
    const ts = Math.floor(entry.ts ?? Date.now() / 1000);
    const row = {
      ts,
      kind: entry.kind,
      category: String(entry.category ?? '').slice(0, 80),
      surface: entry.surface ?? null,
      ok: entry.ok === false ? 0 : 1,
      ms: num(entry.ms) == null ? null : Math.round(num(entry.ms)),
      model: entry.model ?? null,
      turn_id: num(entry.turnId),
      tokens_in: num(entry.tokensIn),
      tokens_out: num(entry.tokensOut),
      cache_read: num(entry.cacheRead),
      cache_write: num(entry.cacheWrite),
      cost: entry.cost == null ? null : num(entry.cost), // not known (an engine that reports no price) is not the same as nothing
      summary: entry.summary == null ? null : String(entry.summary).replace(/\s+/g, ' ').slice(0, 400),
      data: tidyData(entry.data),
      who: WHO.includes(entry.who) && processWho() !== 'dev' && processWho() !== 'agent' ? entry.who : whoNow(),
      work: entry.work ?? workNow(),
      lead: entry.lead ? 1 : 0,
    };
    // Something that happened by itself (a reminder sent, a service connecting) is a piece of work of its own.
    if (!row.work) Object.assign(row, { work: newWork(), lead: 1 });
    return withDb(openActivityDb, (db) => {
      let id = null;
      db.transaction(() => {
        if (!entry.countOnly) {
          id = Number(
            db
              .prepare(
                `INSERT INTO activity (ts, kind, category, surface, ok, ms, model, tokens_in, tokens_out, cache_read, cache_write, cost, turn_id, summary, data, who, work, lead)
            VALUES (@ts, @kind, @category, @surface, @ok, @ms, @model, @tokens_in, @tokens_out, @cache_read, @cache_write, @cost, @turn_id, @summary, @data, @who, @work, @lead)`,
              )
              .run(row).lastInsertRowid,
          );
        }
        db.prepare(
          `INSERT INTO activity_daily (day, kind, category, model, who, n, failed, ms, slowest, tokens_in, tokens_out, cache_read, cache_write, cost)
          VALUES (@day, @kind, @category, @model, @who, @n, @failed, @ms, @ms, @tokens_in, @tokens_out, @cache_read, @cache_write, @cost)
          ON CONFLICT (day, kind, category, model, who) DO UPDATE SET n = n + excluded.n, failed = failed + excluded.failed, ms = ms + excluded.ms,
            slowest = MAX(slowest, excluded.slowest),
            tokens_in = tokens_in + excluded.tokens_in, tokens_out = tokens_out + excluded.tokens_out,
            cache_read = cache_read + excluded.cache_read, cache_write = cache_write + excluded.cache_write, cost = cost + excluded.cost`,
        ).run({
          day: dayOf(ts),
          kind: row.kind,
          category: row.category,
          model: row.model ?? '',
          who: row.who ?? '',
          n: entry.countOnly && num(entry.count) > 0 ? Math.round(num(entry.count)) : 1, // (several of the same, counted at once)
          failed: row.ok ? 0 : 1,
          ms: row.ms ?? 0,
          tokens_in: row.tokens_in ?? 0,
          tokens_out: row.tokens_out ?? 0,
          cache_read: row.cache_read ?? 0,
          cache_write: row.cache_write ?? 0,
          cost: row.cost ?? 0,
        });
        // Once a day, let go of what is past its keeping time.
        const today = dayOf(Math.floor(Date.now() / 1000));
        if (getMeta(db, 'activity_pruned') !== today) {
          db.prepare('DELETE FROM activity WHERE ts < ?').run(Math.floor(Date.now() / 1000) - s.days * 86400);
          db.prepare('DELETE FROM activity_daily WHERE day < ?').run(dayOf(Math.floor(Date.now() / 1000) - s.totalsDays * 86400));
          setMeta(db, 'activity_pruned', today);
        }
      })();
      return id;
    });
  } catch {
    return null;
  }
}

// A command, as it is kept. In full when asked for, or when it is one that matters to look
// back on (it needed your say, was refused, or failed). Otherwise only what was run, not
// with what: `blackcat msg find 'who did not go' --since 30d` → "blackcat msg find … --since".
// (What you asked for is often in a command's arguments, and that is not kept.)
export function commandText(command, { full = false } = {}) {
  const text = String(command ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const mode = settings().commands;
  if (mode === 'full' || (mode === 'auto' && full)) return text.slice(0, 400);
  const words = text.split(' ');
  if (words[0] !== 'blackcat' && words[0] !== 'bc') return `${words[0].split('/').at(-1)}${words.length > 1 ? ' …' : ''}`;
  const head = ['blackcat'];
  let i = 1;
  for (; i < words.length && head.length < 4 && /^[a-z][a-z0-9-]*$/.test(words[i]); i++) head.push(words[i]);
  const flags = [...new Set(words.slice(i).filter((w) => /^--?[a-z][\w-]*$/.test(w)))];
  return [...head, ...(words.length > i + flags.length ? ['…'] : []), ...flags].join(' ');
}
// What kind of command it was, for totals: "blackcat msg", "ssh", "read a file".
export function commandCategory(tool, input) {
  if (tool !== 'Bash')
    return (
      { Read: 'read a file', Write: 'write a file', Edit: 'edit a file', Glob: 'look for files', Grep: 'search in files' }[tool] ??
      String(tool).toLowerCase()
    );
  const words = String(input?.command ?? '')
    .trim()
    .split(/\s+/);
  if (words[0] === 'blackcat' || words[0] === 'bc') return `blackcat ${/^[a-z][a-z0-9-]*$/.test(words[1] ?? '') ? words[1] : ''}`.trim();
  return words[0].split('/').at(-1).slice(0, 30) || 'shell';
}

// ---- reading it back ----

const hydrate = (r) => {
  let data = {};
  try {
    data = r.data ? JSON.parse(r.data) : {};
  } catch {}
  return { ...r, ok: !!r.ok, data };
};

// What is shown: everything but a developer session's (`dev: false`), that as well
// ('all'), or only that ('only').
const shown = (dev, where, col = 'who') => {
  if (dev === 'only') where.push(`${col} = 'dev'`);
  else if (dev !== 'all' && dev !== true) where.push(`COALESCE(${col}, '') <> 'dev'`);
};

// Recent entries, newest first. `before`: only entries older than this one (the next page).
export function recent({ kind, category, sinceTs, failed = false, limit = 30, dev = false, who, work, lead = false, before } = {}) {
  return withDb(openActivityDb, (db) => {
    const where = ['1 = 1'];
    const p = { limit: Math.min(Math.max(Number(limit) || 30, 1), 5000) };
    if (kind) (where.push('kind = @kind'), (p.kind = kind));
    if (category) (where.push('category LIKE @category'), (p.category = `%${category}%`));
    if (sinceTs) (where.push('ts >= @since'), (p.since = sinceTs));
    if (failed) where.push('ok = 0');
    if (who) (where.push('who = @who'), (p.who = who));
    else shown(dev, where);
    if (work) (where.push('work = @work'), (p.work = work));
    if (lead) where.push('lead = 1');
    if (before) (where.push('id < @before'), (p.before = Number(before)));
    return db
      .prepare(`SELECT * FROM activity WHERE ${where.join(' AND ')} ORDER BY ts DESC, id DESC LIMIT @limit`)
      .all(p)
      .map(hydrate);
  });
}

// One piece of work: every entry made for it, oldest first. `ref` is its id, or the
// number of any entry that was part of it.
export function ofWork(ref) {
  return withDb(openActivityDb, (db) => {
    let id = String(ref ?? '');
    if (/^\d+$/.test(id)) {
      const e = db.prepare('SELECT work FROM activity WHERE id = ?').get(Number(id));
      if (!e) return null;
      if (!e.work) return { id: null, entries: db.prepare('SELECT * FROM activity WHERE id = ?').all(Number(id)).map(hydrate) };
      id = e.work;
    }
    const entries = db.prepare('SELECT * FROM activity WHERE work = ? ORDER BY id').all(id).map(hydrate);
    return entries.length ? { id, entries } : null;
  });
}

// Where the time of a piece of work went, from its entries: at the model, in commands,
// waiting for the owner, and the rest (blackcat itself).
export function split(entries) {
  const lead = entries.find((e) => e.lead) ?? null;
  const parts = entries.filter((e) => e !== lead);
  const sum = (list, f) => list.reduce((a, e) => a + (f(e) || 0), 0);
  // A chat turn says itself how long the model took; other work has a call to the model as an entry of its own.
  const models = entries.filter((e) => e.kind === 'model');
  const modelMs = sum(models, (e) => e.data.apiMs ?? (e === lead ? 0 : e.ms));
  const commands = parts.filter((e) => e.kind === 'command');
  const commandMs = sum(commands, (e) => e.ms);
  const waitedMs = sum(commands, (e) => e.data.waitedForYouMs) || (lead?.data.waitedForYouMs ?? 0);
  const total = lead?.ms ?? Math.max(0, ...entries.map((e) => e.ms ?? 0));
  return {
    ms: total,
    modelMs,
    commandMs,
    waitedMs,
    restMs: Math.max(0, total - modelMs - commandMs),
    calls: models.length,
    commands: commands.length,
    failed: entries.filter((e) => !e.ok).length,
    cost: models.some((e) => e.cost != null) ? sum(models, (e) => e.cost) : null,
    tokens: sum(models, (e) => (e.tokens_in ?? 0) + (e.tokens_out ?? 0) + (e.cache_read ?? 0) + (e.cache_write ?? 0)),
  };
}

// The slowest pieces of work since a time, each with where its time went.
export function slowest({ sinceTs, limit = 15, kind, category, dev = false } = {}) {
  return withDb(openActivityDb, (db) => {
    const where = ['lead = 1', 'ms IS NOT NULL'];
    const p = { limit: Math.min(Math.max(Number(limit) || 15, 1), 200) };
    if (sinceTs) (where.push('ts >= @since'), (p.since = sinceTs));
    if (kind) (where.push('kind = @kind'), (p.kind = kind));
    if (category) (where.push('category LIKE @category'), (p.category = `%${category}%`));
    shown(dev, where);
    const leads = db
      .prepare(`SELECT * FROM activity WHERE ${where.join(' AND ')} ORDER BY ms DESC LIMIT @limit`)
      .all(p)
      .map(hydrate);
    const parts = db.prepare('SELECT * FROM activity WHERE work = ? ORDER BY id');
    return leads.map((e) => ({ ...e, split: split(e.work ? parts.all(e.work).map(hydrate) : [e]) }));
  });
}

// What each kind of work took, since a time: how many, the middle one, the slowest, in all.
export function timings({ sinceTs, dev = false } = {}) {
  return withDb(openActivityDb, (db) => {
    const where = ['lead = 1', 'ms IS NOT NULL'];
    const p = {};
    if (sinceTs) (where.push('ts >= @since'), (p.since = sinceTs));
    shown(dev, where);
    const by = new Map();
    for (const r of db.prepare(`SELECT kind, category, ms, ok FROM activity WHERE ${where.join(' AND ')}`).all(p)) {
      const k = `${r.kind}\n${r.category}`;
      if (!by.has(k)) by.set(k, { kind: r.kind, category: r.category, all: [], failed: 0 });
      by.get(k).all.push(r.ms);
      if (!r.ok) by.get(k).failed++;
    }
    return [...by.values()]
      .map(({ all, ...g }) => {
        all.sort((a, b) => a - b);
        return {
          ...g,
          n: all.length,
          middleMs: all[Math.floor((all.length - 1) / 2)],
          slowestMs: all.at(-1),
          totalMs: all.reduce((a, b) => a + b, 0),
        };
      })
      .sort((a, b) => b.totalMs - a.totalMs);
  });
}

// Everything recorded for one conversation turn (its call to the model, the commands it ran), oldest first.
export function ofTurn(turnId) {
  return withDb(openActivityDb, (db) => {
    return db.prepare('SELECT * FROM activity WHERE turn_id = ? ORDER BY id').all(turnId).map(hydrate);
  });
}

// Totals over the last `days` days (today included), grouped by category, model, day or kind.
export function totals({ days = 7, by = 'category', kind = 'model', dev = false } = {}) {
  const col = { category: 'category', model: 'model', day: 'day', kind: 'kind', who: 'who' }[by] ?? 'category';
  return withDb(openActivityDb, (db) => {
    const from = dayOf(Math.floor(Date.now() / 1000) - (Math.max(1, Number(days) || 7) - 1) * 86400);
    const where = ['day >= @from'];
    if (kind && by !== 'kind') where.push('kind = @kind');
    shown(by === 'who' ? 'all' : dev, where);
    const rows = db
      .prepare(
        `SELECT ${col} AS name, SUM(n) AS n, SUM(failed) AS failed, SUM(ms) AS ms, MAX(slowest) AS slowest, SUM(tokens_in) AS tokensIn, SUM(tokens_out) AS tokensOut,
        SUM(cache_read) AS cacheRead, SUM(cache_write) AS cacheWrite, SUM(cost) AS cost
      FROM activity_daily WHERE ${where.join(' AND ')} GROUP BY ${col}
      ORDER BY ${by === 'day' ? 'name DESC' : 'cost DESC, n DESC'}`,
      )
      .all({ from, ...(kind && by !== 'kind' ? { kind } : {}) });
    return { from, days: Math.max(1, Number(days) || 7), by, rows };
  });
}

// Delete the record, or (`dev`) only what developer sessions did: their entries and their
// part of the daily totals, so that what is left is as if they had never run.
export function clear({ dev = false } = {}) {
  return withDb(openActivityDb, (db) => {
    if (!dev) {
      const n = db.prepare('SELECT COUNT(*) FROM activity').pluck().get();
      db.exec('DELETE FROM activity; DELETE FROM activity_daily;');
      return n;
    }
    return db.transaction(() => {
      const n = db.prepare("DELETE FROM activity WHERE who = 'dev'").run().changes;
      db.prepare("DELETE FROM activity_daily WHERE who = 'dev'").run();
      return n;
    })();
  });
}

export function counts() {
  return withDb(openActivityDb, (db) => {
    return {
      entries: db.prepare('SELECT COUNT(*) FROM activity').pluck().get(),
      since: db.prepare('SELECT MIN(ts) FROM activity').pluck().get(),
      today: db
        .prepare(
          "SELECT kind, SUM(n) AS n, SUM(cost) AS cost, SUM(tokens_in + tokens_out + cache_read + cache_write) AS tokens FROM activity_daily WHERE day = ? AND who <> 'dev' GROUP BY kind",
        )
        .all(dayOf(Math.floor(Date.now() / 1000))),
    };
  });
}

// A few words for what went wrong, for the record: the kind of failure, never content.
export const whyShort = (e) =>
  String(e?.message ?? e ?? 'failed')
    .replace(/\s+/g, ' ')
    .slice(0, 120);

// (A command at a terminal that makes a more telling entry of itself than the general one: see command.js.)
let leadOf = null;
export const leadsBy = (fn) => (leadOf = fn);

// What the owner did directly: a button tapped, a command typed, something about blackcat
// changed. Never what was said: what, and when. (Not for what the agent ran, nor for what
// a scheduled job ran in the owner's name.) `ms`: how long it took, where that is known.
export function ownerDid(category, summary = null, { ok = true, surface = null, data, ms = null } = {}) {
  if (process.env.BLACKCAT_CALLER === 'agent' || process.env.BLACKCAT_JOB) return null;
  return record({
    kind: 'owner',
    who: 'owner',
    category,
    summary: summary == null ? null : String(summary).slice(0, 200),
    ok,
    surface,
    data,
    ms,
    lead: leadOf?.(category) ?? false,
  });
}

// The same, around the work it sets off: how long that took, and whether it failed (and why).
// `data` may be a function, asked once the work is over. What `fn` throws is thrown on.
export function ownerDoing(category, summary, fn, { surface = null, data } = {}) {
  if (process.env.BLACKCAT_CALLER === 'agent' || process.env.BLACKCAT_JOB) return fn();
  return work(
    { kind: 'owner', who: 'owner', category, summary: summary == null ? null : String(summary).slice(0, 200), surface, data },
    fn,
  );
}

// What blackcat sent the owner without being asked: a reminder, the briefing, an alert.
// `from`: the part that sent it. `what`: a few words for it ("the briefing"). Never its text.
// `ms`: how long the channel took to take it · `why`: what went wrong · `lateS`: how long after its time.
export function sentOwner(from, what = null, { ok = true, chars = null, ms = null, why = null, lateS = null, file = false } = {}) {
  const data = {
    ...(chars == null ? {} : { chars }),
    ...(why ? { error: whyShort(why) } : {}),
    ...(lateS != null && lateS >= 60 ? { lateS: Math.round(lateS) } : {}),
    ...(file ? { file: true } : {}),
  };
  return record({ kind: 'sent', category: from, summary: what ?? 'a message', ok, surface: 'chat', ms, data });
}

// A service saying it is working: how long after it was started, or after how long cut off.
// (Only when it runs as a service, not when the same code pairs an account at a terminal.)
let connectedOnce = false;
export function serviceConnected({ offlineMs = null } = {}) {
  const id = process.env.BLACKCAT_SERVICE;
  if (!id) return null;
  const again = connectedOnce;
  connectedOnce = true;
  return record({
    kind: 'event',
    category: `service: ${id}`,
    summary: again ? 'connected again' : 'connected',
    ms: again ? null : Math.round(process.uptime() * 1000),
    data: again && offlineMs != null ? { offlineS: Math.round(offlineMs / 1000) } : undefined,
  });
}
