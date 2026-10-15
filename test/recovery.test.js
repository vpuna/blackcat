// Going through a source's last days again: the service's side, the same for every source
// (src/archive/recovery.js). What a command left is done one at a time, and how it ended is said.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { home } from './helpers.js';

const dir = home();
const { openSqlite } = await import('../src/db.js');
const { serveRecovery, workTable } = await import('../src/archive/recovery.js');
const { recent } = await import('../src/activity/log.js');

const db = openSqlite(path.join(dir, 'work.db'));
db.exec(workTable('x_work'));
const add = (status, args = { days: 7 }, created = Math.floor(Date.now() / 1000)) =>
  db
    .prepare('INSERT INTO x_work (kind, args, status, created_ts) VALUES (?, ?, ?, ?)')
    .run('recover', JSON.stringify(args), status, created).lastInsertRowid;
const row = (id) => db.prepare('SELECT * FROM x_work WHERE id = ?').get(id);

test('what was going when the service stopped is said to have stopped; what is left is done, one at a time, when it can be', async () => {
  const cut = add('running');
  let ready = false;
  let release;
  const calls = [];
  const said = [];
  const serve = serveRecovery({
    db,
    table: 'x_work',
    source: 'x',
    label: 'Example',
    log: (l) => said.push(l),
    ready: () => ready,
    recover: async (args, progress) => {
      calls.push(args);
      progress({ looked: 1, chats: 2, recovered: 0 });
      await new Promise((r) => (release = r));
      return { recovered: 3, looked: 2, chats: 2 };
    },
  });
  assert.deepEqual([row(cut).status, row(cut).result], ['error', 'the Example service was restarted before it finished']);
  const id = add('pending', { days: 7, chats: null });
  await serve();
  assert.equal(row(id).status, 'pending', 'not while it cannot');
  ready = true;
  const first = serve();
  await new Promise((r) => setImmediate(r));
  assert.equal(row(id).status, 'running');
  assert.deepEqual(JSON.parse(row(id).progress), { looked: 1, chats: 2, recovered: 0 });
  await serve(); // one at a time: a second call while it goes does nothing
  assert.equal(calls.length, 1);
  release();
  await first;
  assert.equal(row(id).status, 'done');
  assert.deepEqual(JSON.parse(row(id).result), { recovered: 3, looked: 2, chats: 2 });
  assert.deepEqual(calls, [{ days: 7, chats: null }]);
  assert.match(said.at(-1), /^recovered: 3 messages that were missing, in 2 chats looked at$/);
  assert.equal(recent({ category: 'messages: x' })[0].summary, 'recovered 3 that were missing, in 2 chats looked at');
});

test('a failure is kept with why; work of a kind not known is refused; old work is let go', async () => {
  const old = add('done', {}, Math.floor(Date.now() / 1000) - 8 * 86400);
  const serve = serveRecovery({
    db,
    table: 'x_work',
    source: 'x',
    label: 'Example',
    recover: async () => {
      throw new Error('the phone did not answer');
    },
  });
  const id = add('pending');
  await serve();
  assert.deepEqual([row(id).status, row(id).result], ['error', 'the phone did not answer']);
  assert.equal(row(old), undefined, 'work done more than a week ago is gone');
  const odd = db.prepare("INSERT INTO x_work (kind, created_ts) VALUES ('rebuild', ?)").run(Math.floor(Date.now() / 1000)).lastInsertRowid;
  await serve();
  assert.deepEqual([row(odd).status, row(odd).result], ['error', 'work of a kind not known here: rebuild']);
});
