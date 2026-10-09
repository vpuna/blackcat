// How messages get into the archive and how the rest of blackcat tells the sources apart.
// These tests describe the behaviour the sources, watches and the mail plugin rely on.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { after, before, test } from 'node:test';
import { home } from './helpers.js';

home();
const { save } = await import('../src/config.js');
save({
  wa: { days: 30, mode: 'all' },
  tga: { days: 30, mode: 'all' },
  plugins: {
    enabled: ['mail'],
    settings: { mail: { accounts: { personal: { address: 'me@example.com', host: 'imap.example.com', days: 30 } } } },
  },
});
const { loadPlugins } = await import('../src/plugins/registry.js');
await loadPlugins();
const db = await import('../src/archive/db.js');
const now = Math.floor(Date.now() / 1000);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = (sql, ...a) => {
  const d = db.openRead();
  try {
    return d.prepare(sql).all(...a);
  } finally {
    d.close();
  }
};

test('sources are told apart by the start of an id', () => {
  assert.equal(db.sourceOf('15550001234@s.whatsapp.net'), 'wa');
  assert.equal(db.sourceOf('120363000000000000@g.us'), 'wa');
  assert.equal(db.sourceOf('tg:12345'), 'tg');
  assert.equal(db.sourceOf('tg:-100123'), 'tg');
  assert.equal(db.sourceOf('mail:personal'), 'mail');
  assert.equal(db.sourceOf(null), 'wa');
  assert.equal(db.msgSource('3A952BDD381E1F0DA5FF'), 'wa');
  assert.equal(db.msgSource('tg12345_678'), 'tg');
  assert.equal(db.msgSource('tg-100123_9'), 'tg');
  assert.equal(db.msgSource('mail:personal:4812'), 'mail');
  assert.equal(db.msgSource('mail:personal:4812:1'), 'mail');
  assert.deepEqual([db.SOURCES.wa, db.SOURCES.tg, db.SOURCES.mail], ['WhatsApp', 'Telegram', 'Email']);
  assert.throws(() => db.sourceSql('ref', 'nonsense'), /Unknown source/);
});

// ---------- the Telegram source, with a stand-in client ----------
const handlers = [];
const tgClient = {
  getMe: async () => ({ id: 111, firstName: 'Owner' }),
  addEventHandler: (fn, ev) => handlers.push({ fn, kind: ev.constructor.name }),
  getDialogs: async () => [],
  iterDialogs: async function* () {},
  getInputEntity: async (id) => id,
  getMessages: async () => [],
  downloadMedia: async () => null,
  disconnect: async () => {},
  connected: true,
};
const events = {
  NewMessage: class NewMessage {},
  EditedMessage: class EditedMessage {},
  DeletedMessage: class DeletedMessage {},
  Raw: class Raw {},
};
const utils = { strippedPhotoToJpg: (b) => b, getPeerId: (p) => (typeof p === 'object' ? (p.userId ?? p.id) : p) };
const fire = (kind, e) => Promise.all(handlers.filter((h) => h.kind === kind).map((h) => h.fn(e)));
const person = { id: 222, className: 'User', firstName: 'Sam', lastName: 'Lee', username: 'samlee' };
const tgMsg = (id, text, extra = {}) => ({
  id,
  message: text,
  date: now - 60 + id,
  peerId: { userId: 222 },
  senderId: 222,
  out: false,
  getChat: async () => person,
  getSender: async () => person,
  ...extra,
});

let tg;
before(async () => {
  const { startTgService } = await import('../plugins/tg/service.js');
  tg = await startTgService({ client: tgClient, events, utils, log: () => {} });
});
after(async () => tg?.stop());

test('Telegram: a new message is stored with its chat and sender, an edit changes it, a deletion marks it', async () => {
  await fire('NewMessage', { message: tgMsg(1, 'hello from Sam') });
  await fire('NewMessage', { message: tgMsg(2, 'my reply', { out: true, senderId: 111 }) });
  let got = rows(
    "SELECT id, chat_ref, sender_ref, from_me, type, text, edited, deleted FROM messages WHERE chat_ref = 'tg:222' ORDER BY id",
  );
  assert.deepEqual(got, [
    { id: 'tg222_1', chat_ref: 'tg:222', sender_ref: 'tg:222', from_me: 0, type: 'text', text: 'hello from Sam', edited: 0, deleted: 0 },
    { id: 'tg222_2', chat_ref: 'tg:222', sender_ref: null, from_me: 1, type: 'text', text: 'my reply', edited: 0, deleted: 0 },
  ]);
  assert.deepEqual(rows("SELECT name, notify FROM contacts WHERE ref = 'tg:222'"), [{ name: 'Sam Lee', notify: 'samlee' }]);
  assert.equal(rows("SELECT is_group FROM chats WHERE ref = 'tg:222'")[0].is_group, 0);

  await fire('NewMessage', { message: tgMsg(1, 'hello from Sam') }); // the same message again
  assert.equal(rows("SELECT COUNT(*) AS n FROM messages WHERE chat_ref = 'tg:222'")[0].n, 2);

  await fire('EditedMessage', { message: tgMsg(1, 'hello from Sam, edited') });
  got = rows("SELECT text, edited FROM messages WHERE id = 'tg222_1'");
  assert.deepEqual(got, [{ text: 'hello from Sam, edited', edited: 1 }]);

  await fire('DeletedMessage', { deletedIds: [2], peer: { userId: 222 } });
  assert.equal(rows("SELECT deleted FROM messages WHERE id = 'tg222_2'")[0].deleted, 1);
});

