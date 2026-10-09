import { listItems } from './db.js';
import { clock, outOfQuiet, todayAt } from '../internal.js';
import { cancelNudges, setNudgeFor } from '../reminders/nudges.js';

// A nudge is a reminder about one item on a watch's list: a ping at the right moment, with
// Done and snooze. Each watch says when its nudges come:
//   { mode: 'off' }                             none (the briefing and reports are enough)
//   { mode: 'before', days: 2, at: '18:00' }    so many days before the item's date (0 = on the day)
//   { mode: 'suggested' }                       when the reader of the message thought it was due
// Nudges live in the reminders table, linked by item_id, so they share its buttons and
// quiet hours, and show up under /remind.

// "off" | "suggested" | "2d 18:00" | "0d 07:00" | "18:00" (on the day) → nudge setting, or null if unreadable.
export function parseNudge(text) {
  const v = String(text ?? '')
    .trim()
    .toLowerCase();
  if (v === 'off' || v === 'none' || v === 'no') return { mode: 'off' };
  if (v === 'suggested' || v === 'due') return { mode: 'suggested' };
  const m = /^(?:(\d{1,2})\s*d(?:ays?)?(?:\s+before)?\s+(?:at\s+)?)?(\d{1,2}:\d{2})$/.exec(v);
  if (!m || !clock(m[2])) return null;
  return { mode: 'before', days: Number(m[1] ?? 0), at: clock(m[2]) };
}

export function nudgeText(n) {
  if (n.mode === 'off') return 'no nudges';
  if (n.mode === 'suggested') return 'a nudge when each thing is due';
  return n.days === 0 ? `a nudge on the day at ${n.at}` : `a nudge ${n.days} day${n.days === 1 ? '' : 's'} before, at ${n.at}`;
}

// Automatic nudges never land inside quiet hours: they wait for the end of them.
export { outOfQuiet };

const niceDate = (ymd) => new Date(`${ymd}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

// When this item should be nudged, or null (no nudge, or the moment has passed).
function dueFor(w, it) {
  let ts = null;
  if (w.nudge.mode === 'suggested') ts = it.remind_ts;
  else if (w.nudge.mode === 'before' && it.event_date) {
    const d = new Date(`${it.event_date}T12:00:00`);
    d.setDate(d.getDate() - w.nudge.days);
    ts = todayAt(w.nudge.at, d.getTime());
  }
  if (!ts) return null;
  ts = outOfQuiet(ts);
  return ts > Date.now() / 1000 ? ts : null;
}

const textFor = (w, it) => (w.nudge.mode === 'suggested' || !it.event_date ? it.title : `${it.title} · ${niceDate(it.event_date)}`);

// Make, move or remove the nudge for one item so it matches the watch's setting.
// `quote` is the message text to show with it. Returns the due time, or null.
export function setNudge(db, w, it, quote) {
  const due = ['new', 'kept'].includes(it.status) ? dueFor(w, it) : null;
  if (!due) {
    cancelNudges(db, it.id);
    return null;
  }
  // (The one waiting is moved; one that has already been sent is not sent again.)
  setNudgeFor(db, it.id, {
    chatId: w.chat_id,
    text: textFor(w, it),
    dueTs: due,
    note: `from your "${w.name}" list`,
    msgId: it.msg_id,
    msgChat: it.msg_chat,
    msgSender: it.msg_sender,
    msgQuote: (quote || it.summary || '').slice(0, 300),
    msgTs: it.msg_ts,
  });
  return due;
}

// After a watch's nudge setting changes: bring every item's nudge into line.
export function syncNudges(db, w) {
  for (const it of listItems(db, w.id, { status: 'new,kept' })) setNudge(db, w, it);
}
