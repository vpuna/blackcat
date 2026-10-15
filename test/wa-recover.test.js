// `bc wa recover`: the phone is asked again for the older messages of each chat, fifty at
// a time back to the day asked for, and what was missing is kept. Only the owner's own
// phone is asked. The phone here is a stand-in that answers as a phone does.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { home } from './helpers.js';

const dir = home();
process.env.BLACKCAT_RECOVER_WAIT_S = '4';
const { save } = await import('../src/config.js');
save({ plugins: { settings: { wa: { days: 30, mode: 'all' } } } });
// (Linked, as far as the command can tell.)
fs.mkdirSync(path.join(dir, 'data', 'wa-auth'), { recursive: true });
fs.writeFileSync(path.join(dir, 'data', 'wa-auth', 'creds.json'), JSON.stringify({ account: {} }));
const { loadPlugins } = await import('../src/plugins/registry.js');
await loadPlugins();
const db = await import('../src/archive/db.js');
const { proto } = await import('baileys');
const now = Math.floor(Date.now() / 1000);
const DAY = 86400;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const texts = (ref) => {
  const d = db.openRead();
  try {
    return d.prepare('SELECT text FROM messages WHERE chat_ref = ? ORDER BY ts').pluck().all(ref);
  } finally {
    d.close();
  }
};

// What the phone holds: every message of every chat. blackcat is given only some of them.
const CLINIC = '15550009999@s.whatsapp.net';
const MAYA = '15550001234@s.whatsapp.net';
const OLD = '15550007777@s.whatsapp.net';
const msg = (chat, id, text, ago, message) => ({
  key: { remoteJid: chat, id, fromMe: false },
  messageTimestamp: now - ago,
  message: message ?? { conversation: text },
});
const phone = {
  [CLINIC]: [
    msg(CLINIC, 'C0', 'Welcome to the clinic', 50 * DAY),
    msg(CLINIC, 'C1', null, 3 * DAY, {
      templateMessage: { hydratedTemplate: { hydratedContentText: 'Your appointment is on Saturday at 08:00', hydratedButtons: [] } },
    }),
    msg(CLINIC, 'C2', 'Thank you for confirming your appointment.', 2 * DAY),
  ],
  // A long chat: more than one question is needed to reach the day asked for.
  [MAYA]: Array.from({ length: 120 }, (_, n) => msg(MAYA, `M${n}`, `message ${n}`, (120 - n) * 3600)),
  [OLD]: [msg(OLD, 'O1', 'last year', 200 * DAY)],
};
const asked = [];
let phoneOn = true;
const ev = new EventEmitter();
const sock = {
  ev,
  end: () => {},
  ws: { close: () => {} },
  logout: async () => {},
  groupFetchAllParticipating: async () => ({}),
  user: { id: '15550000000:1@s.whatsapp.net' },
  // Up to `count` messages of that chat older than the one named, as a phone answers: later, by itself.
  fetchMessageHistory: async (count, key, ts) => {
    asked.push({ chat: key.remoteJid, id: key.id, ts, count });
    if (!phoneOn) return 'x';
    const older = phone[key.remoteJid].filter((m) => m.messageTimestamp < ts || (m.messageTimestamp === ts && m.key.id !== key.id));
    const page = older.slice(-count);
    if (page.length)
      setTimeout(() => ev.emit('messaging-history.set', { messages: page, syncType: proto.HistorySync.HistorySyncType.ON_DEMAND }), 5);
    return 'x';
  },
};

const said = [];
const { startService } = await import('../plugins/wa/service.js');
const c = startService({
  socketFactory: () => sock,
  logLevel: 'silent',
  log: (l) => said.push(l),
  answerWaitMs: 150,
  askGapMs: 1,
  requestPollMs: 50,
});
await c.ready;
ev.emit('connection.update', { connection: 'open' });
// What blackcat has: the clinic's plain message, the newest ten of the long chat, and the old chat's one.
ev.emit('messages.upsert', { messages: [phone[CLINIC][2], ...phone[MAYA].slice(-10), phone[OLD][0]], type: 'notify' });
await wait(50);
after(async () => {
  await c.stop();
});

