// What blackcat did, and what it cost: every call to the model (with its tokens, model and
// time), every command the agent ran (with how it was allowed and how it ended), scheduled
// work that did something, and anything else worth noting. One table of entries, plus
// running totals per day that are kept long after the entries themselves are gone.
//
// What is never recorded: what was said. Not your messages, not the agent's replies, not what
// a search returned. An entry says that a chat turn happened, what it ran and what it used.
//
// Recording must never get in the way of the thing being recorded: record() does not throw.
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

const STEPS = [(db) => db.exec(SCHEMA)];
function open() {
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
    };
    return withDb(open, (db) => {
      let id = null;
      db.transaction(() => {
        if (!entry.countOnly) {
          id = Number(
            db
              .prepare(
                `INSERT INTO activity (ts, kind, category, surface, ok, ms, model, tokens_in, tokens_out, cache_read, cache_write, cost, turn_id, summary, data)
            VALUES (@ts, @kind, @category, @surface, @ok, @ms, @model, @tokens_in, @tokens_out, @cache_read, @cache_write, @cost, @turn_id, @summary, @data)`,
              )
              .run(row).lastInsertRowid,
          );
        }
        db.prepare(
          `INSERT INTO activity_daily (day, kind, category, model, n, failed, ms, tokens_in, tokens_out, cache_read, cache_write, cost)
          VALUES (@day, @kind, @category, @model, 1, @failed, @ms, @tokens_in, @tokens_out, @cache_read, @cache_write, @cost)
          ON CONFLICT (day, kind, category, model) DO UPDATE SET n = n + 1, failed = failed + excluded.failed, ms = ms + excluded.ms,
            tokens_in = tokens_in + excluded.tokens_in, tokens_out = tokens_out + excluded.tokens_out,
            cache_read = cache_read + excluded.cache_read, cache_write = cache_write + excluded.cache_write, cost = cost + excluded.cost`,
        ).run({
          day: dayOf(ts),
          kind: row.kind,
          category: row.category,
          model: row.model ?? '',
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

// Recent entries, newest first.
export function recent({ kind, category, sinceTs, failed = false, limit = 30 } = {}) {
  return withDb(open, (db) => {
    const where = ['1 = 1'];
    const p = { limit: Math.min(Math.max(Number(limit) || 30, 1), 500) };
    if (kind) (where.push('kind = @kind'), (p.kind = kind));
    if (category) (where.push('category LIKE @category'), (p.category = `%${category}%`));
    if (sinceTs) (where.push('ts >= @since'), (p.since = sinceTs));
    if (failed) where.push('ok = 0');
    return db
      .prepare(`SELECT * FROM activity WHERE ${where.join(' AND ')} ORDER BY ts DESC, id DESC LIMIT @limit`)
      .all(p)
      .map(hydrate);
  });
}

// Everything recorded for one conversation turn (its call to the model, the commands it ran), oldest first.
export function ofTurn(turnId) {
  return withDb(open, (db) => {
    return db.prepare('SELECT * FROM activity WHERE turn_id = ? ORDER BY id').all(turnId).map(hydrate);
  });
}

// Totals over the last `days` days (today included), grouped by category, model, day or kind.
export function totals({ days = 7, by = 'category', kind = 'model' } = {}) {
  const col = { category: 'category', model: 'model', day: 'day', kind: 'kind' }[by] ?? 'category';
  return withDb(open, (db) => {
    const from = dayOf(Math.floor(Date.now() / 1000) - (Math.max(1, Number(days) || 7) - 1) * 86400);
    const rows = db
      .prepare(
        `SELECT ${col} AS name, SUM(n) AS n, SUM(failed) AS failed, SUM(ms) AS ms, SUM(tokens_in) AS tokensIn, SUM(tokens_out) AS tokensOut,
        SUM(cache_read) AS cacheRead, SUM(cache_write) AS cacheWrite, SUM(cost) AS cost
      FROM activity_daily WHERE day >= @from ${kind && by !== 'kind' ? 'AND kind = @kind' : ''} GROUP BY ${col}
      ORDER BY ${by === 'day' ? 'name DESC' : 'cost DESC, n DESC'}`,
      )
      .all({ from, ...(kind && by !== 'kind' ? { kind } : {}) });
    return { from, days: Math.max(1, Number(days) || 7), by, rows };
  });
}

export function clear() {
  return withDb(open, (db) => {
    const n = db.prepare('SELECT COUNT(*) FROM activity').pluck().get();
    db.exec('DELETE FROM activity; DELETE FROM activity_daily;');
    return n;
  });
}

export function counts() {
  return withDb(open, (db) => {
    return {
      entries: db.prepare('SELECT COUNT(*) FROM activity').pluck().get(),
      since: db.prepare('SELECT MIN(ts) FROM activity').pluck().get(),
      today: db
        .prepare(
          'SELECT kind, SUM(n) AS n, SUM(cost) AS cost, SUM(tokens_in + tokens_out + cache_read + cache_write) AS tokens FROM activity_daily WHERE day = ? GROUP BY kind',
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

// What the owner did directly: a button tapped, a command typed, something about blackcat
// changed. Never what was said: what, and when. (Not for what the agent ran, nor for what
// a scheduled job ran in the owner's name.) `ms`: how long it took, where that is known.
export function ownerDid(category, summary = null, { ok = true, surface = null, data, ms = null } = {}) {
  if (process.env.BLACKCAT_CALLER === 'agent' || process.env.BLACKCAT_JOB) return null;
  return record({ kind: 'owner', category, summary: summary == null ? null : String(summary).slice(0, 200), ok, surface, data, ms });
}

// The same, around the work it sets off: how long that took, and whether it failed (and why).
// `data` may be a function, asked once the work is over. What `fn` throws is thrown on.
export async function ownerDoing(category, summary, fn, { surface = null, data } = {}) {
  const t0 = Date.now();
  const done = (ok, extra) => {
    try {
      ownerDid(category, summary, {
        ok,
        surface,
        ms: Date.now() - t0,
        data: { ...(typeof data === 'function' ? data() : data), ...extra },
      });
    } catch {}
  };
  try {
    const r = await fn();
    done(true);
    return r;
  } catch (e) {
    done(false, { error: whyShort(e) });
    throw e;
  }
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
