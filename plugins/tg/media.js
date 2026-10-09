// Fetching a Telegram file. Only the service is logged in to the account, so the request
// is left in a table for it, and the file it saves is handed over.
import fs from 'node:fs';
import { isLinked } from './paired.js';
import { openRequestsDb } from './requests.js';
import { sleep, withDb } from '../../src/api.js';

export async function fetchTelegramMedia(id, dest) {
  return withDb(openRequestsDb, async (db) => {
    const rid = db
      .prepare('INSERT INTO tg_requests (msg_id, created_ts) VALUES (?, ?)')
      .run(id, Math.floor(Date.now() / 1000)).lastInsertRowid;
    const get = db.prepare('SELECT status, path, error FROM tg_requests WHERE id = ?');
    for (let waited = 0; waited < 120_000; waited += 500) {
      await sleep(500);
      const r = get.get(rid);
      if (r.status === 'done') {
        if (r.path !== dest) fs.renameSync(r.path, dest);
        return;
      }
      if (r.status === 'error') throw new Error(`Telegram download failed: ${r.error}.`);
      // Nobody picked it up: the service isn't running.
      if (waited === 6000 && r.status === 'pending' && !isLinked())
        throw new Error('Telegram is not linked, so its files can no longer be fetched.');
    }
    db.prepare("UPDATE tg_requests SET status = 'error', error = 'timed out' WHERE id = ? AND status = 'pending'").run(rid);
    throw new Error('The Telegram source did not answer. Is it running? Check `bc status`.');
  });
}
