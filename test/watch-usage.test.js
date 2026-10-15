// A look uses the owner's Claude plan, so it must cost nothing when there is nothing new to
// read. Here "claude" is a stand-in that counts how often it is called.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { home, setUp } from './helpers.js';

const dir = home();
const calls = path.join(dir, 'claude-calls');
process.env.FAKE_READER_LOG = calls; // (the usual stand-in for `claude` notes each call there)
const count = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).length : 0);

await setUp({ bot: { allow: [{ id: 42, name: 'me' }] } });
const { openWrite } = await import('../src/archive/db.js');
const { openWatchDb, addWatch, getWatch, listWatches, updateWatch, TODO } = await import('../src/watch/db.js');
const { collect } = await import('../src/watch/collect.js');

const wa = openWrite();
wa.prepare(
  "INSERT INTO chats (ref, name, is_group) VALUES ('111@s.whatsapp.net', 'Maya', 0), ('222@s.whatsapp.net', 'Someone else', 0)",
).run();
let n = 0;
const say = (chat, text) =>
  wa
    .prepare("INSERT INTO messages (chat_ref, id, sender_ref, from_me, ts, type, text) VALUES (?, ?, ?, 0, ?, 'text', ?)")
    .run(chat, `M${++n}`, chat, Math.floor(Date.now() / 1000) - 60 + n, text);

test('a watch over a chat calls Claude only when that chat has something it has not read', async () => {
  const db = openWatchDb();
  const w = addWatch(db, {
    chatId: 42,
    name: 'From Maya',
    lookFor: 'things to do',
    sources: { chats: [{ ref: '111@s.whatsapp.net', name: 'Maya' }] },
    mode: 'briefing',
  });
  assert.equal((await collect(db, w)).looked, 0);
  assert.equal(count(), 0, 'an empty chat costs nothing');

  say('222@s.whatsapp.net', 'this is in a chat the watch does not cover');
  assert.equal((await collect(db, getWatch(db, w.id))).looked, 0);
  assert.equal(count(), 0, 'a message somewhere else costs nothing');

  say('111@s.whatsapp.net', 'there is a concert on Saturday');
  assert.equal((await collect(db, getWatch(db, w.id))).looked, 1);
  assert.equal(count(), 1, 'one new message: one call');

  for (let i = 0; i < 5; i++) assert.equal((await collect(db, getWatch(db, w.id))).looked, 0);
  assert.equal(count(), 1, 'looking again, with nothing new, costs nothing');

  say('111@s.whatsapp.net', 'and a market on Sunday');
  say('111@s.whatsapp.net', 'both near the marina');
  assert.equal((await collect(db, getWatch(db, w.id))).looked, 2);
  assert.equal(count(), 2, 'several new messages are read together, in one call');
  db.close();
});

test('"Things I need to do" calls a model only when a message has arrived since it last looked', async () => {
  const db = openWatchDb();
  const todo = listWatches(db).find((w) => w.builtin === TODO);
  updateWatch(db, todo.id, { active: 1, sources: { everywhere: 'all', mine: true, calendar: false } });
  const before = count();
  const first = await collect(db, getWatch(db, todo.id));
  assert.ok(first.looked > 0);
  assert.equal(count(), before + 1, 'the first look reads what is there, in one call');
  for (let i = 0; i < 5; i++) assert.equal((await collect(db, getWatch(db, todo.id))).looked, 0);
  assert.equal(count(), before + 1, 'looking again, with nothing new, costs nothing');
  say('222@s.whatsapp.net', 'can you call me back tomorrow?');
  assert.equal((await collect(db, getWatch(db, todo.id))).looked, 1);
  assert.equal(count(), before + 2);
  db.close();
});

test('a check with plain rules never calls a model', async () => {
  const { addCheck, getCheck, openChecksDb } = await import('../src/checks/db.js');
  const { runCheck } = await import('../src/checks/check.js');
  const db = openChecksDb();
  const before = count();
  const c = addCheck(db, { chatId: 42, name: 'Always fine', command: 'true' });
  for (let i = 0; i < 3; i++) assert.equal((await runCheck(db, getCheck(db, c.id))).result.ok, true);
  assert.equal(count(), before);
  db.close();
  wa.close();
});
