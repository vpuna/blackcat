// A reminder is marked as sent once it has been sent. Sending takes a moment, and the owner
// can answer in that moment (snooze it, tick it off): the answer must stand, or a snoozed
// reminder would be left marked as sent and never come back.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { home } from './helpers.js';

home();
const {
  addReminder,
  dueReminders,
  getReminder,
  markSent,
  openRemindersDb: openAgentDb,
  reschedule,
  setStatus,
} = await import('../src/reminders/db.js');
const past = () => Math.floor(Date.now() / 1000) - 5;

test('sent and untouched: it is marked sent', () => {
  const db = openAgentDb();
  const { id } = addReminder(db, { chatId: 1, text: 'Call the bank', dueTs: past() });
  const [r] = dueReminders(db).filter((x) => x.id === id);
  assert.equal(markSent(db, r), true);
  assert.equal(getReminder(db, id).status, 'sent');
  assert.ok(getReminder(db, id).sent_ts > 0);
  db.close();
});

test('snoozed while it was being sent: it stays waiting for its new time, and comes due again then', () => {
  const db = openAgentDb();
  const { id } = addReminder(db, { chatId: 1, text: 'Water the plants', dueTs: past() });
  const [r] = dueReminders(db).filter((x) => x.id === id); // read, and on its way to the owner
  const later = Math.floor(Date.now() / 1000) + 3600;
  reschedule(db, id, later); // the owner taps "1 hour" as it arrives
  assert.equal(markSent(db, r), false);
  assert.deepEqual([getReminder(db, id).status, getReminder(db, id).due_ts, getReminder(db, id).sent_ts], ['pending', later, null]);
  // even snoozed to a moment that has itself already passed, it is the snooze that counts
  reschedule(db, id, past() + 1);
  assert.equal(markSent(db, r), false);
  assert.ok(
    dueReminders(db).some((x) => x.id === id),
    'it comes due again',
  );
  db.close();
});

test('ticked off or cancelled while it was being sent: that stands too', () => {
  const db = openAgentDb();
  for (const status of ['done', 'cancelled']) {
    const { id } = addReminder(db, { chatId: 1, text: `one to be ${status}`, dueTs: past() });
    const [r] = dueReminders(db).filter((x) => x.id === id);
    setStatus(db, id, status);
    assert.equal(markSent(db, r), false);
    assert.equal(getReminder(db, id).status, status);
  }
  db.close();
});
