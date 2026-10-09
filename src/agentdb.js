import path from 'node:path';
import { DATA } from './config.js';
import { openSqlite, upgrade } from './db.js';

// blackcat's own state: scheduler bookkeeping here, and each part's tables (reminders,
// watches, conversations, …), which each part looks after itself: it opens the database
// with openAgentDb() and brings its own tables up to date with upgrade() (src/db.js).
// Separate from the message archive, which only sources write to.
export const AGENT_DB = path.join(DATA, 'agent.db');

const STEPS = [
  // A place for single values (when something was last done, and the like).
  (db) => db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)'),
];

// (`schema`: tables of the caller's own, as CREATE … IF NOT EXISTS statements, made on every
// open. Kept for a plugin written that way; a list of steps given to upgrade() is better.)
export function openAgentDb(schema = '') {
  const db = openSqlite(AGENT_DB);
  upgrade(db, 'core', STEPS, { base: 2, owns: ['meta'] });
  if (schema) db.exec(schema);
  return db;
}

export const getMeta = (db, key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
export const setMeta = (db, key, value) =>
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, String(value));
