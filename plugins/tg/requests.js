// Requests for the Telegram source, which is the only process logged in to the
// account: `bc msg media` asks here, the service downloads and answers.
//
// A small database of this plugin's own, in its private folder. (The table was once in
// blackcat's own database; what was waiting there was a moment's worth of requests, and a
// request not answered is simply made again.)
import path from 'node:path';
import { openSqlite, ownDataDir, upgrade } from '../../src/api.js';
const SCHEMA = `
CREATE TABLE IF NOT EXISTS tg_requests (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  msg_id     TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',   -- pending | done | error
  path       TEXT,
  error      TEXT,
  created_ts INTEGER NOT NULL
);
`;

const STEPS = [(db) => db.exec(SCHEMA)]; // 1: the table
export const openRequestsDb = () => {
  const db = openSqlite(path.join(ownDataDir(import.meta.url), 'requests.db'));
  upgrade(db, 'tg-requests', STEPS);
  return db;
};
