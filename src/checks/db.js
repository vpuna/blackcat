// Checks: each looks at a system on a schedule (a command's result, a file that should keep
// changing), keeps whether it is working, and may run a fix. Their own tables in blackcat's
// database: they have nothing to do with messages or lists.
//   checks.look_for   the owner's words for what "working" looks like (optional: with none,
//                     only the plain rules decide and no model is asked)
//   checks.every      JSON: the cron expressions for when it looks
//   checks.state      JSON: { status: 'ok' | 'failing', since, checked, reason, incident }
//   check_incidents   what went wrong and what was done about it, one row a time
import { adopt, openAgentDb } from '../internal.js';
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

export const DEFAULT_EVERY = ['*/30 * * * *'];
// The standing permission a check's fix is given is marked as that check's, so that it goes
// when the check does (and one the owner gave separately does not).
export const viaOf = (id) => `check ${id}`;

const STEPS = [(db) => db.exec(SCHEMA)];

export function openChecksDb() {
  const db = openAgentDb();
  upgrade(db, 'checks', STEPS, { base: 2, owns: ['checks'] });
  adopt(db, 'checks');
  return db;
}

const hydrate = (r) =>
  r && {
    id: r.id,
    chat_id: r.chat_id,
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
    last_run: r.last_run,
    created_ts: r.created_ts,
  };

export const listChecks = (db, { activeOnly = false } = {}) =>
  db
    .prepare(`SELECT * FROM checks ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY id`)
    .all()
    .map(hydrate);
export const getCheck = (db, id) => hydrate(db.prepare('SELECT * FROM checks WHERE id = ?').get(id));

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
};
export function addCheck(db, c) {
  const id = Number(
    db
      .prepare(
        `INSERT INTO checks (chat_id, name, look_for, command, file, max_age, fix, tries, wait, every, active, created_ts)
    VALUES (@chatId, @name, @look_for, @command, @file, @maxAge, @fix, @tries, @wait, @every, 1, @now)`,
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
        now: Math.floor(Date.now() / 1000),
      }).lastInsertRowid,
  );
  return getCheck(db, id);
}
export function updateCheck(db, id, patch) {
  const sets = [];
  const vals = { id };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'every' || k === 'state') (sets.push(`${k} = @${k}`), (vals[k] = v == null ? null : JSON.stringify(v)));
    else if (COLS[k]) (sets.push(`${COLS[k]} = @${k}`), (vals[k] = k === 'active' ? (v ? 1 : 0) : (v ?? null)));
  }
  if (sets.length) db.prepare(`UPDATE checks SET ${sets.join(', ')} WHERE id = @id`).run(vals);
  return getCheck(db, id);
}
export function removeCheck(db, id) {
  db.prepare('DELETE FROM check_incidents WHERE check_id = ?').run(id);
  return db.prepare('DELETE FROM checks WHERE id = ?').run(id).changes;
}

export const addIncident = (db, checkId, { title, summary, open }) =>
  Number(
    db
      .prepare('INSERT INTO check_incidents (check_id, ts, title, summary, open) VALUES (?, ?, ?, ?, ?)')
      .run(checkId, Math.floor(Date.now() / 1000), title, summary ?? null, open ? 1 : 0).lastInsertRowid,
  );
export const closeIncident = (db, id) => db.prepare('UPDATE check_incidents SET open = 0 WHERE id = ?').run(id).changes;
export const incidents = (db, checkId, limit = 20) =>
  db.prepare('SELECT * FROM check_incidents WHERE check_id = ? ORDER BY ts DESC, id DESC LIMIT ?').all(checkId, limit);
