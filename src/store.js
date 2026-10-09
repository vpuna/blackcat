// Small things a part of blackcat, or a plugin, keeps between runs and that change with
// use: what it last fetched, where it had got to, what was decided. Kept in agent.db, one
// value under a key, so that two processes writing at once cannot lose each other's and a
// crash cannot leave half of one. (Settings are in config.json and secrets in secrets.json:
// neither belongs here.)
import { openAgentDb } from './agentdb.js';
import { upgrade, withDb } from './db.js';

const STEPS = [
  (db) =>
    db.exec(
      'CREATE TABLE IF NOT EXISTS kept (part TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_ts INTEGER NOT NULL, PRIMARY KEY (part, key)) WITHOUT ROWID',
    ),
];
function open() {
  const db = openAgentDb();
  upgrade(db, 'kept', STEPS);
  return db;
}
const now = () => Math.floor(Date.now() / 1000);

// The store of one part (a plugin's name, or a name of the core's own).
export function storeFor(part) {
  const put = (db, key, value) =>
    db
      .prepare(
        'INSERT INTO kept (part, key, value, updated_ts) VALUES (?, ?, ?, ?) ON CONFLICT (part, key) DO UPDATE SET value = excluded.value, updated_ts = excluded.updated_ts',
      )
      .run(part, String(key), JSON.stringify(value), now());
  return {
    // The value under a key, or undefined.
    get: (key) =>
      withDb(open, (db) => {
        const row = db.prepare('SELECT value FROM kept WHERE part = ? AND key = ?').pluck().get(part, String(key));
        return row === undefined ? undefined : JSON.parse(row);
      }),
    set: (key, value) =>
      withDb(open, (db) =>
        value === undefined ? db.prepare('DELETE FROM kept WHERE part = ? AND key = ?').run(part, String(key)) : put(db, key, value),
      ) && undefined,
    delete: (key) => withDb(open, (db) => db.prepare('DELETE FROM kept WHERE part = ? AND key = ?').run(part, String(key)).changes > 0),
    keys: () => withDb(open, (db) => db.prepare('SELECT key FROM kept WHERE part = ? ORDER BY key').pluck().all(part)),
    // Change the value under a key in one step: `fn(was)` returns what it is to be.
    update(key, fn) {
      return withDb(open, (db) =>
        db
          .transaction(() => {
            const row = db.prepare('SELECT value FROM kept WHERE part = ? AND key = ?').pluck().get(part, String(key));
            const next = fn(row === undefined ? undefined : JSON.parse(row));
            if (next === undefined) db.prepare('DELETE FROM kept WHERE part = ? AND key = ?').run(part, String(key));
            else put(db, key, next);
            return next;
          })
          .immediate(),
      );
    },
  };
}
