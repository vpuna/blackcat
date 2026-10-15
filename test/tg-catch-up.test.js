// The Telegram account: Telegram sends live only what arrives while connected. What came
// while blackcat was off, or the connection was down, is asked for: everything after the
// newest message already kept, chat by chat.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { home } from './helpers.js';

home();
const { save } = await import('../src/config.js');
save({ tga: { apiId: 1, apiHash: 'x', days: 30, mode: 'all' } });
const db = await import('../src/archive/db.js');
const now = Math.floor(Date.now() / 1000);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const texts = (ref) => {
  const d = db.openRead();
  try {
    return d.prepare('SELECT text FROM messages WHERE chat_ref = ? ORDER BY ts').pluck().all(ref);
  } finally {
    d.close();
  }
};

// A stand-in for Telegram: chats with their messages, and a note of what was asked for.
const sam = { id: 222, className: 'User', firstName: 'Sam' };
const club = { id: -1005, className: 'Channel', megagroup: true, title: 'Club', participantsCount: 12 };
const held = new Map([
  [sam, []],
  [club, []],
]);
const say = (entity, id, text, ago, extra = {}) =>
  held.get(entity).push({ id, message: text, date: now - ago, senderId: entity.id, out: false, ...extra });
const fetched = [];
let listed = 0;
const client = {
  getMe: async () => ({ id: 111, firstName: 'Owner' }),
  addEventHandler: () => {},
  iterDialogs: async function* () {
    listed++;
    for (const [entity, msgs] of held) yield { entity, date: Math.max(0, ...msgs.map((m) => m.date)) || null };
  },
  // Newest first, as Telegram gives them.
  iterMessages: async function* (entity) {
    const asked = { chat: entity.id, got: 0 };
    fetched.push(asked);
    for (const m of [...held.get(entity)].sort((a, b) => b.date - a.date)) {
      asked.got++;
      yield m;
    }
  },
  getInputEntity: async (id) => id,
  getMessages: async () => [],
  downloadMedia: async () => null,
  disconnect: async () => {},
  connected: true,
};
const events = { NewMessage: class {}, EditedMessage: class {}, DeletedMessage: class {} };
const utils = { strippedPhotoToJpg: (b) => b, getPeerId: (p) => (typeof p === 'object' ? (p.userId ?? p.id) : p) };

say(sam, 0, 'long before', 5 * 86400);
say(sam, 1, 'before blackcat was linked', 3 * 86400);
say(sam, 2, 'the day before', 86400 + 60);
say(club, 1, 'welcome to the club', 2 * 86400);
const logged = [];
const { startTgService } = await import('../plugins/tg/service.js');
const tg = await startTgService({ client, events, utils, log: (l) => logged.push(l) });
after(() => tg.stop());
// (The first fetch of history starts by itself; wait for it to be over, which is a pause
// after its last chat, since a second one asked for meanwhile is not started.)
const settled = async () => {
  for (let i = 0; i < 100 && !logged.some((l) => /history: 1 messages? from one chat \(2\/2\)/.test(l)); i++) await wait(50);
  await wait(900);
};

test('at first, the history of each chat is fetched once', async () => {
  await settled();
  assert.deepEqual(texts('tg:222'), ['long before', 'before blackcat was linked', 'the day before']);
  assert.deepEqual(texts('tg:-1005'), ['welcome to the club']);
  fetched.length = 0;
  await tg.backfill();
  assert.deepEqual(fetched, [], 'with nothing new, no chat is asked about again');
});

test('what came while blackcat was off is fetched on return: only the chats that moved, and only what is new', async () => {
  // a day goes by with blackcat off: three messages to Sam's chat, none in the club
  say(sam, 3, 'are you there?', 7200);
  say(sam, 4, 'never mind, found it', 3600, { out: true, senderId: 111 });
  say(sam, 5, 'thanks anyway', 1800);
  fetched.length = 0;
  logged.length = 0;
  await tg.backfill();
  assert.deepEqual(texts('tg:222'), [
    'long before',
    'before blackcat was linked',
    'the day before',
    'are you there?',
    'never mind, found it',
    'thanks anyway',
  ]);
  assert.deepEqual(
    fetched.map((f) => f.chat),
    [222],
    'the club, where nothing happened, was not asked about',
  );
  assert.equal(
    fetched[0].got,
    5,
    'it read back past the newest one it had (the three new, that one, and one more to know), and stopped: not all six',
  );
  assert.deepEqual(logged, ['caught up: 3 messages in 1 chat that came while not connected']);
  const d = db.openRead();
  assert.deepEqual(d.prepare("SELECT from_me FROM messages WHERE id = 'tg222_4'").pluck().all(), [1], "the owner's own are kept as theirs");
  d.close();

  // and again straight away: nothing to ask, nothing doubled
  fetched.length = 0;
  await tg.backfill();
  assert.deepEqual([fetched, texts('tg:222').length], [[], 6]);
});

test('a chat whose latest is something not kept (someone joined) is looked at once, not every time', async () => {
  say(club, 2, null, 600, { className: 'MessageService', action: { className: 'MessageActionChatAddUser' } });
  fetched.length = 0;
  logged.length = 0;
  await tg.backfill();
  await tg.backfill();
  assert.deepEqual(
    fetched.map((f) => f.chat),
    [-1005],
  );
  assert.deepEqual([texts('tg:-1005'), logged], [['welcome to the club'], []]);
});

test('nothing older than the days chosen is fetched, and a chat that is not collected is left alone', async () => {
  // an old message turns up in what Telegram gives (it was hidden, say): beyond 30 days, it is not taken
  say(club, 3, 'from two months ago', 60 * 86400);
  say(club, 4, 'new today', 300);
  await tg.backfill();
  assert.deepEqual(texts('tg:-1005'), ['welcome to the club', 'new today']);

  // the owner narrows the collection to Sam: the club is not asked about, whatever arrives
  const { saveTgaSettings } = await import('../plugins/tg/paired.js');
  saveTgaSettings({ mode: 'selected', chats: ['tg:222'] });
  say(club, 5, 'after it was dropped', 100);
  say(sam, 6, 'still collected', 100);
  fetched.length = 0;
  await tg.backfill();
  assert.deepEqual(
    fetched.map((f) => f.chat),
    [222],
  );
  assert.equal(texts('tg:222').at(-1), 'still collected');
  assert.ok(!texts('tg:-1005').includes('after it was dropped'));
});

test('when the connection drops and comes back, what was missed meanwhile is asked for', async () => {
  client.connected = false;
  await wait(1700);
  say(sam, 7, 'sent while the connection was down', 20);
  const before = listed;
  client.connected = true;
  for (let i = 0; i < 80 && !texts('tg:222').includes('sent while the connection was down'); i++) await wait(50);
  assert.ok(listed > before, 'it looked again by itself');
  assert.equal(texts('tg:222').at(-1), 'sent while the connection was down');
});
