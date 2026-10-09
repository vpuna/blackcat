import { now } from '../util/time.js';
import { openAgentDb as openBase } from '../agentdb.js';
import { upgrade } from '../db.js';
import { adopt } from '../owner.js';
import { log } from '../log.js';
import { loaded, makeCtx } from '../plugins/registry.js';

export { getMeta, setMeta } from '../agentdb.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS reminders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     INTEGER NOT NULL,          -- the owner's chat, on the channel in use: where it is delivered
  text        TEXT NOT NULL,
  due_ts      INTEGER NOT NULL,          -- unix seconds
  created_ts  INTEGER NOT NULL,
  source      TEXT NOT NULL DEFAULT 'user',     -- user: asked for; auto: picked up from WhatsApp
  repeat      TEXT,                      -- daily | weekdays | weekly | monthly
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | done | cancelled
  sent_ts     INTEGER,
  note        TEXT,                      -- auto: why it was picked up
  -- A snapshot of the WhatsApp message it's about, so the reminder still makes
  -- sense if that message is later pruned from the archive.
  msg_id       TEXT,                       -- the message it quotes, from whichever source: its id in the archive,
  msg_chat     TEXT,                       --   the chat it was in, who sent it,
  msg_sender   TEXT,
  msg_quote    TEXT,                       --   what it said,
  msg_ts       INTEGER,  --   and when
  item_id INTEGER,
  file TEXT
);
CREATE INDEX IF NOT EXISTS reminders_due ON reminders (status, due_ts);
CREATE INDEX IF NOT EXISTS reminders_item ON reminders (item_id) WHERE item_id IS NOT NULL;
`;

// item_id: the watch item a reminder is the nudge for (see watch/nudge.js); one you set
// yourself has none. file: a picture or document to send along when it arrives.
const STEPS = [(db) => db.exec(SCHEMA)];

// Bring the reminders' own table up to date in a database that is already open. (Watches
// keep their nudges in it, so they see to it too.)
export const upgradeReminders = (db) => upgrade(db, 'reminders', STEPS, { base: 2, owns: ['reminders'] });

// The agent database, with the reminders table in place.
export function openRemindersDb() {
  const db = openBase();
  upgradeReminders(db);
  adopt(db, 'reminders');
  return db;
}

export function addReminder(db, r) {
  const info = db
    .prepare(
      `INSERT INTO reminders (chat_id, text, due_ts, created_ts, source, repeat, note, msg_id, msg_chat, msg_sender, msg_quote, msg_ts, item_id, file)
    VALUES (@chatId, @text, @dueTs, @createdTs, @source, @repeat, @note, @msgId, @msgChat, @msgSender, @msgQuote, @msgTs, @itemId, @file)
    ON CONFLICT DO NOTHING`,
    )
    .run({
      source: 'user',
      repeat: null,
      note: null,
      msgId: null,
      msgChat: null,
      msgSender: null,
      msgQuote: null,
      msgTs: null,
      itemId: null,
      file: null,
      createdTs: now(),
      ...r,
    });
  return info.changes ? getReminder(db, Number(info.lastInsertRowid)) : null;
}

export const getReminder = (db, id) => db.prepare('SELECT * FROM reminders WHERE id = ?').get(id);

export function listReminders(db, { all = false, chatId } = {}) {
  const where = [all ? '1' : "status IN ('pending', 'sent')"];
  if (chatId != null) where.push('chat_id = @chatId');
  return db.prepare(`SELECT * FROM reminders WHERE ${where.join(' AND ')} ORDER BY due_ts`).all({ chatId });
}

export const dueReminders = (db) =>
  db.prepare("SELECT * FROM reminders WHERE status = 'pending' AND due_ts <= ? ORDER BY due_ts").all(now());

export function setStatus(db, id, status) {
  const changes = db
    .prepare(`UPDATE reminders SET status = ?, sent_ts = CASE WHEN ? = 'sent' THEN ? ELSE sent_ts END WHERE id = ?`)
    .run(status, status, now(), id).changes;
  // Done with a nudge means done with the thing it was about. Whoever set the nudge is
  // told (`nudgeDone` in its manifest) and does what that means for the thing itself.
  if (status === 'done' && changes) {
    const itemId = db.prepare('SELECT item_id FROM reminders WHERE id = ?').pluck().get(id);
    if (itemId) {
      for (const p of loaded()) {
        if (!p.manifest.nudgeDone) continue;
        try {
          p.manifest.nudgeDone(makeCtx(p, { caller: 'job', surface: 'job' }), { db, itemId });
        } catch (e) {
          log(`${p.name} could not be told that a nudge was done: ${e.message}`);
        }
      }
    }
  }
  return changes;
}

// A reminder that was just sent is marked so, but only if it is still as it was when it was
// read to be sent. Sending takes a moment, and the owner can already have answered it by
// then (snoozed it to later, ticked it off): that answer stands. → whether it was marked
export const markSent = (db, r) =>
  db
    .prepare("UPDATE reminders SET status = 'sent', sent_ts = ? WHERE id = ? AND status = 'pending' AND due_ts = ?")
    .run(now(), r.id, r.due_ts).changes > 0;

export const reschedule = (db, id, dueTs) =>
  db.prepare("UPDATE reminders SET due_ts = ?, status = 'pending', sent_ts = NULL WHERE id = ?").run(dueTs, id).changes;
