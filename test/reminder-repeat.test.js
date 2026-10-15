// A reminder that repeats, once it has gone: the next one is made, the same in every way but
// when, and never in the past however late this one went. One that does not repeat has no next.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { home, setUp } from './helpers.js';

home();
await setUp();
const { withDb } = await import('../src/db.js');
const { addReminder, listReminders, openRemindersDb } = await import('../src/reminders/db.js');
const { takeDue } = await import('../src/reminders/local.js');
const now = () => Math.floor(Date.now() / 1000);

test('a repeating reminder that went comes round again; one that does not repeat does not', () => {
  withDb(openRemindersDb, (db) => {
    addReminder(db, {
      chatId: 1,
      text: 'Water the plants',
      dueTs: now() - 3 * 86400, // went three days late
      repeat: '0 9 * * *',
      msgId: 'M1',
      msgChat: 'Home',
      msgSender: 'Me',
      msgQuote: 'water them',
      msgTs: 1700000000,
    });
    addReminder(db, { chatId: 1, text: 'Once only', dueTs: now() - 60 });
  });
  const went = takeDue();
  assert.deepEqual(went.map((r) => r.text).sort(), ['Once only', 'Water the plants']);
  const left = withDb(openRemindersDb, (db) => listReminders(db, { chatId: 1 })).filter((r) => r.status === 'pending');
  assert.equal(left.length, 1, 'only the repeating one comes round');
  const [n] = left;
  assert.equal(n.text, 'Water the plants');
  assert.equal(n.repeat, '0 9 * * *');
  assert.ok(n.due_ts >= now() + 59, 'never in the past');
  assert.deepEqual([n.msg_id, n.msg_chat, n.msg_sender, n.msg_quote, n.msg_ts], ['M1', 'Home', 'Me', 'water them', 1700000000]);
});