// ---------- the WhatsApp source, with a stand-in socket ----------
test('WhatsApp: a new message is stored with its chat and sender; the same one again is not doubled; a deletion marks it', async () => {
  const { startService } = await import('../plugins/wa/service.js');
  const ev = new EventEmitter();
  const sock = {
    ev,
    end: () => {},
    ws: { close: () => {} },
    logout: async () => {},
    groupFetchAllParticipating: async () => ({}),
    user: { id: '15550000000:1@s.whatsapp.net' },
  };
  const c = startService({ socketFactory: () => sock, logLevel: 'silent', log: () => {} });
  await c.ready;
  ev.emit('connection.update', { connection: 'open' });
  const m = (id, text, extra = {}) => ({
    key: { remoteJid: '15550001234@s.whatsapp.net', id, fromMe: false },
    messageTimestamp: now - 30,
    pushName: 'Maya',
    message: { conversation: text },
    ...extra,
  });
  ev.emit('contacts.upsert', [{ id: '15550001234@s.whatsapp.net', name: 'Maya Lopez', notify: 'Maya' }]);
  ev.emit('messages.upsert', { messages: [m('AAA1', 'are we still on for Friday?')], type: 'notify' });
  ev.emit('messages.upsert', { messages: [m('AAA1', 'are we still on for Friday?')], type: 'notify' });
  ev.emit('messages.upsert', {
    messages: [
      {
        key: { remoteJid: '15550001234@s.whatsapp.net', id: 'AAA2', fromMe: true },
        messageTimestamp: now - 20,
        message: { conversation: 'yes!' },
      },
    ],
    type: 'notify',
  });
  await wait(100);
  assert.deepEqual(
    rows("SELECT id, sender_ref, from_me, type, text FROM messages WHERE chat_ref = '15550001234@s.whatsapp.net' ORDER BY id"),
    [
      { id: 'AAA1', sender_ref: '15550001234@s.whatsapp.net', from_me: 0, type: 'text', text: 'are we still on for Friday?' },
      { id: 'AAA2', sender_ref: null, from_me: 1, type: 'text', text: 'yes!' },
    ],
  );
  assert.equal(rows("SELECT name FROM contacts WHERE ref = '15550001234@s.whatsapp.net'")[0].name, 'Maya Lopez');
  ev.emit('messages.delete', { keys: [{ remoteJid: '15550001234@s.whatsapp.net', id: 'AAA1' }] });
  await wait(50);
  assert.equal(rows("SELECT deleted FROM messages WHERE id = 'AAA1'")[0].deleted, 1);
  await c.stop?.();
});

// ---------- mail ----------
test('Mail: kept mail goes in as a chat per account, attachments as messages of their own, and comes out again', async () => {
  const store = await import('../plugins/mail/store.js');
  const mail = {
    uid: 7,
    ts: now - 100,
    from_addr: 'office@school.example',
    from_name: 'School Office',
    subject: 'Trip on Friday',
    from_me: 0,
    files: JSON.stringify([
      { name: 'letter.pdf', part: '2', type: 'application/pdf', size: 1234 },
      { name: 'map.png', part: '3', type: 'image/png', size: 99 },
    ]),
  };
  store.archive('personal', [mail], () => 'Please sign the form.');
  store.archive('personal', [mail], () => 'Please sign the form.'); // twice: nothing is doubled
  const got = rows("SELECT id, sender_ref, type, text FROM messages WHERE chat_ref = 'mail:personal' ORDER BY rowid");
  assert.deepEqual(
    got.map((r) => [r.id, r.type]),
    [
      ['mail:personal:7', 'text'],
      ['mail:personal:7:1', 'document'],
      ['mail:personal:7:2', 'image'],
    ],
  );
  assert.equal(got[0].text, 'Subject: Trip on Friday\n\nPlease sign the form.\n\n[attached: letter.pdf, map.png]');
  assert.equal(got[0].sender_ref, 'mail:office@school.example');
  assert.deepEqual(rows("SELECT name, is_group FROM chats WHERE ref = 'mail:personal'"), [{ name: 'Mail: personal', is_group: 1 }]);
  assert.equal(rows("SELECT name FROM contacts WHERE ref = 'mail:office@school.example'")[0].name, 'School Office <office@school.example>');
  assert.deepEqual(
    rows(
      "SELECT d.dl_type, d.mimetype, d.file_name, d.direct_path FROM media d JOIN messages m ON m.rowid = d.msg_rowid WHERE m.chat_ref = 'mail:personal' ORDER BY m.rowid",
    ),
    [
      { dl_type: 'mail', mimetype: 'application/pdf', file_name: 'letter.pdf', direct_path: '2' },
      { dl_type: 'mail', mimetype: 'image/png', file_name: 'map.png', direct_path: '3' },
    ],
  );
  assert.equal(store.storedText('personal', 7), got[0].text);
  store.unarchive('personal', [7]);
  assert.equal(rows("SELECT COUNT(*) AS n FROM messages WHERE chat_ref = 'mail:personal'")[0].n, 0);
  assert.equal(rows('SELECT COUNT(*) AS n FROM media d WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.rowid = d.msg_rowid)')[0].n, 0);
});

