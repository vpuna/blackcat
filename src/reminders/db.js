import { now } from '../util/time.js';
import { openAgentDb as openBase } from '../agentdb.js';
import { upgrade } from '../db.js';
import { adopt } from '../owner.js';
import { log } from '../log.js';
import { fmtWhen, nextRepeat, repeatText } from '../util/when.js';
import { loaded, makeCtx } from '../plugins/registry.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS reminders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     INTEGER NOT NULL,          -- the owner's chat, on the channel in use: where it is delivered
  text        TEXT NOT NULL,
  due_ts      INTEGER NOT NULL,          -- unix seconds
  created_ts  INTEGER NOT NULL,
  source      TEXT NOT NULL DEFAULT 'user',     -- user: asked for; auto: picked up from WhatsApp
  repeat      TEXT,                      -- daily | weekdays | weekly | monthly
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | done | cancelled | missed
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
// series (step 2): of a reminder that repeats, the id of the first of them; each time it comes
// round is a reminder of its own. missed: one of a series left unanswered when the next came.
const STEPS = [
  (db) => db.exec(SCHEMA),
  (db) => {
    db.exec('ALTER TABLE reminders ADD COLUMN series INTEGER');
    // (Those made before: one series for each chat, wording and schedule.)
    db.exec(`UPDATE reminders SET series = (SELECT MIN(o.id) FROM reminders o
      WHERE o.chat_id = reminders.chat_id AND o.text = reminders.text AND o.repeat = reminders.repeat) WHERE repeat IS NOT NULL`);
    db.exec(`UPDATE reminders SET status = 'missed' WHERE status = 'sent' AND series IS NOT NULL
      AND EXISTS (SELECT 1 FROM reminders l WHERE l.series = reminders.series AND l.status = 'sent' AND l.due_ts > reminders.due_ts)`);
    db.exec('CREATE INDEX IF NOT EXISTS reminders_series ON reminders (series) WHERE series IS NOT NULL');
  },
];

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

// A reminder that repeats, sent: the next one, the same in every way but when: the next time
// still to come, however late this one went (one gone while blackcat was off is not sent again
// a minute later), and never less than a minute from now. Nothing when it does not repeat.
export function addNextRepeat(db, r) {
  // (One snoozed after it went has its next time already.)
  if (nextOf(db, r)) return null;
  let next = nextRepeat(r.due_ts, r.repeat);
  for (let i = 0; next && next <= now() && i < 10_000; i++) next = nextRepeat(next, r.repeat);
  if (!next) return null;
  return addReminder(db, {
    chatId: r.chat_id,
    text: r.text,
    dueTs: Math.max(next, now() + 60),
    source: 'user',
    repeat: r.repeat,
    series: r.series ?? r.id,
    file: r.file,
    msgId: r.msg_id,
    msgChat: r.msg_chat,
    msgSender: r.msg_sender,
    msgQuote: r.msg_quote,
    msgTs: r.msg_ts,
  });
}

export function addReminder(db, r) {
  const info = db
    .prepare(
      `INSERT INTO reminders (chat_id, text, due_ts, created_ts, source, repeat, note, msg_id, msg_chat, msg_sender, msg_quote, msg_ts, item_id, file, series)
    VALUES (@chatId, @text, @dueTs, @createdTs, @source, @repeat, @note, @msgId, @msgChat, @msgSender, @msgQuote, @msgTs, @itemId, @file, @series)
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
      series: null,
      createdTs: now(),
      ...r,
    });
  if (!info.changes) return null;
  const id = Number(info.lastInsertRowid);
  // (The first of a series is the series.)
  if (r.repeat && r.series == null) db.prepare('UPDATE reminders SET series = id WHERE id = ?').run(id);
  return getReminder(db, id);
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

// Why a reminder may not be moved to `dueTs`: one already answered (done, cancelled, missed)
// is not brought back, and a time of a series goes only to before its next one (snoozed past
// tomorrow's walk, it would be two walks). The one rule for the buttons, a tap on an old
// message, and the command. → null when it may, or why not
export function whyNotMove(db, r, dueTs) {
  if (!OPEN.includes(r.status)) return `it is already ${r.status}`;
  const next = r.repeat ? nextOf(db, r) : null;
  if (next && dueTs >= next.due_ts) return `it comes again ${fmtWhen(next.due_ts)}, before then`;
  return null;
}
// → null when moved, or why not (as whyNotMove)
export function snooze(db, r, dueTs) {
  const why = whyNotMove(db, r, dueTs);
  if (!why) db.prepare("UPDATE reminders SET due_ts = ?, status = 'pending', sent_ts = NULL WHERE id = ?").run(dueTs, r.id);
  return why;
}
const OPEN = ['pending', 'sent'];

// The next time of a series, made when the one before it went.
export const nextOf = (db, r) =>
  r.series == null
    ? undefined
    : db.prepare("SELECT * FROM reminders WHERE series = ? AND id > ? AND status = 'pending' ORDER BY id LIMIT 1").get(r.series, r.id);

// A reminder of a series has just been sent: the times before it still open, never answered
// or snoozed past it, were missed. (Yesterday's walk is not still to do today.)
export const closeMissed = (db, r) =>
  r.series == null
    ? 0
    : db.prepare("UPDATE reminders SET status = 'missed' WHERE series = ? AND id < ? AND status IN ('pending', 'sent')").run(r.series, r.id)
        .changes;

// Done with, or skipped, this time. Of a series, one not yet sent makes way for the next time
// (one sent has made it already): the series goes on. → whether it changed
// Done, or cancelled: only one still open (an old message's ✅ does not undo a cancel).
// → how many changed
export function answer(db, r, status) {
  if (!OPEN.includes(r.status)) return 0;
  const changes = setStatus(db, r.id, status);
  if (changes && r.status === 'pending' && r.repeat) addNextRepeat(db, r);
  return changes;
}

// No more of a series: what of it is still open is cancelled. → how many
export const stopSeries = (db, r) =>
  db.prepare("UPDATE reminders SET status = 'cancelled' WHERE series = ? AND status IN ('pending', 'sent')").run(r.series ?? r.id).changes;

// One of each: of a series, only the first still open (the time that went and is not yet
// answered, or else the next). Rows in due order.
export function oneEach(rows) {
  const seen = new Set();
  return rows.filter((r) => r.series == null || (!seen.has(r.series) && seen.add(r.series)));
}

// What a reminder is, in words: the one description that the chat, the terminal and the
// briefing each lay out in their own way (so that they say the same). → { text, state (not
// marked done, done, cancelled, missed; none while it waits), auto, repeats, re, file }
export function aboutReminder(r) {
  return {
    text: r.text,
    state: { sent: 'not marked done', done: 'done', cancelled: 'cancelled', missed: 'missed' }[r.status] ?? null,
    auto: r.source === 'auto',
    repeats: r.repeat ? repeatText(r.repeat) : null,
    re: r.msg_chat ? (r.msg_sender ?? r.msg_chat) : null,
    file: !!r.file,
  };
}
