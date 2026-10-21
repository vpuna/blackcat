// Going through a source's days of history again: the service's side, the same for every source
// (src/archive/recovery.js). What a command left is done one at a time, and how it ended is said;
// to the owner too, for work nobody stayed to see end.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { home, setUp } from './helpers.js';

const dir = home();
await setUp({ channel: 'tg-bot', plugins: { settings: { 'tg-bot': { owner: { chat: 42, name: 'Owner' } } } } });
const sent = [];
const { resetDesk, setCarrier } = await import('../src/channels/desk.js');
resetDesk();
setCarrier({ can: { edit: true }, label: 'a test', send: async (chat, m) => (sent.push(m.text), 1), edit: async () => {} });
const { openSqlite } = await import('../src/db.js');
const { leaveWork, recoverCommand, serveRecovery, workTable } = await import('../src/archive/recovery.js');
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

test('work left from outside a command, or that a command stopped waiting for, is sent to the owner as it ends', async () => {
  db.prepare('DELETE FROM x_work').run();
  sent.length = 0;
  const id = leaveWork(db, 'x_work', { days: 180, chats: null });
  assert.equal(leaveWork(db, 'x_work', { days: 180, chats: null }), id, 'one already waiting is that one');
  let fail = false;
  const serve = serveRecovery({
    db,
    table: 'x_work',
    source: 'x',
    label: 'Example',
    say: (r, args) => `went through ${args.days} days: ${r.recovered} found`,
    recover: async (args) => {
      if (fail) throw new Error('the phone did not answer');
      assert.deepEqual(args, { days: 180, chats: null }, 'what the service is given leaves out who asked and the telling');
      return { recovered: 4, looked: 1, chats: 1 };
    },
  });
  await serve();
  assert.deepEqual(sent, ['Example: went through 180 days: 4 found']);
  fail = true;
  leaveWork(db, 'x_work', { days: 180, chats: null });
  await serve();
  assert.match(sent.at(-1), /^Example: fetching history stopped: the phone did not answer\. Try again: bc x recover$/);
  // Work a command waited to see end is not sent as well.
  fail = false;
  sent.length = 0;
  add('pending', { days: 7 });
  await serve();
  assert.deepEqual(sent, []);
});

test('the command goes through the days the source fetches: how far back is never asked for', async () => {
  const fs = await import('node:fs');
  const { DB_PATH, openWrite, setMeta } = await import('../src/archive/db.js');
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const a = openWrite();
  setMeta(a, { x_state: 'connected' });
  a.close();
  db.prepare('DELETE FROM x_work').run();
  process.env.BLACKCAT_RECOVER_WAIT_S = '0.5';
  const ctx = { fail: (m) => assert.fail(m) };
  const r = await recoverCommand(
    ctx,
    { since: '400d' },
    {
      source: 'x',
      label: 'Example',
      linked: () => true,
      keptDays: 180,
      stateKey: 'x_state',
      open: () => openSqlite(path.join(dir, 'work.db')),
      table: 'x_work',
      head: (d) => `${d} days`,
    },
  );
  assert.match(r.text, /^Still going: .* It carries on by itself, and you are sent how it ended\.$/);
  const left = db
    .prepare('SELECT args FROM x_work')
    .pluck()
    .all()
    .map((j) => JSON.parse(j));
  assert.equal(left.length, 1);
  assert.equal(left[0].days, 180, 'the days the source fetches, whatever --since said');
  assert.equal(left[0].tell, true, 'not waited for any longer: its end is sent');
});
