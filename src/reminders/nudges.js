// Nudges: reminders that another part of blackcat sets for something of its own (a watch,
// for an entry on one of its lists). This is the whole of what such a part may do with the
// reminder queue: it never reads or writes the reminders table itself.
//
// A nudge is tied to the thing it is about by that thing's id (`itemId`). When the owner
// marks a nudge done, whoever set it is told, through `nudgeDone` in its manifest, and
// does what that means for the thing itself (ticks it off its list).
import { addReminder } from './db.js';

const ids = (list) => [...new Set([list].flat().map(Number).filter(Number.isInteger))];
const marks = (list) => list.map(() => '?').join(', ');

// The nudge waiting to be sent for this thing, if any. → { id, text, due_ts } | undefined
export const pendingNudge = (db, itemId) =>
  db.prepare("SELECT id, text, due_ts FROM reminders WHERE item_id = ? AND status = 'pending'").get(itemId);

// Has one already gone out for it (sent, or sent and ticked off)? Such a thing is not nudged about twice.
export const wasNudged = (db, itemId) =>
  !!db.prepare("SELECT 1 FROM reminders WHERE item_id = ? AND status IN ('sent', 'done')").get(itemId);

// Make the nudge for a thing, or move the one that is waiting. One that has already gone
// out is left alone. → 'made' | 'moved' | 'already'
//   { chatId, text, dueTs, note, msgId, msgChat, msgSender, msgQuote, msgTs }
export function setNudgeFor(db, itemId, n) {
  const waiting = pendingNudge(db, itemId);
  if (waiting) {
    db.prepare('UPDATE reminders SET text = ?, due_ts = ? WHERE id = ?').run(n.text, n.dueTs, waiting.id);
    return 'moved';
  }
  if (wasNudged(db, itemId)) return 'already';
  addReminder(db, { ...n, source: 'auto', itemId });
  return 'made';
}

// Nothing to nudge about any more (the thing was removed, or its time changed to none):
// what is waiting is cancelled. → how many
export function cancelNudges(db, itemIds) {
  const list = ids(itemIds);
  return list.length
    ? db.prepare(`UPDATE reminders SET status = 'cancelled' WHERE status = 'pending' AND item_id IN (${marks(list)})`).run(...list).changes
    : 0;
}

// The thing itself is dealt with (done, dropped, past): what is waiting is cancelled, and
// what was sent and not yet answered counts as answered.
export function settleNudges(db, itemIds) {
  const list = ids(itemIds);
  if (!list.length) return;
  db.prepare(`UPDATE reminders SET status = 'cancelled' WHERE status = 'pending' AND item_id IN (${marks(list)})`).run(...list);
  db.prepare(`UPDATE reminders SET status = 'done' WHERE status = 'sent' AND item_id IN (${marks(list)})`).run(...list);
}
