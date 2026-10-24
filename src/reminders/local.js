import { addNextRepeat, closeMissed, dueReminders, openRemindersDb as openAgentDb, setStatus } from './db.js';
import { withDb } from '../db.js';

// With no Telegram bot there is nowhere to push a reminder to. Due ones wait, and are
// handed over when the owner next opens `bc chat`. Returns them, marked as delivered.
export function takeDue() {
  return withDb(openAgentDb, (db) => {
    const due = dueReminders(db);
    for (const r of due) {
      setStatus(db, r.id, 'sent');
      closeMissed(db, r);
      addNextRepeat(db, r);
    }
    return due;
  });
}
