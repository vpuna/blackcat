// `bc tg account recover`: the messages of the last days are gone through again, chat by
// chat, and what is missing is kept: also something in the middle of a chat, which the
// catching-up after an outage (only what is newer than the newest kept) does not find.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { home } from './helpers.js';

const dir = home();
process.env.BLACKCAT_RECOVER_WAIT_S = '4';
const { save } = await import('../src/config.js');
save({ plugins: { settings: { tg: { apiId: 1, apiHash: 'x', days: 30, mode: 'all' } } } });
fs.mkdirSync(path.join(dir, 'data', 'tg-account'), { recursive: true });
fs.writeFileSync(path.join(dir, 'data', 'tg-account', 'session'), 'a session');
const { loadPlugins } = await import('../src/plugins/registry.js');
await loadPlugins();
const db = await import('../src/archive/db.js');
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

const sam = { id: 222, className: 'User', firstName: 'Sam' };
const club = { id: -1005, className: 'Channel', megagroup: true, title: 'Club', participantsCount: 12 };
const quiet = { id: 333, className: 'User', firstName: 'Quiet' };
const held = new Map([
  [sam, []],
  [club, []],
  [quiet, []],
]);
const say = (entity, id, text, ago) => held.get(entity).push({ id, message: text, date: now - ago, senderId: entity.id, out: false });
const fetched = [];
const client = {
  getMe: async () => ({ id: 111, firstName: 'Owner' }),
  addEventHandler: () => {},
  iterDialogs: async function* () {
    for (const [entity, msgs] of held) yield { entity, date: Math.max(0, ...msgs.map((m) => m.date)) || null };
  },
  iterMessages: async function* (entity) {
    fetched.push(entity.id);
    for (const m of [...held.get(entity)].sort((a, b) => b.date - a.date)) yield m;
  },
  getInputEntity: async (id) => id,
  getMessages: async () => [],
  downloadMedia: async () => null,
  disconnect: async () => {},
  connected: true,
};
const events = { NewMessage: class {}, EditedMessage: class {}, DeletedMessage: class {} };
const utils = { strippedPhotoToJpg: (b) => b, getPeerId: (p) => (typeof p === 'object' ? (p.userId ?? p.id) : p) };

say(sam, 1, 'on Monday', 5 * DAY);
say(sam, 3, 'on Wednesday', 3 * DAY);
say(club, 1, 'welcome to the club', 2 * DAY);
say(quiet, 1, 'long ago', 50 * DAY);
const logged = [];
const { startTgService } = await import('../plugins/tg/service.js');
const tg = await startTgService({ client, events, utils, log: (l) => logged.push(l), gapMs: 1 });
after(() => tg.stop());
for (let i = 0; i < 100 && !logged.some((l) => /\(2\/2\)/.test(l)); i++) await wait(50);
await wait(900);

test('a message missing from the middle of a chat is found and kept; the rest is not doubled', async () => {
  assert.deepEqual(texts('tg:222'), ['on Monday', 'on Wednesday']);
  say(sam, 2, 'on Tuesday, never received', 4 * DAY);
  await tg.backfill();
  assert.deepEqual(texts('tg:222'), ['on Monday', 'on Wednesday'], 'catching up looks only past the newest kept');
  fetched.length = 0;
  const r = await tg.recover({ days: 30 });
  assert.deepEqual(texts('tg:222'), ['on Monday', 'on Tuesday, never received', 'on Wednesday']);
  assert.deepEqual(
    { chats: r.chats, looked: r.looked, recovered: r.recovered, per: r.per },
    { chats: 2, looked: 2, recovered: 1, per: [{ chat: 'Sam', recovered: 1 }] },
  );
  assert.deepEqual(fetched.sort(), [-1005, 222], 'the chat with nothing in those days is not gone through');
  assert.equal((await tg.recover({ days: 30 })).recovered, 0);
});

test('only the days asked for, which may be more than are kept; and only the chat named', async () => {
  say(sam, 0, 'six weeks ago', 42 * DAY);
  assert.equal((await tg.recover({ days: 30, chats: ['tg:222'] })).recovered, 0, 'outside the days: left');
  fetched.length = 0;
  const r = await tg.recover({ days: 60, chats: ['tg:222'] });
  assert.equal(r.recovered, 1);
  assert.equal(texts('tg:222')[0], 'six weeks ago');
  assert.deepEqual(fetched, [222]);
});

test('the command: leaves the work for the service, waits, and says what was found', async () => {
  const { recover, say: words } = await import('../plugins/tg/recover.js');
  const ctx = {
    fail: (m) => {
      throw new Error(m);
    },
  };
  say(club, 2, 'the meeting moved to Friday', 1.5 * DAY);
  say(club, 3, 'see you there', DAY);
  held.get(club).sort((a, b) => a.date - b.date);
  // (The newest is kept by the catching-up; the one before it is what recovering finds.)
  const r = await recover(ctx, { chat: 'Club' });
  assert.match(
    r.text,
    /^Went through 30 days of history of 1 chat on Telegram again: \d messages? that w(as|ere) missing (is|are) now kept\.\n {2}Club: \d$/,
  );
  assert.equal(r.data.done, true);
  assert.deepEqual(texts('tg:-1005'), ['welcome to the club', 'the meeting moved to Friday', 'see you there']);
  assert.match((await recover(ctx, {})).text, /30 days of history of 2 chats on Telegram again: nothing was missing\./, 'the days chosen');
  await assert.rejects(recover(ctx, { chat: 'nobody of that name' }), /No Telegram chat matches/);
  assert.equal(
    words({ chats: 1, recovered: 1, per: [{ chat: 'Sam', recovered: 1 }] }, { days: 30 }),
    'Went through 30 days of history of 1 chat on Telegram again: 1 message that was missing is now kept.\n  Sam: 1',
  );
});
