// One way to open a database, one way to change its shape, and one way to be sure it is
// closed. Every SQLite file blackcat keeps is opened through here.
//
// Changing a shape: each part that keeps tables in a database has an ordered list of steps,
// under its own name. A step is run once, in a transaction with the note that it has been
// run, and never again; a new step goes at the end of the list.
//
//   const db = openSqlite(file);
//   upgrade(db, 'reminders', [
//     (db) => db.exec('CREATE TABLE reminders (…)'),                 // 1
//     (db) => db.exec('ALTER TABLE reminders ADD COLUMN file TEXT'),  // 2
//   ]);
//
// On an open where nothing is to be done, that costs one read.
//
// A part whose first step stands for several earlier ones (they were folded into one when
// blackcat was first published) says how many with `base`: its first step leaves a new
// database at that number, and later steps count on from there. Data from before, part-way
// through those earlier steps, is not guessed at: it is refused, with what to do (OlderData).
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { pause } from './util/wait.js';

const BUSY_MS = 5000;

// Open a database file. A new one is created private to this account.
//   readonly   for looking only: nothing run on it can change the file (and it must exist)
//   relaxed    synchronous = NORMAL: for a file that is written to all day (the archive)
export function openSqlite(file, { readonly = false, relaxed = false } = {}) {
  if (readonly) {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    db.pragma(`busy_timeout = ${BUSY_MS}`);
    return db;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new Database(file);
  fs.chmodSync(file, 0o600);
  db.pragma(`busy_timeout = ${BUSY_MS}`);
  // Turning a new file to WAL needs it alone for a moment. When two processes open a new
  // database at once, SQLite refuses one of them outright rather than have it wait (each
  // would be waiting for the other), so that one asks again.
  patiently(() => db.pragma('journal_mode = WAL'));
  if (relaxed) db.pragma('synchronous = NORMAL');
  return db;
}

function patiently(fn, tries = 40) {
  for (let i = 1; ; i++) {
    try {
      return fn();
    } catch (e) {
      if (i >= tries || !/^SQLITE_BUSY|^SQLITE_LOCKED/.test(e.code ?? '')) throw e;
      pause(25 + i * 5);
    }
  }
}

const NOTES = 'CREATE TABLE IF NOT EXISTS shapes (part TEXT PRIMARY KEY, step INTEGER NOT NULL)';

// How many of a part's steps this database has had.
export function stepOf(db, part) {
  try {
    return db.prepare('SELECT step FROM shapes WHERE part = ?').pluck().get(part) ?? 0;
  } catch (e) {
    if (/no such table/.test(e.message)) return 0;
    throw e;
  }
}

// Data written by a blackcat from before the steps this one knows.
export class OlderData extends Error {
  constructor(part, at, base) {
    super(
      `This data was written by an earlier blackcat than this one can read (${part}: at step ${at}, and this version starts from ${base}). ` +
        'Open it once with the version it was written by, or restore a backup made by a newer one.',
    );
    this.name = 'OlderData';
    this.part = part;
  }
}

// Bring a part's tables up to date: run the steps this database has not had, in order.
//   base    the step number the first step leaves a new database at (default 1)
//   owns    tables that are this part's: found in a database with no note of the part, they
//           were made by a blackcat from before notes were kept, and the data is refused
// → how many steps were run now.
export function upgrade(db, part, steps, { base = 1, owns = [] } = {}) {
  const last = base + steps.length - 1;
  if (stepOf(db, part) >= last) return 0;
  let ran = 0;
  // One step at a time, each with its note, and under a write lock from the start: two
  // processes that open at the same moment do not both run it.
  for (;;) {
    const more = db
      .transaction(() => {
        db.exec(NOTES);
        let at = db.prepare('SELECT step FROM shapes WHERE part = ?').pluck().get(part) ?? null;
        if (at == null && owns.some((t) => hasTable(db, t))) throw new OlderData(part, 0, base);
        if (at != null && at < base) throw new OlderData(part, at, base);
        if (at == null || at < last) {
          steps[at == null ? 0 : at - base + 1](db);
          at = at == null ? base : at + 1;
          ran++;
        }
        db.prepare('INSERT INTO shapes (part, step) VALUES (?, ?) ON CONFLICT (part) DO UPDATE SET step = excluded.step').run(part, at);
        return at < last;
      })
      .immediate();
    if (!more) return ran;
  }
}

// Does a table have a column? (For a first step that must suit tables already there.)
export const hasColumn = (db, table, column) =>
  !!db.prepare(`SELECT 1 FROM pragma_table_info('${String(table).replace(/[^\w]/g, '')}') WHERE name = ?`).get(column);
// Add columns a table does not have yet: [[table, column, type], …].
export function addColumns(db, columns) {
  for (const [table, column, type] of columns)
    if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
export function hasTable(db, table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

// For an opener: get a database that has just been opened ready (its tables made), and hand
// it on. If it cannot be made ready it is closed, not left open behind the error.
export function madeReady(db, fn) {
  try {
    fn(db);
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}

// Open, do something, and close, whatever happens in between. `fn` may be async. (An opener
// that has nothing to open gives null, and `fn` is handed that.)
export function withDb(open, fn) {
  const db = open();
  let out;
  try {
    out = fn(db);
  } catch (e) {
    db?.close();
    throw e;
  }
  if (out && typeof out.then === 'function') return out.finally(() => db?.close());
  db?.close();
  return out;
}
