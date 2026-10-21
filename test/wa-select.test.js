// `bc wa select`: the days say how far back history is fetched, so they never delete anything;
// what a chat no longer collected has is deleted only when the owner says so, and only
// WhatsApp's messages are ever touched.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { home } from './helpers.js';

home();
const { openWrite } = await import('../src/archive/db.js');
const { countOutside, deleteOutside } = await import('../plugins/wa/select.js');

const YEAR = 365 * 86400;
const now = Math.floor(Date.now() / 1000);
const MAYA = 'wa:15550001234@s.whatsapp.net';
const SAM = 'wa:15550005678@s.whatsapp.net';
const CLUB = 'wa:120363000000000000@g.us';
const db = openWrite();
const add = (chat, id, ts) =>
  db
    .prepare("INSERT INTO messages (chat_ref, id, sender_ref, from_me, ts, type, text) VALUES (?, ?, ?, 0, ?, 'text', 'hello')")
    .run(chat, id, chat, ts);
add(MAYA, 'M1', now - 2 * YEAR); // long before any days chosen
add(MAYA, 'M2', now - 3600);
add(SAM, 'S1', now - 3600);
add(CLUB, 'C1', now - 3600);
add('tg:222', 'T1', now - 3600); // another source's
const count = (sql = '1') => db.prepare(`SELECT COUNT(*) FROM messages WHERE ${sql}`).pluck().get();

test('all chats, whatever the days: nothing is outside, nothing is deleted', () => {
  const all = { days: 7, mode: 'all', chats: [] };
  assert.deepEqual(countOutside(db, all, { mode: 'all' }), { messages: 0, chats: 0 });
  deleteOutside(db, all, { mode: 'all' });
  assert.equal(count(), 5, 'a message two years old is kept with 7 days chosen');
});

test('chats picked: what the others have is counted, and deleted only when asked; never another source', () => {
  const picked = { days: 30, mode: 'selected', chats: [MAYA] };
  assert.deepEqual(countOutside(db, picked, { mode: 'all' }), { messages: 2, chats: 2 }, 'Sam and the club, from all chats before');
  // Only chats that were collected before count: one never picked is not asked about every time.
  assert.deepEqual(countOutside(db, picked, { mode: 'selected', chats: [MAYA, SAM] }), { messages: 1, chats: 1 });
  assert.deepEqual(countOutside(db, picked, { mode: 'selected', chats: [MAYA] }), { messages: 0, chats: 0 });
  deleteOutside(db, picked, { mode: 'selected', chats: [MAYA, SAM] });
  assert.equal(count(`chat_ref = '${SAM}'`), 0);
  assert.equal(count(`chat_ref = '${CLUB}'`), 1, 'the club was not collected before: left as it is');
  assert.equal(count(`chat_ref = '${MAYA}'`), 2, 'the one still picked keeps everything, the old one too');
  assert.equal(count("chat_ref = 'tg:222'"), 1, 'Telegram is never touched');
});

test('none picked at all: every WhatsApp chat collected before is outside', () => {
  assert.deepEqual(countOutside(db, { days: 30, mode: 'selected', chats: [] }, { mode: 'all' }), { messages: 3, chats: 2 });
});

test('all chats with some left out: what those have is counted and deleted only when asked', () => {
  const left = { days: 30, mode: 'all', chats: [], exclude: [CLUB] };
  assert.deepEqual(countOutside(db, left, { mode: 'all' }), { messages: 1, chats: 1 }, 'the club, from all chats before');
  assert.deepEqual(countOutside(db, left, { mode: 'all', exclude: [CLUB] }), { messages: 0, chats: 0 }, 'left out already');
  assert.deepEqual(countOutside(db, left, { mode: 'selected', chats: [MAYA] }), { messages: 0, chats: 0 }, 'not collected before');
  deleteOutside(db, left, { mode: 'all' });
  assert.equal(count(`chat_ref = '${CLUB}'`), 0);
  assert.equal(count(`chat_ref = '${MAYA}'`), 2, 'the others keep everything');
  assert.equal(count("chat_ref = 'tg:222'"), 1, 'Telegram is never touched');
});

test('a chat left out is not collected, with all chats or (were it left over) with some picked', async () => {
  const { collects, describeSelection } = await import('../plugins/wa/settings.js');
  assert.equal(collects(CLUB, { mode: 'all', exclude: [CLUB] }), false);
  assert.equal(collects(MAYA, { mode: 'all', exclude: [CLUB] }), true);
  assert.equal(collects(MAYA, { mode: 'selected', chats: [MAYA] }), true);
  assert.equal(collects(SAM, { mode: 'selected', chats: [MAYA] }), false);
  assert.equal(describeSelection({ mode: 'all', exclude: [CLUB], days: 30 }), 'all chats, 1 left out, history 30 days back');
});