test('searching by source returns that source only', async () => {
  const store = await import('../plugins/mail/store.js');
  store.archive(
    'personal',
    [{ uid: 8, ts: now - 50, from_addr: 'a@b.example', from_name: null, subject: 'Friday dinner', from_me: 0, files: '[]' }],
    () => 'See you Friday.',
  );
  const count = (source) =>
    rows(`SELECT COUNT(*) AS n FROM messages m WHERE text LIKE '%Friday%' AND ${db.sourceSql('m.chat_ref', source)}`)[0].n;
  assert.equal(count('mail'), 1);
  assert.equal(count('wa'), 1);
  assert.equal(count('tg'), 0);
  assert.equal(count(null), 2);
});

// ---------- what a watch reads ----------
test('watches: "all chats" leaves email out; the to-do watch reads kept email unless told not to; a watch that names the account reads it', async () => {
  const wdb = await import('../src/watch/db.js');
  const { collect } = await import('../src/watch/collect.js');
  const store = await import('../plugins/mail/store.js');
  store.archive(
    'personal',
    [
      {
        uid: 9,
        ts: now - 40,
        from_addr: 'boss@work.example',
        from_name: 'Boss',
        subject: 'Can you send the report?',
        from_me: 0,
        files: '[]',
      },
    ],
    () => 'By Monday please.',
  );
  const w = wdb.openWatchDb();
  const todo = wdb.findWatch(w, 'todo');
  assert.equal(todo.active, 1, 'the built-in watch is on from the start');
  const looked = async (watch) => (await collect(w, watch, { dryRun: true })).looked;

  wdb.updateWatch(w, todo.id, { sources: { everywhere: 'all', mine: true, mailSince: now - 3600 } });
  const withMail = await looked(wdb.findWatch(w, 'todo'));
  wdb.updateWatch(w, todo.id, { sources: { everywhere: 'all', mine: true, mail: false } });
  const withoutMail = await looked(wdb.findWatch(w, 'todo'));
  assert.equal(withMail - withoutMail, 2, 'two kept mails are read when email is on, none when it is off');

  const make = (name, sources) =>
    wdb.addWatch(w, {
      chatId: 0,
      name,
      lookFor: 'anything',
      sources,
      mode: 'briefing',
      days: [0, 1, 2, 3, 4, 5, 6],
      at: '07:00',
      lastRowid: 0,
    });
  const everywhere = make('Everything', { everywhere: 'all', mine: true });
  const named = make('Work mail', { chats: [{ ref: 'mail:personal', name: 'Mail: personal', sender: 'work.example' }] });
  const both = make('Two senders', { chats: [{ ref: 'mail:personal', name: 'Mail: personal', sender: 'work.example, b.example' }] });
  assert.equal(await looked(named), 1);
  assert.equal(await looked(both), 2);
  const all = await looked(everywhere);
  assert.equal(all, withoutMail, 'an "all chats" watch sees what the to-do watch sees without email');
  w.close();
});

test('a mail attachment is fetched through the mail plugin, and a failure is reported plainly', async () => {
  const { fetchMedia } = await import('../src/archive/media.js');
  const store = await import('../plugins/mail/store.js');
  store.archive(
    'personal',
    [
      {
        uid: 10,
        ts: now - 30,
        from_addr: 'a@b.example',
        from_name: null,
        subject: 'With a file',
        from_me: 0,
        files: JSON.stringify([{ name: 'x.pdf', part: '2', type: 'application/pdf', size: 10 }]),
      },
    ],
    () => 'see attached',
  );
  const d = db.openRead();
  // No mail server is reachable in a test, so the fetch fails: it must say so, not crash.
  await assert.rejects(fetchMedia(d, 'mail:personal:10:1'), /could not be fetched from the mail server|no thumbnail|mail/i);
  d.close();
});
