// An undated entry a watch filed moves to Expired once no message has spoken of it for as long
// as its source's history is fetched: the days the owner chose as worth reading (asked for
// 2026-10-28: one watch had 72 undated entries, 37 over three weeks old). Nothing is
// deleted: a list shows them in a section of their own, by type, a page at a time.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { home } from './helpers.js';

const dir = home();
// Two made-up sources: one fetched 30 days back, one 180.
for (const [name, id, label, days] of [
  ['chatter', 'cht', 'Chatter', 30],
  ['post', 'pst', 'Post', 180],
]) {
  fs.mkdirSync(path.join(dir, `user-plugins/${name}`), { recursive: true });
  fs.writeFileSync(
    path.join(dir, `user-plugins/${name}/plugin.js`),
    `export default { api: 1, name: '${name}', title: '${label}', description: 'x',
  commands: { hello: { summary: 'x', access: 'allow', run: () => 'x' } },
  source: { id: '${id}', label: '${label}', connected: () => true, historyDays: () => ${days} } };\n`,
  );
}
const { save } = await import('../src/config.js');
save({ plugins: { enabled: ['chatter', 'post'] } });
await (await import('../src/plugins/registry.js')).loadPlugins();
const wdb = await import('../src/watch/db.js');
const { listMessage, expiredMessage, typeMenu } = await import('../src/lists/chat.js');

const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);
const db = wdb.openWatchDb();
const l = wdb.addList(db, 'From a friend');
const put = (title, extra = {}) =>
  wdb.getItem(db, Number(wdb.addItem(db, { listId: l.id, title, createdTs: now() - 60 * DAY, ...extra }).lastInsertRowid ?? 0)) ??
  db.prepare('SELECT * FROM watch_items WHERE title = ?').get(title);
const status = (title) => db.prepare('SELECT status FROM watch_items WHERE title = ?').pluck().get(title);

test('undated and not spoken of for longer than its source keeps: expired; the rest stays', () => {
  put('Old cafe', { category: 'cafe', msgId: 'cht:1', msgTs: now() - 40 * DAY });
  put('Old notice', { category: 'notice', msgId: 'cht:2', msgTs: now() - 31 * DAY });
  put('Recent cafe', { category: 'cafe', msgId: 'cht:3', msgTs: now() - 10 * DAY });
  put('Old mail', { category: 'notice', msgId: 'pst:1', msgTs: now() - 40 * DAY });
  put('Older mail', { category: 'notice', msgId: 'pst:2', msgTs: now() - 200 * DAY });
  put('Dated, coming', { msgId: 'cht:4', msgTs: now() - 40 * DAY, eventDate: '2099-01-01' });
  put('Added by hand', { createdTs: now() - 400 * DAY });
  put('Linked lately', { msgId: 'cht:5', msgTs: now() - 40 * DAY });
  const linked = db.prepare("SELECT id FROM watch_items WHERE title = 'Linked lately'").pluck().get();
  wdb.linkMessage(db, linked, { id: 'cht:9', ts: now() - DAY });
  wdb.expirePast(db, l.id);
  assert.deepEqual(
    ['Old cafe', 'Old notice', 'Recent cafe', 'Old mail', 'Older mail', 'Dated, coming', 'Added by hand', 'Linked lately'].map(status),
    ['expired', 'expired', 'new', 'new', 'expired', 'new', 'new', 'new'],
  );
});

test('spoken of again, or kept by the owner: back, and its days start again', () => {
  const id = db.prepare("SELECT id FROM watch_items WHERE title = 'Old cafe'").pluck().get();
  wdb.spokenOf(db, id, now());
  assert.equal(status('Old cafe'), 'kept');
  wdb.expirePast(db, l.id);
  assert.equal(status('Old cafe'), 'kept', 'not lapsed again at once');
  const notice = db.prepare("SELECT id FROM watch_items WHERE title = 'Old notice'").pluck().get();
  wdb.setItemStatus(db, notice, 'kept');
  wdb.expirePast(db, l.id);
  assert.equal(status('Old notice'), 'kept');
  // (And back as they were, for what follows.)
  db.prepare("UPDATE watch_items SET status = 'expired', mentioned_ts = NULL WHERE title IN ('Old cafe', 'Old notice')").run();
});

test('the list shows its open entries, then a line for what expired, with the days of each source', () => {
  // (Expired for something else, a to-do nudged long ago and never ticked off, while its
  // message is recent: not among those older than the days the section says.)
  put('Nudged long ago', { msgId: 'cht:7', msgTs: now() - 5 * DAY, status: 'expired' });
  db.prepare("UPDATE watch_items SET status = 'expired' WHERE title = 'Nudged long ago'").run();
  const m = listMessage(db, l);
  assert.match(m.text, /\n⌛ Expired · older than 30 days \(Chatter\) or 180 days \(Post\) \(3\)/);
  assert.ok(m.actions.rows.flat().some((b) => b.id === `lx:${l.id}:0` && /Expired · 3/.test(b.label)));
  wdb.addItem(db, { listId: l.id, title: 'Other kind', category: 'show', createdTs: now(), msgId: 'cht:6', msgTs: now() });
  assert.ok(
    typeMenu(db, l)
      .actions.rows.flat()
      .some((b) => b.id === `lx:${l.id}:0`),
    'and a button beside the types',
  );
});

test('what expired, by type, a page at a time, each a tap from open again', () => {
  for (let i = 0; i < 30; i++)
    wdb.addItem(db, { listId: l.id, title: `Wish ${i}`, category: 'wish', createdTs: now(), msgId: `cht:w${i}`, msgTs: now() - 50 * DAY });
  wdb.expirePast(db, l.id);
  const first = expiredMessage(db, l, 0);
  assert.match(first.text, /⌛ Expired · older than 30 days \(Chatter\) or 180 days \(Post\) \(33\)/);
  assert.match(first.text, /<b>cafe<\/b>\n1\. Old cafe\n\n<b>notice<\/b>\n2\. Old notice\n3\. Older mail\n\n<b>wish<\/b>\n4\. Wish/);
  const more = first.actions.rows.flat().find((b) => b.id === `lx:${l.id}:1`);
  assert.match(more.label, /More ▸ \(8\)/);
  const second = expiredMessage(db, l, 1);
  assert.match(second.text, /\n26\. Wish/);
  assert.ok(!second.actions.rows.flat().some((b) => /More/.test(b.label)), 'the last page has no More');
  assert.ok(second.actions.rows.flat().every((b) => /^wi:\d+:o$/.test(b.id)));
});

test('bc list show says what expired; --status expired shows them; a watch says it when it is made', () => {
  const root = new URL('..', import.meta.url).pathname;
  const bc = (...a) => spawnSync(process.execPath, [`${root}bin/bc.js`, ...a], { encoding: 'utf8', env: process.env });
  assert.match(bc('list', 'show', String(l.id)).stdout, /⌛ Expired · older than .* \(33\): bc list show \d+ --status expired/);
  assert.match(bc('list', 'show', String(l.id), '--status', 'expired').stdout, /Old cafe/);
  assert.equal(
    wdb.keptSaid(['cht:friend', 'pst:me']),
    '30 days (the history you keep for Chatter), or 180 days (the history you keep for Post) after the last message about them',
  );
  assert.equal(wdb.keptSaid(['xyz:1']), null);
});
