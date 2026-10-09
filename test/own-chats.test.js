// A chat that is blackcat itself (its bot, as the owner's own account sees it) is never
// collected: the agent would read its own replies and react to them. The channel says
// which chats those are; the archive's writer leaves them out for every source, and the
// Telegram source does not offer them. No source reads a channel plugin's settings.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { home } from './helpers.js';

const dir = home();
const root = new URL('..', import.meta.url).pathname;
// a second channel, to show nothing here is about Telegram
fs.mkdirSync(path.join(dir, 'user-plugins/pager'), { recursive: true });
fs.writeFileSync(
  path.join(dir, 'user-plugins/pager/plugin.js'),
  `export default { api: 1, name: 'pager', title: 'Pager', description: 'x', commands: { hello: { summary: 'x', access: 'allow', run: () => 'x' } },
  channel: { label: 'Pager', paired: () => false, open: async () => ({}), start: async () => ({}), self: (ctx) => (ctx.config.get().number ? ['sms:' + ctx.config.get().number, null, 7] : []) } };\n`,
);
fs.mkdirSync(path.join(dir, 'user-plugins/moody'), { recursive: true });
fs.writeFileSync(
  path.join(dir, 'user-plugins/moody/plugin.js'),
  `export default { api: 1, name: 'moody', title: 'Moody', description: 'x', commands: { hello: { summary: 'x', access: 'allow', run: () => 'x' } },
  channel: { label: 'Moody', paired: () => false, open: async () => ({}), start: async () => ({}), self: () => { throw new Error('not today'); } } };\n`,
);
const { save, update } = await import('../src/config.js');
save({ plugins: { enabled: ['pager', 'moody'], settings: { 'tg-bot': { botId: 4242 }, pager: { number: '555' } } } });
const { loadPlugins } = await import('../src/plugins/registry.js');
await loadPlugins();
const { ownRefs, forgetOwnRefs } = await import('../src/channels/registry.js');

test('every channel that is set up says which chats are blackcat itself; one that cannot say names none', () => {
  assert.deepEqual(ownRefs().sort(), ['sms:555', 'tg:4242']);
  update((c) => {
    delete c.plugins.settings['tg-bot'].botId;
  });
  forgetOwnRefs();
  assert.deepEqual(ownRefs(), ['sms:555'], 'no bot paired: nothing of Telegram to leave out');
  update((c) => {
    c.plugins.settings['tg-bot'].botId = 4242;
  });
  forgetOwnRefs();
});

test("the archive's writer leaves those chats out, whatever source is writing: the chat, and every message in it", async () => {
  const { openArchiveForWriting, archiveStatements, messageRow } = await import('../src/api.js');
  const { withDb } = await import('../src/db.js');
  withDb(openArchiveForWriting, (db) => {
    const q = archiveStatements(db);
    for (const ref of ['tg:4242', 'sms:555', 'tg:99']) {
      q.chat.run({ ref, name: `chat ${ref}`, isGroup: 0, ts: 1700000000 });
      q.msg.run(messageRow({ chat: ref, id: `${ref}:1`, ts: 1700000000, text: 'your reminder: call the bank' }));
      q.msgFill.run(messageRow({ chat: ref, id: `${ref}:2`, ts: 1700000001, text: 'done' }));
    }
    assert.deepEqual(db.prepare('SELECT ref FROM chats').pluck().all(), ['tg:99']);
    assert.deepEqual(db.prepare('SELECT id FROM messages ORDER BY id').pluck().all(), ['tg:99:1', 'tg:99:2']);
    const kept = q.msg.run(messageRow({ chat: 'tg:99', id: 'tg:99:3', ts: 1700000002, text: 'x' }));
    assert.equal(kept.changes, 1);
    assert.ok(kept.lastInsertRowid > 0, 'what is written says so as before');
    assert.deepEqual(q.msg.run(messageRow({ chat: 'tg:4242', id: 'x', ts: 1, text: 'x' })), { changes: 0, lastInsertRowid: 0 });
  });
});

test('the Telegram source never keeps or offers the bot, and asks the core, not the bot plugin', async () => {
  const { wanted, isOwn } = await import('../plugins/tg/paired.js');
  assert.equal(isOwn('tg:4242'), true);
  assert.equal(wanted('tg:4242', 'bot', 0, { mode: 'selected', chats: ['tg:4242'] }), false, 'not even when picked');
  assert.equal(wanted('tg:99', 'user', 0, { mode: 'all' }), true);
  for (const f of fs.readdirSync(`${root}plugins/tg`).filter((n) => n.endsWith('.js'))) {
    assert.doesNotMatch(
      fs.readFileSync(`${root}plugins/tg/${f}`, 'utf8'),
      /tg-bot|botId/,
      `plugins/tg/${f} knows nothing of the bot plugin`,
    );
  }
});

test('self is checked like any other key: a function that answers at once', async () => {
  const { problems } = await import('../src/plugins/registry.js');
  const base = {
    api: 1,
    name: 'demo',
    title: 'Demo',
    description: 'x',
    commands: { go: { summary: 'x', access: 'allow', run: () => 'x' } },
    channel: { paired: () => true, open: async () => ({}), start: async () => ({}) },
  };
  assert.deepEqual(problems({ ...base, channel: { ...base.channel, self: () => ['x:1'] } }, 'demo'), []);
  assert.match(
    problems({ ...base, channel: { ...base.channel, self: async () => ['x:1'] } }, 'demo').join('; '),
    /channel\.self must be a function that answers at once/,
  );
});
