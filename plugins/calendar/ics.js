// Reads an iCalendar feed (the "secret address in iCal format" that Google, iCloud and
// Outlook give for a calendar) into a flat list of occurrences, repeats expanded.
import ICAL from 'ical.js';
import { ymd } from '../../src/api.js';

const MAX_REPEATS = 3000; // per event: guards against a rule that never ends
const clean = (s, max) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

// Who an event is from and who else is invited, as the invitation names them.
//   from: { name, email }   whoever organised it, when that is somebody else: null for an event
//                           of the owner's own (the calendar is theirs: its name is their
//                           address) and for one a shared calendar itself "organised"
//   with: [name or email]   the others invited, at most MAX_WITH, and `others` for how many more
const MAX_WITH = 8;
const person = (prop) => {
  const email = String(prop.getFirstValue() ?? '')
    .replace(/^mailto:/i, '')
    .trim()
    .toLowerCase();
  const name = clean(prop.getParameter('cn'), 80).replace(/^"|"$/g, '');
  return { name: name && name.toLowerCase() !== email ? name : null, email: email || null };
};
function people(ev, own) {
  const org = ev.component.getFirstProperty('organizer');
  let from = org ? person(org) : null;
  const organiser = from?.email ?? null;
  if (from && (from.email === own || /@group\.calendar\.google\.com$/.test(from.email ?? ''))) from = null;
  // (Rooms and other resources are not people.)
  const invited = ev.component
    .getAllProperties('attendee')
    .filter((a) => !/^(room|resource)$/i.test(a.getParameter('cutype') ?? ''))
    .map(person)
    .filter((p) => (p.name || p.email) && p.email !== organiser && p.email !== own);
  const names = [...new Set(invited.map((p) => p.name ?? p.email))];
  return {
    from: from && (from.name || from.email) ? from : null,
    with: names.slice(0, MAX_WITH),
    others: Math.max(0, names.length - MAX_WITH),
  };
}

// One occurrence. An all-day event has days, not times: "2026-10-05" to "2026-10-05" inclusive.
function occurrence(cal, ev, start, end, own) {
  const allDay = start.isDate;
  if (allDay) {
    const first = new Date(start.year, start.month - 1, start.day);
    // iCalendar's end day is the day after the last one.
    const last = end ? new Date(end.year, end.month - 1, end.day - 1) : first;
    return {
      cal,
      uid: ev.uid,
      title: clean(ev.summary, 160) || '(no title)',
      allDay: true,
      start: Math.floor(first / 1000),
      end: Math.floor(last / 1000) + 86399,
      day: ymd(first),
      lastDay: ymd(last < first ? first : last),
      location: clean(ev.location, 160) || null,
      notes: clean(ev.description, 300) || null,
      ...people(ev, own),
    };
  }
  const s = start.toJSDate();
  const e = end ? end.toJSDate() : s;
  return {
    cal,
    uid: ev.uid,
    title: clean(ev.summary, 160) || '(no title)',
    allDay: false,
    start: Math.floor(s / 1000),
    end: Math.floor(e / 1000),
    day: ymd(s),
    lastDay: ymd(e > s ? new Date(e - 1000) : s),
    location: clean(ev.location, 160) || null,
    notes: clean(ev.description, 300) || null,
    ...people(ev, own),
  };
}

// → occurrences that touch [fromMs, toMs], soonest first.
export function readCalendar(text, cal, fromMs, toMs) {
  const root = new ICAL.Component(ICAL.parse(text));
  for (const tz of root.getAllSubcomponents('vtimezone')) ICAL.TimezoneService.register(new ICAL.Timezone(tz));
  // Whose calendar it is, when the feed says: a person's own calendar is named with their address.
  const own = /^[^\s@]+@[^\s@]+$/.test(calendarName(text) ?? '') ? calendarName(text).toLowerCase() : null;
  const from = fromMs / 1000;
  const to = toMs / 1000;
  const out = [];
  const events = root.getAllSubcomponents('vevent').map((v) => new ICAL.Event(v, { strictExceptions: false }));
  // A changed single occurrence of a repeating event is a separate entry with the same uid.
  const masters = new Map(events.filter((e) => !e.isRecurrenceException()).map((e) => [e.uid, e]));
  for (const e of events) if (e.isRecurrenceException()) masters.get(e.uid)?.relateException(e);

  const cancelled = (e) => String(e.component.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED';
  const keep = (o) => o.end >= from && o.start <= to;
  for (const ev of masters.values()) {
    if (!ev.startDate) continue;
    if (!ev.isRecurring()) {
      const o = occurrence(cal, ev, ev.startDate, ev.endDate, own);
      if (!cancelled(ev) && keep(o)) out.push(o);
      continue;
    }
    const it = ev.iterator();
    for (let n = 0, next = it.next(); next && n < MAX_REPEATS; n++, next = it.next()) {
      const d = ev.getOccurrenceDetails(next);
      const o = occurrence(cal, d.item, d.startDate, d.endDate, own);
      if (o.start > to) break;
      if (!cancelled(d.item) && keep(o)) out.push(o);
    }
  }
  // Orphans: a changed occurrence whose repeating event is not in the feed.
  for (const e of events) {
    if (!e.isRecurrenceException() || masters.has(e.uid) || cancelled(e)) continue;
    const o = occurrence(cal, e, e.startDate, e.endDate, own);
    if (keep(o)) out.push(o);
  }
  return out.sort((a, b) => a.start - b.start);
}

export const calendarName = (text) => /^X-WR-CALNAME:(.+)$/m.exec(text)?.[1]?.trim() ?? null;
