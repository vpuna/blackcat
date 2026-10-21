// What checks saw, kept for a while: the figures from each look (a reading) and, when one goes
// wrong, what was going on (its context: what a command printed, and the check's picture).
// A file of its own, data/check-history.db: it grows and is pruned on its own, and the
// commands that open blackcat's own database all the time are not slowed by it. A picture is
// kept in its row, so pruning a row prunes its picture, and no row points at a missing file.
// (What a check is, and what it found wrong, stay in agent.db: src/checks/db.js.)
//
//   history.kind     'reading' | 'context'
//   history.numbers  JSON: { temp: 74, load: 3.2 }
//   history.output   what the context command printed
//   history.file     a picture, made small (history.file_type says what kind)
import path from 'node:path';
import { DATA } from '../config.js';
import { openSqlite, upgrade, withDb } from '../db.js';

export const HISTORY_DB = path.join(DATA, 'check-history.db');
export const DEFAULT_KEEP = '30d';
// The most one check keeps in pictures: past it, its oldest go first.
const MAX_FILES_BYTES = 50 * 1024 ** 2;

const SCHEMA = `
CREATE TABLE history (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  check_id  INTEGER NOT NULL,
  ts        INTEGER NOT NULL,
  kind      TEXT NOT NULL,
  numbers   TEXT,
  output    TEXT,
  file      BLOB,
  file_type TEXT
);
CREATE INDEX history_check ON history (check_id, kind, ts);
`;

function open() {
  const db = openSqlite(HISTORY_DB);
  // So that the file shrinks again after pruning. (Once, when the file is new: a file already
  // written to, which a new one in WAL is, takes it only with a VACUUM.)
  if (db.pragma('auto_vacuum', { simple: true }) !== 2) {
    db.pragma('auto_vacuum = INCREMENTAL');
    db.exec('VACUUM');
  }
  upgrade(db, 'history', [(d) => d.exec(SCHEMA)]);
  return db;
}
const using = (fn) => withDb(open, fn);

// Rows older than the check keeps, and its pictures past the most it may have.
function prune(db, checkId, keepS) {
  let gone = db.prepare('DELETE FROM history WHERE check_id = ? AND ts < ?').run(checkId, Math.floor(Date.now() / 1000) - keepS).changes;
  const files = db
    .prepare('SELECT id, length(file) AS n FROM history WHERE check_id = ? AND file IS NOT NULL ORDER BY ts DESC')
    .all(checkId);
  let total = 0;
  for (const f of files) if ((total += f.n) > MAX_FILES_BYTES) gone += db.prepare('DELETE FROM history WHERE id = ?').run(f.id).changes;
  if (gone) db.pragma('incremental_vacuum');
}

export function addReading(checkId, numbers, keepS) {
  using((db) => {
    db.prepare("INSERT INTO history (check_id, ts, kind, numbers) VALUES (?, ?, 'reading', ?)").run(
      checkId,
      Math.floor(Date.now() / 1000),
      JSON.stringify(numbers),
    );
    prune(db, checkId, keepS);
  });
}

export function addContext(checkId, { output = null, file = null, fileType = null }, keepS) {
  using((db) => {
    db.prepare("INSERT INTO history (check_id, ts, kind, output, file, file_type) VALUES (?, ?, 'context', ?, ?, ?)").run(
      checkId,
      Math.floor(Date.now() / 1000),
      output,
      file,
      fileType,
    );
    prune(db, checkId, keepS);
  });
}

// When the last context was kept, so that one is not kept on every look while it stays wrong.
export const lastContextTs = (checkId) =>
  using((db) => db.prepare("SELECT MAX(ts) FROM history WHERE check_id = ? AND kind = 'context'").pluck().get(checkId) ?? 0);

// The readings between two times, oldest first. → [{ ts, numbers }]
export const readings = (checkId, fromTs, toTs = Math.floor(Date.now() / 1000)) =>
  using((db) =>
    db
      .prepare("SELECT ts, numbers FROM history WHERE check_id = ? AND kind = 'reading' AND ts >= ? AND ts <= ? ORDER BY ts")
      .all(checkId, fromTs, toTs)
      .map((r) => ({ ts: r.ts, numbers: JSON.parse(r.numbers) })),
  );

// What was kept of what was going on between two times, oldest first. Pictures only when asked.
export const contexts = (checkId, fromTs, toTs, { files = false } = {}) =>
  using((db) =>
    db
      .prepare(
        `SELECT id, ts, output, file_type, ${files ? 'file' : 'NULL AS file'} FROM history WHERE check_id = ? AND kind = 'context' AND ts >= ? AND ts <= ? ORDER BY ts`,
      )
      .all(checkId, fromTs, toTs),
  );

// A check removed takes its history with it; and what is left of a check that is gone (blackcat
// stopped between the two) goes the next time the checks look.
export const forget = (checkId) => using((db) => db.prepare('DELETE FROM history WHERE check_id = ?').run(checkId).changes);
export function keepOnly(ids) {
  using((db) => {
    const gone = db.prepare(`DELETE FROM history WHERE check_id NOT IN (${ids.map(() => '?').join(',') || 'NULL'})`).run(...ids).changes;
    if (gone) db.pragma('incremental_vacuum');
  });
}
