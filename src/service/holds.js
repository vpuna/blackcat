// Work that must not be cut off by a restart: a routine on a phone halfway through a booking.
// Whatever does such work holds it while it runs (`holdRestart`); `bc restart` and `bc stop`
// wait until nothing is held, unless told `--now`. Kept in agent.db with the process that holds
// it: one whose process has gone (killed, crashed) holds nothing.
import { AGENT_DB } from '../agentdb.js';
import { openSqlite, upgrade, withDb } from '../db.js';
import { now } from '../util/time.js';

const STEPS = [
  (db) => db.exec('CREATE TABLE holds (id INTEGER PRIMARY KEY, pid INTEGER NOT NULL, what TEXT NOT NULL, since INTEGER NOT NULL)'),
];
const use = (fn) =>
  withDb(() => {
    const db = openSqlite(AGENT_DB);
    upgrade(db, 'holds', STEPS);
    return db;
  }, fn);

export const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

// `what`: as the owner is told it ("taxi-trip on the phone"). → release()
export function holdRestart(what) {
  const id = use((db) => db.prepare('INSERT INTO holds (pid, what, since) VALUES (?, ?, ?)').run(process.pid, what, now()).lastInsertRowid);
  const release = () => {
    process.off('exit', release);
    use((db) => db.prepare('DELETE FROM holds WHERE id = ?').run(id));
  };
  process.on('exit', release);
  return release;
}

// What is held now: [{ what, since }]. (Those whose process has gone are forgotten.)
export function held() {
  return use((db) => {
    const rows = db.prepare('SELECT * FROM holds ORDER BY since').all();
    const gone = rows.filter((r) => !alive(r.pid));
    for (const r of gone) db.prepare('DELETE FROM holds WHERE id = ?').run(r.id);
    return rows.filter((r) => !gone.includes(r));
  });
}
