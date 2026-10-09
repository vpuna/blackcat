// The Telegram source is the only process logged in to the account, so `bc msg media`
// leaves a request in a table and the service answers it. It looks at that table every
// second and a half; when there is nothing to do it must not write to the database at all.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { home } from './helpers.js';

const dir = home();
const { save } = await import('../src/config.js');
save({ plugins: { settings: { tg: { apiId: 1, apiHash: 'h', days: 30, mode: 'all' } } } });
const { startTgService } = await import('../plugins/tg/service.js');
const { openWrite } = await import('../src/archive/db.js');
const { openRequestsDb } = await import('../plugins/tg/requests.js');

// A stand-in for the logged-in Telegram client: one account, no chats, one downloadable file.
const client = {
  getMe: async () => ({ id: 111, firstName: 'Owner' }),
  addEventHandler: () => {},
  getDialogs: async () => [],
  iterDialogs: async function* () {
    backfills++;
    yield* [];
  },
  getInputEntity: async (id) => id,
  getMessages: async () => [{ media: { fake: true } }],
  downloadMedia: async () => Buffer.from('the file'),
  disconnect: async () => {},
  connected: true,
};
let backfills = 0; // how many times the service went looking for history
const events = { NewMessage: class {}, EditedMessage: class {}, DeletedMessage: class {}, Raw: class {} };
const utils = { strippedPhotoToJpg: (b) => b };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let source;
before(async () => {
  source = await startTgService({ client, events, utils, log: () => {} });
});
after(async () => source?.stop());

test('a request for a file is answered and the file is saved', async () => {
  const wa = openWrite();
  wa.prepare("INSERT INTO chats (ref, name, is_group) VALUES ('tg:222', 'A chat', 0)").run();
  const row = wa
    .prepare(
      "INSERT INTO messages (chat_ref, id, sender_ref, from_me, ts, type, text) VALUES ('tg:222', 'tg222_7', 'tg:222', 0, ?, 'document', 'report.pdf')",
    )
    .run(Math.floor(Date.now() / 1000));
  wa.prepare("INSERT INTO media (msg_rowid, dl_type, mimetype, size, file_name) VALUES (?, 'tg', 'application/pdf', 8, 'report.pdf')").run(
    row.lastInsertRowid,
  );
  wa.close();
  const adb = openRequestsDb();
  const id = adb
    .prepare("INSERT INTO tg_requests (msg_id, created_ts) VALUES ('tg222_7', ?)")
    .run(Math.floor(Date.now() / 1000)).lastInsertRowid;
  let r;
  for (let i = 0; i < 40 && (r = adb.prepare('SELECT * FROM tg_requests WHERE id = ?').get(id)).status === 'pending'; i++) await wait(250);
  adb.close();
  assert.equal(r.status, 'done', r.error);
  assert.equal(fs.readFileSync(r.path, 'utf8'), 'the file');
  assert.equal(path.basename(r.path), 'report.pdf');
});

test('with nothing to do, the database is not written to', async () => {
  await wait(2000); // let anything in progress settle
  const files = ['agent.db', 'agent.db-wal'].map((f) => path.join(dir, 'data', f)).filter((f) => fs.existsSync(f));
  const stamp = () => files.map((f) => fs.statSync(f).mtimeMs).join(',');
  const before = stamp();
  await wait(5000); // three looks at the table
  assert.equal(stamp(), before);
});

test('a real change to what is kept fetches history again; settings that vanish do not', async () => {
  const { update } = await import('../src/config.js');
  const settle = () => wait(3500); // two looks at the config
  await settle();
  const start = backfills;
  update((cfg) => {
    cfg.plugins.settings.tg.days = 60;
  });
  await settle();
  assert.equal(backfills, start + 1, 'changing the number of days looks for history again');
  // An update moving the settings, or a half-written config, while this process still runs:
  // an empty selection has no day limit, so acting on it would fetch years of history.
  update((cfg) => {
    delete cfg.plugins.settings.tg;
  });
  await settle();
  assert.equal(backfills, start + 1, 'vanished settings must not start a fetch');
});
