import { addReminder, dueReminders, openRemindersDb as openAgentDb, setStatus } from './db.js';
import { nextRepeat } from '../util/when.js';
import { withDb } from '../db.js';

// With no Telegram bot there is nowhere to push a reminder to. Due ones wait, and are
// handed over when the owner next opens `bc chat`. Returns them, marked as delivered.
export function takeDue() {
  return withDb(openAgentDb, (db) => {
    const due = dueReminders(db);
    for (const r of due) {
      setStatus(db, r.id, 'sent');
      const next = nextRepeat(r.due_ts, r.repeat);
      if (next) {
        addReminder(db, {
          chatId: r.chat_id,
          text: r.text,
          dueTs: Math.max(next, Math.floor(Date.now() / 1000) + 60),
          source: 'user',
          repeat: r.repeat,
          file: r.file,
          msgId: r.msg_id,
          msgChat: r.msg_chat,
          msgSender: r.msg_sender,
          msgQuote: r.msg_quote,
          msgTs: r.msg_ts,
        });
      }
    }
    return due;
  });
}
