// Requests for the WhatsApp source, which is the only process linked to the account:
// `bc wa recover` asks here, the service does the work and says how it went.
//
// A small database of this plugin's own, in its private folder. A request not answered
// (the service was restarted) is simply made again.
import path from 'node:path';
import { openSqlite, ownDataDir, upgrade, workTable } from '../../src/api.js';
const SCHEMA = workTable('wa_requests');

const STEPS = [(db) => db.exec(SCHEMA)]; // 1: the table
export const openRequestsDb = () => {
  const db = openSqlite(path.join(ownDataDir(import.meta.url), 'requests.db'));
  upgrade(db, 'wa-requests', STEPS);
  return db;
};
