// What is past its day comes first in the briefing, the latest first, and only a few of it:
// the rest is one line, with a button that lists it all. And what is new always has room,
// however much is on today.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { home, setUp } from './helpers.js';

home();
await setUp({ bot: { allow: [{ id: 42, name: 'me' }] } });
const { loadPlugins } = await import('../src/plugins/registry.js');
await loadPlugins();
const { withDb } = await import('../src/db.js');
const { addItem, addWatch, findWatch, openWatchDb } = await import('../src/watch/db.js');
const { addReminder, openRemindersDb, setStatus } = await import('../src/reminders/db.js');
const { composeBriefing, sendPastDue } = await import('../src/watch/briefing.js');

const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);
const ymd = (ts) => new Date(ts * 1000).toLocaleDateString('en-CA');

test('past due: first, the latest first, five of it, and a button for all of it; what is new still has room', async () => {
  const chat = withDb(openWatchDb, (db) => findWatch(db, 'todo').chat_id);
  // reminders sent 3 to 9 days ago and never marked done
  withDb(openRemindersDb, (db) => {
    for (let k = 3; k <= 9; k++) {
      const { id } = addReminder(db, { chatId: chat, text: `Old reminder ${k}`, dueTs: now() - k * DAY });
      setStatus(db, id, 'sent');
    }
  });
  const db = openWatchDb();
  const todo = findWatch(db, 'todo');
  // something owed two days ago, and a day full of things today
  addItem(db, { listId: todo.list_id, title: 'Send the insurance papers', category: 'commitment', remindTs: now() - 2 * DAY, msgId: 'p1' });
  for (let k = 1; k <= 25; k++)
    addItem(db, { listId: todo.list_id, title: `Thing ${k} today`, category: 'errand', eventDate: ymd(now()), msgId: `t${k}` });
  // and something new on a watch that reports in the briefing
  const school = addWatch(db, {
    chatId: todo.chat_id,
    name: 'School',
    lookFor: 'notices',
    sources: { everywhere: 'all' },
    mode: 'briefing',
  });
  addItem(db, { listId: school.list_id, title: 'Sign the school contract', category: 'form', msgId: 's1' });

  const b = await composeBriefing(db, todo.chat_id);
  const lines = b.html.split('\n');
  const head = lines.findIndex((l) => l === '<b>Past due</b>');
  assert.equal(head, 2, 'right after the date');
  assert.match(lines[3], /^1\. <b>Send the insurance papers<\/b> · <i>due 2 days ago<\/i>/, 'the latest first');
  assert.match(lines[4], /^2\. ⏰ <b>Old reminder 3<\/b> · <i>due 3 days ago, not marked done<\/i>/);
  assert.match(lines[7], /^5\. ⏰ <b>Old reminder 6<\/b>/);
  assert.equal(lines[8], '<i>…and 3 older: tap ⏳ below for all of them</i>');
  assert.match(JSON.stringify(b.keyboard), /wb:past/);
  assert.equal(lines[10], '<b>Today</b>');
  assert.ok(!/Old reminder/.test(lines.slice(9).join('\n')), 'a reminder of a day gone is not under today');
  assert.match(b.html, /<b>New · School<\/b>\n\d+\. <b>Sign the school contract<\/b>/, 'what is new is not crowded out');
  db.close();

  // the button: all of it, each with a number that opens it
  const sent = [];
  await sendPastDue({ send: async (to, html, o) => sent.push({ to, html, o }) }, chat);
  assert.equal(sent.length, 1);
  const all = sent[0].html.split('\n').filter((l) => /^\d+\. /.test(l));
  assert.equal(all.length, 8);
  assert.match(all[7], /^8\. ⏰ <b>Old reminder 9<\/b> · <i>due 9 days ago, not marked done<\/i>/);
  const taps = JSON.stringify(sent[0].o.actions);
  assert.match(taps, /wi:\d+:o/);
  assert.equal((taps.match(/rm:\d+:o/g) ?? []).length, 7);
});
