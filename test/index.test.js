// The index behind search by meaning. Working out a vector is slow on a small machine, so
// the index must know cheaply when there is nothing to do, never redo what has not changed,
// and never keep a search waiting for long. (A stand-in model is used: words only, instant.)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { home } from './helpers.js';

home();
const { save } = await import('../src/config.js');
const useModel = (embedder) => save({ archive: { embedder } });
useModel({ provider: 'hash' });
const { openWrite } = await import('../src/archive/db.js');
const { behind, find, index, indexStats } = await import('../src/archive/semantic.js');

const wa = openWrite();
wa.prepare(
  "INSERT INTO chats (ref, name, is_group) VALUES ('1@s.whatsapp.net', 'Maya', 0), ('2@s.whatsapp.net', 'Sam', 0), ('mail:home', 'Mail: home', 0)",
).run();
let n = 0;
const T0 = 1_790_000_000;
// One message per window: each is an hour after the last one in its chat (unless `at` says otherwise).
const clock = {};
function say(chat, text, at) {
  clock[chat] = at ?? (clock[chat] ?? T0) + 3600;
  wa.prepare("INSERT INTO messages (chat_ref, id, sender_ref, from_me, ts, type, text) VALUES (?, ?, ?, 0, ?, 'text', ?)").run(
    chat,
    `M${++n}`,
    chat,
    clock[chat],
    text,
  );
  return `M${n}`;
}
const embedded = () => globalThis.__blackcatEmbedded ?? 0;
async function counting(fn) {
  const before = embedded();
  const r = await fn();
  return { r, embedded: embedded() - before };
}

test('how far behind is known without loading anything, and a run with nothing to do ends at once', async () => {
  for (let i = 0; i < 6; i++) say('1@s.whatsapp.net', `we talked about the garden fence number ${i}`);
  assert.deepEqual(behind(), { built: false, messages: 6, unfinished: false });
  const first = await index({ quiet: true, ifNeeded: true });
  assert.deepEqual([first.windows, first.embedded, first.left], [6, 6, 0]);
  assert.deepEqual(behind(), { built: true, messages: 0, unfinished: false });

  // A model that cannot be loaded: an up-to-date index must not even try.
  useModel({ provider: 'no-such-provider' });
  assert.deepEqual(await index({ quiet: true, ifNeeded: true }), { upToDate: true });
  await assert.rejects(() => index({ quiet: true }), /Unknown embedder provider/, 'asked for outright, it does load the model');
  useModel({ provider: 'hash' });
});

test('new messages are counted whichever source they came from, and only they are worked on', async () => {
  say('2@s.whatsapp.net', 'the plumber comes on tuesday');
  say('mail:home', 'your parcel has been delivered to the front door');
  assert.equal(behind().messages, 2);
  const { r, embedded: e } = await counting(() => index({ quiet: true, ifNeeded: true }));
  assert.deepEqual([r.windows, r.embedded], [8, 2]);
  assert.equal(e, 2, 'the six that were there are not embedded again');
});

test('a search by meaning indexes what has just arrived, before it searches', async () => {
  say('2@s.whatsapp.net', 'the dentist appointment moved to thursday afternoon');
  assert.equal(behind().messages, 1);
  const results = await find('dentist appointment thursday', { limit: 3 });
  assert.match(results[0].text, /dentist appointment moved/);
  assert.equal(results.caughtUp.left, 0);
  assert.equal(behind().messages, 0);
  // and when nothing is new, a search does no indexing at all
  const again = await counting(() => find('dentist appointment thursday', { limit: 3 }));
  assert.equal(again.r.caughtUp, null);
  assert.equal(again.embedded, 1, 'only the question itself');
});

test('when a chat is rebuilt, windows that came out the same keep their vector', async () => {
  // An older message arriving late (a history re-sync, a mail fetched out of order) makes
  // the whole chat be cut into windows again.
  say('1@s.whatsapp.net', 'an old note about the shed roof', T0 + 600);
  const { r, embedded: e } = await counting(() => index({ quiet: true }));
  assert.equal(r.rebuilt, 7, 'all of that chat, with the late one in its place');
  assert.equal(r.reused, 6);
  assert.equal(e, 1, 'one vector worked out, not seven');
  assert.equal(indexStats().windows, indexStats().embedded);
});

test('a search waits only so long: newest first, the rest left for the next run', async () => {
  useModel({ provider: 'hash', delayMs: 60 }); // a slow model
  for (let i = 0; i < 40; i++) say('2@s.whatsapp.net', `backlog message ${i} about something else entirely`);
  const newest = say('2@s.whatsapp.net', 'the very latest thing said was about saffron');
  const planned = [];
  const t0 = Date.now();
  const r = await index({ quiet: true, budgetMs: 600, onPlan: (w) => planned.push(w) });
  assert.ok(Date.now() - t0 < 2500, 'it stopped near its time limit');
  assert.deepEqual(planned, [41], 'told how much there was, before starting');
  assert.ok(r.embedded > 0 && r.left > 0 && r.embedded + r.left === 41, JSON.stringify(r));
  assert.deepEqual(behind(), { built: true, messages: 0, unfinished: true });
  // what was said last is already findable
  useModel({ provider: 'hash' });
  const hit = await find('saffron', { limit: 1 });
  assert.equal(hit[0].anchorId, newest);
  // (that search found the index unfinished and carried on with it)
  assert.equal(hit.caughtUp.left, 0);
  assert.deepEqual(behind(), { built: true, messages: 0, unfinished: false });
  assert.equal(indexStats().windows, indexStats().embedded);
});

test('conversations whose messages were removed leave the index, without waiting for a new message', async () => {
  const before = indexStats().windows;
  wa.prepare("DELETE FROM messages WHERE chat_ref = 'mail:home'").run();
  assert.equal(behind().messages, 0, 'nothing new has arrived');
  assert.deepEqual(await index({ quiet: true, ifNeeded: true }), { upToDate: true }, 'so a run just after the last sweep does nothing');
  // an hour on, the scheduled run looks for them
  const Database = (await import('better-sqlite3')).default;
  const { INDEX_DB } = await import('../src/archive/semantic.js');
  const ix = new Database(INDEX_DB);
  ix.prepare("UPDATE meta SET value = value - 3601 WHERE key = 'swept_at'").run();
  ix.close();
  await index({ quiet: true, ifNeeded: true });
  assert.equal(indexStats().windows, before - 1);
  wa.close();
});
