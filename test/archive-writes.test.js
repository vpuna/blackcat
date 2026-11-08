// What is kept of messages is written by the archive's writer alone: a source (a plugin) adds,
// changes and forgets what it keeps through it, never with SQL of its own on the archive's
// tables. So the archive's shape can change without a plugin falling over unnoticed.
// (A6 of the audit of 2026-10-24.)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { codeFiles, home } from './helpers.js';

home();
const root = new URL('..', import.meta.url).pathname;
const TABLES = ['messages', 'chats', 'contacts', 'media', 'chat_info', 'aliases', 'link_thumbs', 'raw'];

test("no plugin, and nothing in the core outside the archive, writes the archive's tables itself", () => {
  const wrong = [];
  for (const f of codeFiles('src', 'plugins').filter((x) => x.endsWith('.js') && !x.startsWith('src/archive/'))) {
    const text = fs.readFileSync(path.join(root, f), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    for (const t of TABLES)
      if (new RegExp(`(INSERT( OR \\w+)? INTO|UPDATE( OR \\w+)?|DELETE FROM)\\s+${t}\\b`).test(text)) wrong.push(`${f} writes ${t}`);
  }
  assert.deepEqual(wrong, []);
});

test('a source forgets all it kept, and only its own; a chat known by two names becomes one', async () => {
  await (await import('../src/plugins/registry.js')).loadPlugins(); // (the sources are the plugins')
  const { openWrite } = await import('../src/archive/db.js');
  const { archiveStatements, messageRow, sourceChanges } = await import('../src/archive/writer.js');
  const db = openWrite();
  const q = archiveStatements(db);
  q.chat.run({ ref: 'wa:1@lid', name: 'Maya', isGroup: 0, ts: 1 });
  q.msg.run(messageRow({ chat: 'wa:1@lid', id: 'A', sender: 'wa:1@lid', ts: 1, text: 'hi' }));
  q.chat.run({ ref: 'tg:5', name: 'Sam', isGroup: 0, ts: 1 });
  q.msg.run(messageRow({ chat: 'tg:5', id: 'B', ts: 1, text: 'hello' }));
  sourceChanges(db).sameAs('wa:1@lid', 'wa:1@s.whatsapp.net');
  const row = db.prepare("SELECT chat_ref, sender_ref FROM messages WHERE id = 'A'").get();
  assert.deepEqual(row, { chat_ref: 'wa:1@s.whatsapp.net', sender_ref: 'wa:1@s.whatsapp.net' });
  assert.equal(db.prepare("SELECT name FROM chats WHERE ref = 'wa:1@s.whatsapp.net'").pluck().get(), 'Maya');
  assert.equal(db.prepare("SELECT COUNT(*) FROM chats WHERE ref = 'wa:1@lid'").pluck().get(), 0);
  assert.equal(sourceChanges(db).forget('wa'), 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM messages WHERE chat_ref LIKE 'wa:%'").pluck().get(), 0);
  assert.equal(db.prepare('SELECT COUNT(*) FROM aliases').pluck().get(), 0);
  assert.equal(db.prepare("SELECT COUNT(*) FROM messages WHERE chat_ref = 'tg:5'").pluck().get(), 1, "another source's are kept");
  db.close();
});

test("the engine check's made-up messages go in through the writer, as a source's would", async () => {
  const sample = await import('../src/engines/check/sample.js');
  const n = sample.load('PLANTED');
  const { openRead } = await import('../src/archive/db.js');
  const db = openRead();
  assert.equal(db.prepare("SELECT COUNT(*) FROM messages WHERE id LIKE 'CHECK%'").pluck().get(), n);
  assert.equal(db.prepare('SELECT name FROM chats WHERE ref = ?').pluck().get(sample.PEOPLE.school), 'School parents');
  assert.equal(db.prepare("SELECT COUNT(*) FROM messages WHERE text = 'PLANTED'").pluck().get(), 1);
  db.close();
});
