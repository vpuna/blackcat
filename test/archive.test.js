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
  assert.equal(db.sourceOf('wa:15550001234@s.whatsapp.net'), 'wa');
  assert.equal(db.sourceOf('wa:120363000000000000@g.us'), 'wa');
  assert.equal(db.sourceOf('tg:12345'), 'tg');
  assert.equal(db.sourceOf('tg:-100123'), 'tg');
  assert.equal(db.sourceOf('mail:personal'), 'mail');
  assert.equal(db.sourceOf(null), null, "an id with no source is nobody's: no source is assumed");
  assert.equal(db.msgSource('3A952BDD381E1F0DA5FF'), 'wa', 'by the shape WhatsApp gives its ids, as its plugin says');
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

test('Telegram: every call is kept as a message, either way: one that went on with how long, one that did not as missed or not answered', async () => {
  const call = (id, action, extra = {}) =>
    tgMsg(id, '', { className: 'MessageService', action: { className: 'MessageActionPhoneCall', ...action }, ...extra });
  const reason = (r) => ({ reason: { className: `PhoneCallDiscardReason${r}` } });
  await fire('NewMessage', { message: call(10, reason('Missed')) });
  await fire('NewMessage', { message: call(11, { video: true, ...reason('Missed') }) });
  await fire('NewMessage', { message: call(12, reason('Missed'), { out: true, senderId: 111 }) });
  await fire('NewMessage', { message: call(13, reason('Busy')) });
  await fire('NewMessage', { message: call(14, { duration: 754, ...reason('Hangup') }) });
  await fire('NewMessage', { message: call(15, { video: true, duration: 40, ...reason('Hangup') }, { out: true, senderId: 111 }) });
  await fire('NewMessage', { message: call(16, { duration: 3900, ...reason('Disconnect') }) });
  assert.deepEqual(rows("SELECT id, from_me, type, text FROM messages WHERE type = 'call' AND chat_ref = 'tg:222' ORDER BY id"), [
    { id: 'tg222_10', from_me: 0, type: 'call', text: 'Missed voice call' },
    { id: 'tg222_11', from_me: 0, type: 'call', text: 'Missed video call' },
    { id: 'tg222_12', from_me: 1, type: 'call', text: 'Voice call, not answered' },
    { id: 'tg222_13', from_me: 0, type: 'call', text: 'Missed voice call' },
    { id: 'tg222_14', from_me: 0, type: 'call', text: 'Voice call, 13 min' },
    { id: 'tg222_15', from_me: 1, type: 'call', text: 'Video call, 40 s' },
    { id: 'tg222_16', from_me: 0, type: 'call', text: 'Voice call, 1 h 5 min' },
  ]);
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
  const said = [];
  const c = startService({ socketFactory: () => sock, logLevel: 'silent', log: (l) => said.push(l) });
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
    rows("SELECT id, sender_ref, from_me, type, text FROM messages WHERE chat_ref = 'wa:15550001234@s.whatsapp.net' ORDER BY id"),
    [
      { id: 'AAA1', sender_ref: 'wa:15550001234@s.whatsapp.net', from_me: 0, type: 'text', text: 'are we still on for Friday?' },
      { id: 'AAA2', sender_ref: null, from_me: 1, type: 'text', text: 'yes!' },
    ],
  );
  assert.equal(rows("SELECT name FROM contacts WHERE ref = 'wa:15550001234@s.whatsapp.net'")[0].name, 'Maya Lopez');
  // On the owner's account it is linked as, by its number; the chat too.
  const [acct] = rows("SELECT key, identity FROM accounts WHERE source = 'wa'");
  assert.equal(acct.identity, '+15550000000');
  assert.deepEqual(
    rows("SELECT DISTINCT account FROM messages WHERE chat_ref = 'wa:15550001234@s.whatsapp.net'").map((r) => r.account),
    [acct.key],
  );
  assert.equal(rows("SELECT account FROM chats WHERE ref = 'wa:15550001234@s.whatsapp.net'")[0].account, acct.key);
  // What a business sends, with buttons under it, is a message like any other; a kind nothing reads is named in the log, once.
  const biz = (id, message) => ({
    key: { remoteJid: '15550009999@s.whatsapp.net', id, fromMe: false },
    messageTimestamp: now - 10,
    message,
  });
  ev.emit('messages.upsert', {
    messages: [
      biz('BBB1', {
        templateMessage: {
          hydratedTemplate: {
            hydratedContentText: 'Your appointment is on Saturday at 08:00',
            hydratedButtons: [{ quickReplyButton: { displayText: 'Confirm' } }],
          },
        },
      }),
      biz('BBB2', { requestPaymentMessage: {} }),
      biz('BBB3', { requestPaymentMessage: {} }),
    ],
    type: 'notify',
  });
  await wait(100);
  assert.deepEqual(rows("SELECT id, type, text FROM messages WHERE chat_ref = 'wa:15550009999@s.whatsapp.net'"), [
    { id: 'BBB1', type: 'text', text: 'Your appointment is on Saturday at 08:00\n[Confirm]' },
  ]);
  assert.deepEqual(
    said.filter((l) => /not kept/.test(l)),
    ['a kind of message that is not kept arrived: requestPaymentMessage'],
  );
  // A call that was not answered comes with no message in it, only a note of what it was.
  ev.emit('messages.upsert', {
    messages: [
      { key: { remoteJid: '15550001234@s.whatsapp.net', id: 'CALL1', fromMe: false }, messageTimestamp: now - 5, messageStubType: 40 },
      { key: { remoteJid: '15550001234@s.whatsapp.net', id: 'CALL2', fromMe: false }, messageTimestamp: now - 4, messageStubType: 41 },
    ],
    type: 'notify',
  });
  await wait(100);
  assert.deepEqual(rows("SELECT id, sender_ref, from_me, type, text FROM messages WHERE id LIKE 'CALL%' ORDER BY id"), [
    { id: 'CALL1', sender_ref: 'wa:15550001234@s.whatsapp.net', from_me: 0, type: 'call', text: 'Missed voice call' },
    { id: 'CALL2', sender_ref: 'wa:15550001234@s.whatsapp.net', from_me: 0, type: 'call', text: 'Missed video call' },
  ]);
  // Calls as they go: put together into one message each when they end, with how long one went on.
  const maya = '15550001234@s.whatsapp.net';
  const me = '15550000000@s.whatsapp.net';
  const call = (id, status, at, extra = {}) =>
    ev.emit('call', [{ id, status, chatId: maya, from: maya, date: new Date(at * 1000), ...extra }]);
  call('IN1', 'offer', now - 900); // to the owner, answered for 12 minutes
  call('IN1', 'accept', now - 890);
  call('IN1', 'terminate', now - 170);
  call('IN2', 'offer', now - 800, { isVideo: true }); // to the owner, turned down
  call('IN2', 'reject', now - 795);
  call('IN3', 'offer', now - 700); // ended with no word of it being answered: not kept
  call('IN3', 'terminate', now - 690);
  call('OUT1', 'offer', now - 600, { from: me }); // made by the owner, answered for 40 s
  call('OUT1', 'accept', now - 590, { from: me });
  call('OUT1', 'terminate', now - 550, { from: me });
  call('OUT2', 'offer', now - 500, { from: me }); // made by the owner, rang out
  call('OUT2', 'timeout', now - 470, { from: me });
  // (Baileys' own notice of the one that rang out says "missed": not of the owner's call.)
  ev.emit('messages.upsert', {
    messages: [{ key: { remoteJid: maya, id: 'OUT2', fromMe: false }, messageTimestamp: now - 470, messageStubType: 40 }],
    type: 'notify',
  });
  call('GRP1', 'offer', now - 400, { isGroup: true });
  call('GRP1', 'terminate', now - 300, { isGroup: true });
  await wait(100);
  assert.deepEqual(
    rows("SELECT id, from_me, ts, type, text FROM messages WHERE id GLOB 'IN*' OR id GLOB 'OUT*' OR id GLOB 'GRP*' ORDER BY ts"),
    [
      { id: 'IN1', from_me: 0, ts: now - 900, type: 'call', text: 'Voice call, 12 min' },
      { id: 'IN2', from_me: 0, ts: now - 800, type: 'call', text: 'Missed video call' },
      { id: 'OUT1', from_me: 1, ts: now - 600, type: 'call', text: 'Voice call, 40 s' },
      { id: 'OUT2', from_me: 1, ts: now - 500, type: 'call', text: 'Voice call, not answered' },
    ],
  );
  assert.deepEqual(
    said.filter((l) => /^a call/.test(l)),
    [
      'a call to you: offer, accept, terminate',
      'a call to you (video): offer, reject',
      'a call to you: offer, terminate',
      'a call you made: offer, accept, terminate',
      'a call you made: offer, timeout',
    ],
    'what was heard of each call, never with whom',
  );
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
      "SELECT d.dl_type, d.mimetype, d.file_name, json_extract(d.fetch, '$.directPath') AS direct_path FROM media d JOIN messages m ON m.rowid = d.msg_rowid WHERE m.chat_ref = 'mail:personal' ORDER BY m.rowid",
    ),
    [
      { dl_type: 'mail', mimetype: 'application/pdf', file_name: 'letter.pdf', direct_path: '2' },
      { dl_type: 'mail', mimetype: 'image/png', file_name: 'map.png', direct_path: '3' },
    ],
  );
  assert.equal(store.storedText('personal', 7), got[0].text);
  const { stats } = await import('../src/archive/query.js');
  const r = db.openRead();
  assert.equal(stats(r, 'mail').media.fetchable, 2, 'its attachments can be fetched: the mail plugin kept where each is');
  r.close();
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

