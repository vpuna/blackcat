// Checks: each looks at a system on a schedule (a command's result, a file that should keep
// changing), keeps whether it is working, and may run a fix. Their own tables in blackcat's
// database: they have nothing to do with messages or lists.
//   checks.look_for   the owner's words for what "working" looks like (optional: with none,
//                     only the plain rules decide and no model is asked)
//   checks.every      JSON: the cron expressions for when it looks
//   checks.state      JSON: what it saw when it last looked: { ok, checked, reason }
//   checks.alert      JSON: when the owner is told: { at: 'now' | 'briefing' } or { after: n } (looks
//                     in a row) or { afterS } (down this long). Nothing: at once.
//   checks.quiet      "03:00-03:30": a time of day when it tells nothing (it still looks and fixes)
//   checks.remind     "1h": tell again this often while something is wrong and not snoozed
//   checks.builtin    'itself' for the check that is always there (ITSELF)
//   checks.measure    JSON: the figures kept from each look's output, ["temp", "load"]
//   checks.limits     JSON: [{ field, op: '>' | '<', value }]: past one, it is not working
//   checks.context    a command run when it goes wrong, whose output is kept (check-history.db)
//   checks.keep       "30d": how long its history is kept
//   check_findings    what is wrong, one row an outage, see below
import { adopt, openAgentDb, ownerChat } from '../internal.js';
import { upgrade } from '../db.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS checks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    INTEGER,
  name       TEXT NOT NULL,
  look_for   TEXT NOT NULL DEFAULT '',
  command    TEXT,
  file       TEXT,
  max_age    TEXT,
  fix        TEXT,
  tries      INTEGER,
  wait       TEXT,
  every      TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  state      TEXT,
  last_run   INTEGER,
  created_ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS check_incidents (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  check_id INTEGER NOT NULL,
  ts       INTEGER NOT NULL,
  title    TEXT NOT NULL,
  summary  TEXT,
  open     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS check_incidents_check ON check_incidents (check_id, ts);
`;

// A finding: one thing a check found wrong, from when it was first seen until it worked again.
// Found again while it lasts, the same row is brought up to date (last_seen, times, detail).
// Once resolved it is history: found again later, it is a new row, unless it worked again
// for only a few minutes, when the same row is opened again (it was one outage, bouncing).
//   key        what it is, the same each time: 'down' for a check that is working or not,
//              or a few words a reader gave ("backup-check-failed")
//   state      open | snoozed | resolved
//   snoozed_until  when a snooze ends (empty while snoozed: until it is resolved)
//   alerted    whether the owner has been told of it (so that "working again" is said only then)
//   told_ts    when they were last told, for --remind
//   fix_note   what the fix did: "restarted 2 times; it did not help"
const FINDINGS = `
CREATE TABLE check_findings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  check_id      INTEGER NOT NULL,
  key           TEXT NOT NULL,
  title         TEXT NOT NULL,
  detail        TEXT,
  first_detail  TEXT,
  first_seen    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL,
  times         INTEGER NOT NULL DEFAULT 1,
  state         TEXT NOT NULL DEFAULT 'open',
  snoozed_until INTEGER,
  snoozed_ts    INTEGER,
  resolved_ts   INTEGER,
  alerted       INTEGER NOT NULL DEFAULT 0,
  told_ts       INTEGER,
  fix_note      TEXT
);
CREATE INDEX check_findings_check ON check_findings (check_id, first_seen);
-- One current finding (open or snoozed) for each thing a check can find.
CREATE UNIQUE INDEX check_findings_current ON check_findings (check_id, key) WHERE state != 'resolved';
ALTER TABLE checks ADD COLUMN alert TEXT;
ALTER TABLE checks ADD COLUMN quiet TEXT;
ALTER TABLE checks ADD COLUMN remind TEXT;
`;

// The incidents kept before become findings: one still open stays open (the newest, if a check
// somehow had two), and when one that is over ended was not kept. "Fixed: …" was a fix that worked.
function fromIncidents(db) {
  db.exec(FINDINGS);
  const rows = db.prepare('SELECT * FROM check_incidents ORDER BY check_id, ts, id').all();
  const newestOpen = new Map();
  for (const r of rows) if (r.open) newestOpen.set(r.check_id, r.id);
  const ins =
    db.prepare(`INSERT INTO check_findings (check_id, key, title, detail, first_detail, first_seen, last_seen, times, state, alerted, fix_note)
    VALUES (@check, 'down', @title, @detail, @detail, @ts, @ts, 1, @state, 1, @fix)`);
  for (const r of rows) {
    const fixed = /^Fixed: /.test(r.title);
    ins.run({
      check: r.check_id,
      title: r.title.replace(/^(Fixed|Not working): /, ''),
      detail: r.summary ?? null,
      ts: r.ts,
      state: newestOpen.get(r.check_id) === r.id ? 'open' : 'resolved',
      fix: fixed ? 'its fix worked' : null,
    });
  }
  // What a check said of itself: kept as what it saw when it last looked.
  const put = db.prepare('UPDATE checks SET state = ? WHERE id = ?');
  for (const c of db.prepare('SELECT id, state FROM checks WHERE state IS NOT NULL').all()) {
    const s = JSON.parse(c.state);
    put.run(JSON.stringify({ ok: s.status !== 'failing', checked: s.checked ?? null, reason: s.reason ?? null }), c.id);
  }
  db.exec('DROP TABLE check_incidents');
}

// The check that is always there: blackcat looking at its own record, by plain rules (see
// src/activity/problems.js). It can be paused and told when to speak, not removed or changed
// to look at something else.
export const ITSELF = {
  builtin: 'itself',
  name: 'blackcat health',
  command: 'blackcat activity problems --json',
  every: ['5 * * * *'],
};
function itself(db) {
  db.exec('ALTER TABLE checks ADD COLUMN builtin TEXT');
  db.prepare(
    `INSERT INTO checks (name, look_for, command, every, active, created_ts, builtin) VALUES (@name, '', @command, @every, 1, @now, @builtin)`,
  ).run({ ...ITSELF, every: JSON.stringify(ITSELF.every), now: Math.floor(Date.now() / 1000) });
}

export const DEFAULT_EVERY = ['*/30 * * * *'];
// The standing permission a check's fix is given is marked as that check's, so that it goes
// when the check does (and one the owner gave separately does not).
export const viaOf = (id) => `check ${id}`;

// What a check records (src/checks/history.js keeps it).
const recording = (db) => {
  for (const col of ['measure', 'limits', 'context', 'keep']) db.exec(`ALTER TABLE checks ADD COLUMN ${col} TEXT`);
};

// It was called "blackcat itself" at first, which said whose it is, not what it looks at.
// (A name the owner gave it stays.)
const renamed = (db) => db.prepare("UPDATE checks SET name = ? WHERE builtin = 'itself' AND name = 'blackcat itself'").run(ITSELF.name);

const STEPS = [(db) => db.exec(SCHEMA), fromIncidents, itself, recording, renamed];

export function openChecksDb() {
  const db = openAgentDb();
  upgrade(db, 'checks', STEPS, { base: 2, owns: ['checks'] });
  adopt(db, 'checks');
  return db;
}

const hydrate = (r) =>
  r && {
    id: r.id,
    // (The built-in check has no chat of its own: it tells the owner, wherever they are.)
    chat_id: r.chat_id ?? (r.builtin ? ownerChat() : null),
    builtin: r.builtin ?? null,
    name: r.name,
    look_for: r.look_for ?? '',
    command: r.command,
    file: r.file,
    maxAge: r.max_age,
    fix: r.fix,
    tries: r.tries,
    wait: r.wait,
    every: JSON.parse(r.every),
    active: !!r.active,
    state: r.state ? JSON.parse(r.state) : null,
    alert: r.alert ? JSON.parse(r.alert) : null,
    quiet: r.quiet ?? null,
    remind: r.remind ?? null,
    measure: r.measure ? JSON.parse(r.measure) : null,
    limits: r.limits ? JSON.parse(r.limits) : null,
    context: r.context ?? null,
    keep: r.keep ?? null,
    last_run: r.last_run,
    created_ts: r.created_ts,
    // What is wrong now, in short: null when nothing is.
    wrong: r.n_open || r.n_snoozed ? { open: r.n_open, snoozed: r.n_snoozed, since: r.wrong_since, title: r.wrong_title } : null,
  };
// Each check with what is wrong with it now.
const WITH_WRONG = `SELECT c.*,
  (SELECT COUNT(*) FROM check_findings f WHERE f.check_id = c.id AND f.state = 'open') AS n_open,
  (SELECT COUNT(*) FROM check_findings f WHERE f.check_id = c.id AND f.state = 'snoozed') AS n_snoozed,
  (SELECT MIN(first_seen) FROM check_findings f WHERE f.check_id = c.id AND f.state != 'resolved') AS wrong_since,
  (SELECT title FROM check_findings f WHERE f.check_id = c.id AND f.state != 'resolved' ORDER BY f.state = 'snoozed', f.first_seen LIMIT 1) AS wrong_title
  FROM checks c`;

export const listChecks = (db, { activeOnly = false } = {}) =>
  db
    .prepare(`${WITH_WRONG} ${activeOnly ? 'WHERE c.active = 1' : ''} ORDER BY c.id`)
    .all()
    .map(hydrate);
export const getCheck = (db, id) => hydrate(db.prepare(`${WITH_WRONG} WHERE c.id = ?`).get(id));

// By number, or by a part of its name that fits only one.
export function findCheck(db, ref) {
  const s = String(ref ?? '').trim();
  if (/^\d+$/.test(s)) return getCheck(db, Number(s));
  const all = listChecks(db);
  const exact = all.filter((c) => c.name.toLowerCase() === s.toLowerCase());
  if (exact.length === 1) return exact[0];
  const part = all.filter((c) => c.name.toLowerCase().includes(s.toLowerCase()));
  return part.length === 1 ? part[0] : null;
}

const COLS = {
  name: 'name',
  look_for: 'look_for',
  command: 'command',
  file: 'file',
  maxAge: 'max_age',
  fix: 'fix',
  tries: 'tries',
  wait: 'wait',
  active: 'active',
  last_run: 'last_run',
  quiet: 'quiet',
  remind: 'remind',
  context: 'context',
  keep: 'keep',
};
export function addCheck(db, c) {
  const id = Number(
    db
      .prepare(
        `INSERT INTO checks (chat_id, name, look_for, command, file, max_age, fix, tries, wait, every, alert, quiet, remind, measure, limits, context, keep, active, created_ts)
    VALUES (@chatId, @name, @look_for, @command, @file, @maxAge, @fix, @tries, @wait, @every, @alert, @quiet, @remind, @measure, @limits, @context, @keep, 1, @now)`,
      )
      .run({
        chatId: c.chatId ?? null,
        name: c.name,
        look_for: c.look_for ?? '',
        command: c.command ?? null,
        file: c.file ?? null,
        maxAge: c.maxAge ?? null,
        fix: c.fix ?? null,
        tries: c.tries ?? null,
        wait: c.wait ?? null,
        every: JSON.stringify(c.every ?? DEFAULT_EVERY),
        alert: c.alert ? JSON.stringify(c.alert) : null,
        quiet: c.quiet ?? null,
        remind: c.remind ?? null,
        measure: c.measure?.length ? JSON.stringify(c.measure) : null,
        limits: c.limits?.length ? JSON.stringify(c.limits) : null,
        context: c.context ?? null,
        keep: c.keep ?? null,
        now: Math.floor(Date.now() / 1000),
      }).lastInsertRowid,
  );
  return getCheck(db, id);
}
export function updateCheck(db, id, patch) {
  const sets = [];
  const vals = { id };
  for (const [k, v] of Object.entries(patch)) {
    if (['every', 'state', 'alert', 'measure', 'limits'].includes(k))
      (sets.push(`${k} = @${k}`), (vals[k] = v == null || (Array.isArray(v) && !v.length) ? null : JSON.stringify(v)));
    else if (COLS[k]) (sets.push(`${COLS[k]} = @${k}`), (vals[k] = k === 'active' ? (v ? 1 : 0) : (v ?? null)));
  }
  if (sets.length) db.prepare(`UPDATE checks SET ${sets.join(', ')} WHERE id = @id`).run(vals);
  return getCheck(db, id);
}
export function removeCheck(db, id) {
  db.prepare('DELETE FROM check_findings WHERE check_id = ?').run(id);
  return db.prepare('DELETE FROM checks WHERE id = ?').run(id).changes;
}

// ---- findings ----
const nowS = () => Math.floor(Date.now() / 1000);
export const getFinding = (db, id) => db.prepare('SELECT * FROM check_findings WHERE id = ?').get(id);
// What is wrong now (open or snoozed), the oldest first.
export const currentFindings = (db, checkId) =>
  db.prepare("SELECT * FROM check_findings WHERE check_id = ? AND state != 'resolved' ORDER BY first_seen, id").all(checkId);
// Everything it has found, the most recent first.
export const pastFindings = (db, checkId, limit = 20) =>
  db.prepare('SELECT * FROM check_findings WHERE check_id = ? ORDER BY first_seen DESC, id DESC LIMIT ?').all(checkId, limit);
// The latest of a kind that is over, if it ended less than `withinS` ago: one bouncing up and down is one outage.
export const justResolved = (db, checkId, key, withinS) =>
  db
    .prepare(
      "SELECT * FROM check_findings WHERE check_id = ? AND key = ? AND state = 'resolved' AND resolved_ts >= ? ORDER BY resolved_ts DESC, id DESC LIMIT 1",
    )
    .get(checkId, key, nowS() - withinS);

export function addFinding(db, checkId, { key, title, detail, resolved = false, fixNote = null }) {
  const t = nowS();
  const id = Number(
    db
      .prepare(
        `INSERT INTO check_findings (check_id, key, title, detail, first_detail, first_seen, last_seen, state, resolved_ts, fix_note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(checkId, key, title, detail ?? null, detail ?? null, t, t, resolved ? 'resolved' : 'open', resolved ? t : null, fixNote)
      .lastInsertRowid,
  );
  return getFinding(db, id);
}
// Found again: brought up to date. (A resolved one is opened again: see justResolved.)
export function seenAgain(db, id, { title, detail }) {
  db.prepare(
    `UPDATE check_findings SET last_seen = ?, times = times + 1, title = ?, detail = ?,
      state = CASE WHEN state = 'resolved' THEN 'open' ELSE state END, resolved_ts = NULL WHERE id = ?`,
  ).run(nowS(), title, detail ?? null, id);
  return getFinding(db, id);
}
export const resolveFinding = (db, id) =>
  db.prepare("UPDATE check_findings SET state = 'resolved', resolved_ts = ?, snoozed_until = NULL WHERE id = ?").run(nowS(), id);
export const setFixNote = (db, id, note) => db.prepare('UPDATE check_findings SET fix_note = ? WHERE id = ?').run(note, id);
export const markTold = (db, id) => db.prepare('UPDATE check_findings SET alerted = 1, told_ts = ? WHERE id = ?').run(nowS(), id);
// `until`: when it ends, or null for until it is resolved.
export const snoozeFinding = (db, id, until) =>
  db
    .prepare("UPDATE check_findings SET state = 'snoozed', snoozed_until = ?, snoozed_ts = ? WHERE id = ? AND state != 'resolved'")
    .run(until, nowS(), id).changes;
export const wakeFinding = (db, id) =>
  db.prepare("UPDATE check_findings SET state = 'open', snoozed_until = NULL WHERE id = ? AND state = 'snoozed'").run(id).changes;
