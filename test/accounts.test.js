// The owner's accounts in the archive: each chat and message says which one it came in on
// (one of their WhatsApp numbers, Telegram accounts, mail accounts), so that can be asked,
// and a hidden account's messages are read nowhere: not in a search, by meaning or by words,
// not in a thread, a chat list or the totals. Nothing of it is deleted.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { home } from './helpers.js';

home();
const { save } = await import('../src/config.js');
save({ archive: { embedder: { provider: 'hash' } } });
const { accountFor, claimRows, openWrite, sourceSql } = await import('../src/archive/db.js');
const { archiveStatements, messageRow } = await import('../src/archive/writer.js');
const query = await import('../src/archive/query.js');
const { find, index } = await import('../src/archive/semantic.js');

const now = Math.floor(Date.now() / 1000);
const MAYA = 'wa:15550001234@s.whatsapp.net';
const db = openWrite();
// Stored before accounts were noted: no account yet.
archiveStatements(db).chat.run({ ref: MAYA, name: 'Maya', isGroup: 0, ts: now });
archiveStatements(db).msg.run(messageRow({ chat: MAYA, id: 'W1', sender: MAYA, ts: now - 300, text: 'the garden fence is finished' }));
const wa = accountFor(db, { source: 'wa', identity: '+15550000000' });
const tg = accountFor(db, { source: 'tg', identity: '777', name: 'personal' });
const q = archiveStatements(db, () => tg);
q.chat.run({ ref: 'tg:222', name: 'Club', isGroup: 1, ts: now });
q.msg.run(messageRow({ chat: 'tg:222', id: 'tg222_1', sender: 'tg:333', ts: now - 200, text: 'the garden party is on Sunday' }));

test('an account is made once for what tells it apart; rows stored before it was known are claimed for it', async () => {
  assert.equal(accountFor(db, { source: 'wa', identity: '+15550000000' }), wa, 'the same one again');
  assert.notEqual(accountFor(db, { source: 'wa', identity: '+15550009999' }), wa, 'another number is another account');
  assert.equal(db.prepare("SELECT account FROM messages WHERE id = 'W1'").pluck().get(), null);
  claimRows(db, wa, (col) => sourceSql(col, 'wa'));
  assert.equal(db.prepare("SELECT account FROM messages WHERE id = 'W1'").pluck().get(), wa);
  assert.equal(db.prepare('SELECT account FROM chats WHERE ref = ?').pluck().get(MAYA), wa);
  assert.equal(db.prepare("SELECT account FROM messages WHERE id = 'tg222_1'").pluck().get(), tg, 'one written on its account stays on it');
  await new Promise((r) => setTimeout(r, 100));
  const { recent } = await import('../src/activity/log.js');
  const seen = recent({ category: 'messages: tg' }).map((e) => e.summary);
  assert.ok(seen.includes(`an account of the owner's seen for the first time: tg account ${tg} (personal)`), 'on the record, once');
  assert.ok(!recent({ category: 'messages: wa' }).some((e) => /\+1555/.test(e.summary)), 'without the number that tells it apart');
});

test('a message says which account it came in on: by name, else by what tells it apart', async () => {
  const r = query.open();
  const found = query.search(r, 'garden');
  assert.deepEqual(found.map((m) => [m.id, m.account]).sort(), [
    ['W1', '+15550000000'],
    ['tg222_1', 'personal'],
  ]);
  assert.equal(query.listChats(r).find((c) => c.ref === 'tg:222').account, 'personal');
  assert.equal(query.messageById('W1').account, '+15550000000');
  r.close();
  await index({ quiet: true });
  assert.deepEqual((await find('garden fence')).map((w) => w.account).sort(), ['+15550000000', 'personal']);
});

test('a hidden account is read nowhere, and shown again when it is not', async () => {
  db.prepare('UPDATE accounts SET hidden = 1 WHERE key = ?').run(wa);
  const r = query.open();
  assert.deepEqual(
    query.search(r, 'garden').map((m) => m.id),
    ['tg222_1'],
  );
  assert.ok(!query.listChats(r).some((c) => c.ref === MAYA), 'nor in the chats');
  assert.throws(() => query.thread(r, 'Maya'), /No chat matches/, 'nor its thread');
  assert.equal(query.stats(r, 'wa').messages, 0, 'nor in the totals');
  assert.equal(query.messageById('W1'), null);
  r.close();
  assert.deepEqual(
    (await find('garden fence')).map((w) => w.source),
    ['tg'],
    'nor by meaning',
  );
  assert.equal(db.prepare("SELECT COUNT(*) FROM messages WHERE id = 'W1'").pluck().get(), 1, 'and nothing of it is deleted');
  db.prepare('UPDATE accounts SET hidden = 0 WHERE key = ?').run(wa);
  const again = query.open();
  assert.equal(query.search(again, 'garden').length, 2);
  again.close();
});

test("an index from before WhatsApp's ids were marked names its chats as the archive does, once opened to be kept up to date", async () => {
  const { openSqlite } = await import('../src/db.js');
  const { INDEX_DB } = await import('../src/archive/semantic.js');
  const ix = openSqlite(INDEX_DB);
  ix.prepare('UPDATE windows SET chat_ref = ? WHERE chat_ref = ? ').run(MAYA.slice(3), MAYA);
  ix.prepare("DELETE FROM meta WHERE key = 'refs'").run();
  ix.close();
  // Read as it is, before anything writes to it: still found, under the archive's name.
  assert.ok((await find('garden fence')).some((w) => w.chat === 'Maya'));
  // And kept: the run that brings it up to date does not take its windows for gone.
  const r = await index({ quiet: true });
  assert.equal(r.embedded, 0, 'nothing worked out again');
  const after = openSqlite(INDEX_DB, { readonly: true });
  assert.equal(after.prepare('SELECT COUNT(*) FROM windows WHERE chat_ref = ?').pluck().get(MAYA), 1);
  after.close();
});