test('a chat is found by its id as its service gives it, without the source in front, whatever the source', async () => {
  const w = db.openWrite();
  w.prepare(
    "INSERT INTO chats (ref, name, is_group, last_ts) VALUES ('wa:15557770000@s.whatsapp.net', 'Lee', 0, ?), ('tg:4242', 'Kim', 0, ?)",
  ).run(now, now);
  w.close();
  const { listChats } = await import('../src/archive/query.js');
  const r = db.openRead();
  assert.deepEqual(
    listChats(r, { match: '15557770000@s.whatsapp.net' }).map((c) => c.name),
    ['Lee'],
  );
  assert.deepEqual(
    listChats(r, { match: '4242' }).map((c) => c.name),
    ['Kim'],
  );
  assert.deepEqual(
    listChats(r, { match: 'tg:4242' }).map((c) => c.name),
    ['Kim'],
  );
  r.close();
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

  // Once read, nothing is read again: with email on and another watch taking some senders
  // (which makes the condition span lines), a look past the newest message reads nothing.
  const newest = rows('SELECT MAX(rowid) AS n FROM messages')[0].n;
  // (A look here is a dry run, which keeps no place: the place a real one keeps is set as it would be.)
  wdb.updateWatch(w, todo.id, { sources: { everywhere: 'all', mine: true, mailSince: now - 3600 } });
  assert.ok((await looked(wdb.findWatch(w, 'todo'))) > 0, 'without a place kept, there is something to read');
  wdb.updateWatch(w, todo.id, { lastRowid: newest });
  assert.equal(await looked(wdb.findWatch(w, 'todo')), 0, 'what was read before is not read again');
  store.archive(
    'personal',
    [{ uid: 11, ts: now - 20, from_addr: 'c@d.example', from_name: null, subject: 'One more', from_me: 0, files: '[]' }],
    () => 'Only this is new.',
  );
  assert.equal(await looked(wdb.findWatch(w, 'todo')), 1, 'only the new message is read');

  // More than a look reads at once: it reads as many as it may, says more is waiting, and
  // leaves the rest for the next look rather than skipping them.
  store.archive(
    'personal',
    Array.from({ length: 501 }, (_, k) => ({
      uid: 100 + k,
      ts: now - 10,
      from_addr: 'c@d.example',
      from_name: null,
      subject: `Batch ${k}`,
      from_me: 0,
      files: '[]',
    })),
    () => 'One of many.',
  );
  const big = await collect(w, wdb.findWatch(w, 'todo'), { dryRun: true });
  assert.deepEqual([big.looked, big.more], [500, true]);
  wdb.updateWatch(w, todo.id, { lastRowid: rows('SELECT MAX(rowid) AS n FROM messages')[0].n - 1 });
  const rest = await collect(w, wdb.findWatch(w, 'todo'), { dryRun: true });
  assert.deepEqual([rest.looked, rest.more], [1, false]);
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
  await assert.rejects(
    fetchMedia(d, 'mail:personal:10:1'),
    /^Error: It could not be fetched from Email \(the mail server could not be found/,
  );
  d.close();
});
