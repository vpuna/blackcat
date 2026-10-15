// The point of the source interface: a plugin nobody has heard of can add a new kind of
// message to the archive, and search, watches and file fetching treat it like the built-in
// ones, with no change to blackcat itself. This plugin, written here, adds "sms".
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { home } from './helpers.js';

const dir = home();
const root = new URL('..', import.meta.url).pathname;
fs.mkdirSync(path.join(dir, 'user-plugins/sms'), { recursive: true });
fs.writeFileSync(
  path.join(dir, 'user-plugins/sms/plugin.js'),
  `
import fs from 'node:fs';
export default {
  api: 1, name: 'sms', title: 'Text messages', description: 'a test source',
  commands: { hello: { summary: 'says hello', access: 'allow', run: () => 'hello' } },
  source: {
    id: 'sms', label: 'Text messages', optIn: true, textLimit: 50, todoLimit: 60, todoText: 'text messages',
    todoQuestion: 'Also look at your text messages?',
    connected: (ctx) => ctx.config.get().on === true,
    fetchMedia: async (ctx, { row, dest, id }) => { fs.writeFileSync(dest, 'file for ' + id + ' part ' + row.direct_path); },
  },
};
`,
);
const { save } = await import('../src/config.js');
const bundled = fs.readdirSync(`${root}plugins`).filter((n) => !['watch', 'remind', 'claude-code'].includes(n));
save({ plugins: { enabled: ['sms'], disabled: bundled, settings: { sms: { on: true } } } });
const { loadPlugins } = await import('../src/plugins/registry.js');
const plugins = await loadPlugins();
const sources = await import('../src/archive/sources.js');
const { archiveStatements, mediaRow, messageRow } = await import('../src/archive/writer.js');
const db = await import('../src/archive/db.js');
const now = Math.floor(Date.now() / 1000);

// What the plugin's own source would do: write through the shared statements.
const wa = db.openWrite();
const q = archiveStatements(wa);
q.chat.run({ ref: 'sms:+15550001', name: 'Bank alerts', isGroup: 0, ts: now });
q.contact.run({ ref: 'sms:+15550001', name: 'Bank alerts', notify: null, phone: '+15550001' });
q.msg.run(
  messageRow({
    chat: 'sms:+15550001',
    id: 'sms:1',
    sender: 'sms:+15550001',
    ts: now - 30,
    text: `Your card payment of 250 is due on Friday. ${'x'.repeat(200)}`,
  }),
);
const withFile = q.msg.run(
  messageRow({ chat: 'sms:+15550001', id: 'sms:2', sender: 'sms:+15550001', ts: now - 20, type: 'image', text: 'a picture' }),
);
q.media.run(
  mediaRow({ rowid: withFile.lastInsertRowid, dlType: 'sms', mimetype: 'image/png', size: 10, fileName: 'pic.png', directPath: 'part-7' }),
);
q.chat.run({ ref: '15551234@s.whatsapp.net', name: 'Maya', isGroup: 0, ts: now });
q.msg.run(
  messageRow({ chat: '15551234@s.whatsapp.net', id: 'WA1', sender: '15551234@s.whatsapp.net', ts: now - 10, text: 'see you Friday' }),
);
wa.close();

test('the plugin loads and its source is known everywhere', () => {
  assert.ok(plugins.some((p) => p.name === 'sms'));
  assert.equal(db.SOURCES.sms, 'Text messages');
  assert.equal(db.sourceOf('sms:+15550001'), 'sms');
  assert.equal(db.msgSource('sms:1'), 'sms');
  assert.equal(sources.source('sms').optIn, true);
});

test('searching by source separates it from WhatsApp', () => {
  const d = db.openRead();
  const n = (s) =>
    d.prepare(`SELECT COUNT(*) AS n FROM messages m WHERE text LIKE '%Friday%' AND ${db.sourceSql('m.chat_ref', s)}`).get().n;
  assert.deepEqual([n('sms'), n('wa'), n('tg'), n(null)], [1, 1, 0, 2]);
  d.close();
});

test('a watch on "all chats" leaves it out, one that names its chat reads it, and the to-do watch reads it unless told not to', async () => {
  const wdb = await import('../src/watch/db.js');
  const { collect } = await import('../src/watch/collect.js');
  const { connected, reads } = await import('../src/watch/agenda.js');
  assert.equal(connected().sms, true);
  const w = wdb.openWatchDb();
  const looked = async (watch) => (await collect(w, watch, { dryRun: true })).looked;
  const make = (name, s) =>
    wdb.addWatch(w, {
      chatId: 0,
      name,
      lookFor: 'anything',
      sources: s,
      mode: 'briefing',
      days: [0, 1, 2, 3, 4, 5, 6],
      at: '07:00',
      lastRowid: 0,
    });
  assert.equal(await looked(make('Everything', { everywhere: 'all' })), 1, 'only the WhatsApp message');
  const todo = wdb.findWatch(w, 'todo');
  assert.equal(reads(todo).sms, true);
  assert.equal(await looked(todo), 2, 'the WhatsApp message and the text message');
  wdb.updateWatch(w, todo.id, { sources: { ...todo.sources, sms: false } });
  assert.equal(await looked(wdb.findWatch(w, 'todo')), 1, 'without it, the WhatsApp message only');
  wdb.updateWatch(w, todo.id, { sources: todo.sources });
  // A watch that names the chat reads all of it, and the to-do watch then leaves that chat to it.
  assert.equal(
    await looked(make('Bank', { chats: [{ ref: 'sms:+15550001', name: 'Bank alerts', sender: null }] })),
    2,
    'both of its messages',
  );
  assert.equal(await looked(wdb.findWatch(w, 'todo')), 1, 'the chat now belongs to the other watch');
  w.close();
});

test('its files are fetched by asking the plugin', async () => {
  const { fetchMedia } = await import('../src/archive/media.js');
  const d = db.openRead();
  const got = await fetchMedia(d, 'sms:2');
  d.close();
  assert.equal(got.source, 'download');
  assert.equal(fs.readFileSync(got.path, 'utf8'), 'file for sms:2 part part-7');
  assert.equal(path.basename(got.path), 'pic.png');
});

test('the to-do watch can be told to leave it out or take it back, and its setup asks about it', async () => {
  const { spawnSync } = await import('node:child_process');
  const bc = (...a) => spawnSync(process.execPath, [`${root}bin/bc.js`, ...a], { encoding: 'utf8', env: process.env });
  assert.match(bc('watch', 'setup', '--help').stdout, /--sms\s+Also look at your text messages\?/);
  assert.match(bc('watch', 'edit', 'todo', '--with', 'sms').stdout, /text messages \(except what another watch reads\)/);
  assert.doesNotMatch(bc('watch', 'edit', 'todo', '--without', 'sms').stdout, /text messages/);
  assert.match(bc('watch', 'edit', 'todo', '--with', 'nonsense').stderr, /not something it can cover/);
  assert.match(bc('msg', 'chats', '--source', 'sms').stdout, /Bank alerts/);
});

test('a source id that clashes with a built-in one, or is malformed, is refused', () => {
  assert.throws(() => sources.registerSource({ id: 'wa', label: 'x' }), /own sources/);
  assert.throws(() => sources.registerSource({ id: 'Bad Id', label: 'x' }), /short lowercase word/);
});
