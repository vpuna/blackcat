// "Things I need to do" covers everything the owner has connected: messages, kept email,
// and calendars. Messages and mail are read by a model; calendar events need no reading
// (they already have a title, a day and a time), so they are copied onto the watch's list
// as they are, and kept in step with the calendar. No model is involved here.
import { TODO, addItem, findWatch, removeItem, setItemStatus, updateItem } from './db.js';
import { hm, loaded, makeCtx, optIn, ymd } from '../internal.js';

const AHEAD_DAYS = 7;

// What is connected, so the watch can say what it covers (and stop mentioning what is not there).
// Keyed by source id (email is "mail"), plus "calendar" for the plugins that offer dated things.
export function connected() {
  const out = { calendar: loaded().some((p) => p.manifest.agenda) };
  for (const src of optIn()) {
    try {
      out[src.id] = !!src.connected?.();
    } catch {
      out[src.id] = false;
    }
  }
  return out;
}
// Each is read unless the owner turned it off for this watch (only a "no" is stored).
export function reads(w) {
  const c = connected();
  return Object.fromEntries(Object.entries(c).map(([k, on]) => [k, on && w?.sources?.[k] !== false]));
}

export const isCalendarItem = (it) => String(it?.msg_id ?? '').startsWith('cal:');

// Dated things from plugins that have them (the calendar): [{ id, source, title, start, end, allDay, day, lastDay, location, from }]
// (`from`: who organised it, when that is somebody other than the owner.)
// → { events, whole }: `whole` is false when a plugin could not say, so what is missing
// from `events` may only be missing because of that.
async function agenda(fromMs, toMs) {
  const events = [];
  let whole = true;
  for (const p of loaded()) {
    if (!p.manifest.agenda) continue;
    try {
      const said = (await p.manifest.agenda(makeCtx(p, { caller: 'job' }), { from: fromMs, to: toMs })) ?? [];
      if (!Array.isArray(said)) throw new Error('agenda must return a list');
      events.push(...said.filter((e) => e && e.id != null && e.source != null && e.day && e.lastDay));
    } catch {
      whole = false;
    }
  }
  return { events, whole };
}

// Bring the watch's list in step with the calendar for the coming week.
export async function syncAgenda(db) {
  const w = findWatch(db, TODO);
  if (!w) return { added: 0, removed: 0 };
  const mine = db.prepare("SELECT * FROM watch_items WHERE watch_id = ? AND msg_id LIKE 'cal:%'").all(w.id);
  const open = (it) => it.status === 'new' || it.status === 'kept';
  if (!w.active || !reads(w).calendar) {
    mine.filter(open).forEach((it) => removeItem(db, it.id));
    return { added: 0, removed: mine.filter(open).length };
  }
  const today = ymd(Date.now());
  const { events, whole } = await agenda(new Date().setHours(0, 0, 0, 0), Date.now() + AHEAD_DAYS * 86400000);
  const byKey = new Map(mine.map((it) => [it.msg_id, it]));
  const seen = new Set();
  let added = 0;
  for (const e of events) {
    if (e.lastDay < today) continue;
    const key = `cal:${e.source}:${e.id}:${e.day}`;
    seen.add(key);
    // An event that runs over several days stays on the list, under today, until it ends.
    const fields = {
      title: String(e.title).slice(0, 160),
      category: 'calendar',
      place: e.location ?? null,
      eventDate: e.day < today ? today : e.day,
      summary: e.allDay ? (e.lastDay > e.day ? `all day, until ${e.lastDay}` : 'all day') : `${hm(e.start)}–${hm(e.end)}`,
    };
    const from = e.from ? String(e.from).slice(0, 160) : null;
    const had = byKey.get(key);
    if (!had) {
      const it = addItem(db, { watchId: w.id, ...fields, msgId: key, msgChat: `Calendar: ${e.source}`, msgSender: from, msgTs: e.start });
      // Not "new": it is shown on its day, not announced as a find.
      if (it) (setItemStatus(db, it.id, 'kept'), added++);
    } else if (
      open(had) &&
      (had.title !== fields.title ||
        had.place !== fields.place ||
        had.event_date !== fields.eventDate ||
        had.summary !== fields.summary ||
        had.msg_ts !== e.start ||
        (had.msg_sender ?? null) !== from)
    ) {
      updateItem(db, had.id, fields);
      db.prepare('UPDATE watch_items SET msg_ts = ?, msg_sender = ? WHERE id = ?').run(e.start, from, had.id);
    }
  }
  // Gone from the calendar (cancelled, or moved to another day): gone from the list. Not
  // when a calendar could not be read: then nothing is taken off, and what the others had is still added above.
  if (!whole) return { added, removed: 0 };
  const gone = mine.filter((it) => open(it) && !seen.has(it.msg_id) && (it.event_date ?? today) >= today);
  gone.forEach((it) => removeItem(db, it.id));
  return { added, removed: gone.length };
}