test('what was missing in a chat is asked of the phone and kept; what is there is not doubled', async () => {
  assert.deepEqual(texts(CLINIC), ['Thank you for confirming your appointment.']);
  const r = await c.recover({ days: 30, chats: [CLINIC] });
  assert.deepEqual(texts(CLINIC), ['Your appointment is on Saturday at 08:00', 'Thank you for confirming your appointment.']);
  assert.equal(r.recovered, 1);
  assert.deepEqual(r.per, [{ chat: '+15550009999', recovered: 1 }]);
  assert.deepEqual(
    asked.map((a) => [a.chat, a.id, a.count]),
    [[CLINIC, 'C2', 50]],
    'from the newest kept; an answer that reaches past the days asked for ends it',
  );
  assert.equal((await c.recover({ days: 30, chats: [CLINIC] })).recovered, 0, 'a second time finds nothing missing');
  assert.equal(texts(CLINIC).length, 2);
});

test('further back than the days that are kept, when asked for', async () => {
  const r = await c.recover({ days: 60, chats: [CLINIC] });
  assert.equal(r.recovered, 1);
  assert.equal(texts(CLINIC)[0], 'Welcome to the clinic');
  // And that reach is for the recovering only: what arrives by itself keeps to the days chosen.
  ev.emit('messages.upsert', { messages: [msg(CLINIC, 'C9', 'an old one arriving late', 45 * DAY)], type: 'notify' });
  await wait(30);
  assert.ok(!texts(CLINIC).includes('an old one arriving late'));
});

test('every chat with a message in those days, a long one page by page; a chat with nothing in them is not asked about', async () => {
  asked.length = 0;
  const r = await c.recover({ days: 30 });
  assert.equal(r.chats, 2, 'the clinic and the long chat: not the one whose last message is older');
  assert.equal(texts(MAYA).length, 120);
  assert.equal(r.recovered, 110);
  assert.ok(!asked.some((a) => a.chat === OLD));
  assert.equal(asked.filter((a) => a.chat === MAYA).length, 4, 'fifty at a time: three with messages, and one that finds no more');
});

test('a phone that does not answer is said plainly, and nothing is left half-open', async () => {
  phoneOn = false;
  await assert.rejects(c.recover({ days: 30, chats: [CLINIC] }), /your phone did not answer: it has to be switched on and connected/);
  phoneOn = true;
  assert.equal((await c.recover({ days: 30, chats: [CLINIC] })).recovered, 0, 'and it works again afterwards');
});

test('the command: leaves a request, the service does it, and it says what was found', async () => {
  const { recover, say } = await import('../plugins/wa/recover.js');
  const ctx = {
    fail: (m) => {
      throw new Error(m);
    },
  };
  phone[CLINIC].push(msg(CLINIC, 'C1b', 'One more, missed', 2.5 * DAY));
  const r = await recover(ctx, { chat: '15550009999', since: '30d' });
  assert.equal(r.text, 'Asked your phone for the last 30 days of 1 chat: 1 message that was missing is now kept.\n  +15550009999: 1');
  assert.equal(r.data.done, true);
  assert.ok(texts(CLINIC).includes('One more, missed'));
  assert.ok(said.some((l) => /recovered: 1 message that were missing|recovered: 1 message/.test(l)));
  assert.match((await recover(ctx, {})).text, /last 30 days of 2 chats: nothing was missing\./, 'the days that are kept, every chat');
  await assert.rejects(recover(ctx, { since: '2090-01-01' }), /--since is a time in the past, at most 3650 days back/);
  await assert.rejects(recover(ctx, { since: 'many' }), /Can't read "many" as how far back/);
  await assert.rejects(recover(ctx, { chat: 'nobody of that name' }), /No WhatsApp chat with messages matches/);
  phoneOn = false;
  await assert.rejects(recover(ctx, { chat: '15550009999' }), /It could not be done: your phone did not answer/);
  phoneOn = true;
  assert.equal(
    say({ chats: 3, recovered: 5, per: [{ chat: 'Sam', recovered: 5 }], silent: 2 }, { days: 7 }),
    'Asked your phone for the last 7 days of 3 chats: 5 messages that were missing are now kept.\n  Sam: 5\nThe phone gave no answer for 2 chats.',
  );
});
