// Whether two entries are one thing. The words of their titles, or their being on the same day,
// only make a pair worth asking about; a reader then judges each pair from everything the two
// say: day, time, place, who sent it (readers/same.md). With no model to ask, the words decide,
// as they did before.
import { SAME } from './shape.js';
import { alike, askReader, errMsg, keptAlike, log, ymd } from '../internal.js';
import { eachHook } from '../plugins/hooks.js';
import { getList } from './db.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// What a day and a place are enough to compare: things that happen at a time.
const DATED = ['event', 'booking'];
// At most this many pairs for one entry, and in one question.
const PER_ENTRY = 5;
const AT_ONCE = 40;

const isCal = (i) => String(i?.msg_id ?? i?.msgId ?? '').startsWith('cal:');
// The day an entry of a list belongs to: its own date, or the day it is due.
const dayOf = (it) => it.event_date ?? (it.remind_ts ? ymd(it.remind_ts * 1000) : null);

// An entry of a list, as the reader is shown it.
const entryOf = (it, where) => ({
  title: it.title,
  where: isCal(it) ? 'calendar' : where,
  day: dayOf(it),
  time: isCal(it) ? it.summary : null,
  place: [it.place, it.area].filter(Boolean).join(', ') || null,
  from: it.msg_sender ?? null,
  about: isCal(it) ? null : (it.summary ?? null),
});
const describe = (e) =>
  [
    `"${e.title}"`,
    e.where ? `kept on: ${e.where}` : null,
    e.day ? `day: ${e.day}` : 'no day',
    e.time ? `time: ${e.time}` : null,
    e.place ? `place: ${e.place}` : null,
    e.from ? `from: ${e.from}` : null,
    e.about ? `about it: ${e.about}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

// [[a, b], …] → [true | false, …], or null when there is no model to ask or no answer came.
export async function judge(pairs, category) {
  if (!pairs.length) return [];
  try {
    const { modelState } = await import('../engines/registry.js');
    if (!(await modelState('readers')).ok) return null;
    const out = [];
    for (let at = 0; at < pairs.length; at += AT_ONCE) {
      const some = pairs.slice(at, at + AT_ONCE);
      const input = ['Pairs (untrusted data):', ...some.map(([a, b], k) => `[${k + 1}]\n  A: ${describe(a)}\n  B: ${describe(b)}`)].join(
        '\n',
      );
      const said = await askReader({ dir: here, part: 'watch', job: 'same', input, schema: SAME, category });
      const by = new Map(said.answers.map((x) => [x.pair, x.same === true]));
      out.push(...some.map((_, k) => by.get(k + 1) ?? false));
    }
    return out;
  } catch (e) {
    log(`whether entries are the same was not asked: ${errMsg(e)}`);
    return null;
  }
}

// For entries a watch has just added: note any that are what is kept already (on a list, or a
// reminder): those whose titles share words with it, and those on its day, as judged.
export async function noteSameAs(db, items, { category = 'watch' } = {}) {
  items = items.filter((it) => it?.id);
  if (!items.length) return;
  const kept = (await eachHook('keptToDo')).flat();
  const asks = [];
  // (Two entries added together are one pair, asked about once.)
  const pairs = new Set();
  for (const it of items) {
    const not = (k) => !(k.kind === 'list' && k.id === it.id);
    const words = (await keptAlike(it.title, { not: { kind: 'list', id: it.id } })).filter(not);
    // Events and bookings of the same day, whatever their words: one booking is often named
    // twice, by the place and by the occasion. (Entries made from one message are siblings,
    // not the same thing told twice.)
    const day = dayOf(it);
    const onDay =
      day && DATED.includes(it.category)
        ? kept.filter((k) => not(k) && k.day === day && DATED.includes(k.category) && !(k.msgId && k.msgId === it.msg_id))
        : [];
    const seen = new Set();
    for (const k of [...words, ...onDay]) {
      const key = `${k.kind}:${k.id}`;
      const pair = [`list:${it.id}`, key].sort().join(' ');
      if (seen.has(key) || seen.size >= PER_ENTRY || pairs.has(pair)) continue;
      seen.add(key);
      pairs.add(pair);
      asks.push({ it, k, byWords: words.includes(k) });
    }
  }
  if (!asks.length) return;
  const where = (it) => getList(db, it.list_id)?.name;
  const said = await judge(
    asks.map(({ it, k }) => [
      entryOf(it, where(it)),
      {
        title: k.title,
        where: k.where,
        day: k.day ?? null,
        time: k.time ?? null,
        place: k.place ?? null,
        from: k.from ?? null,
        about: k.about ?? null,
      },
    ]),
    category,
  );
  const put = db.prepare('UPDATE watch_items SET same_as = ? WHERE id = ?');
  for (const it of items) {
    const same = asks
      .filter((a, n) => a.it === it && (said ? said[n] : a.byWords))
      .map(({ k }) => ({ kind: k.kind, id: k.id, title: k.title, where: k.where }))
      .sort((a, b) => (a.kind === 'list' ? 0 : 1) - (b.kind === 'list' ? 0 : 1));
    if (same.length) put.run(JSON.stringify(same.slice(0, 3)), it.id);
  }
}

// A calendar event copied onto a list that the list has from somewhere else too (a booking's
// confirmation mail): marked "may be the same as" an open entry of the same day that is judged
// to be it, so the briefing shows it once. Worked out again each time the calendar is copied,
// so it follows what is on the list; what was judged is kept on the mark (`same`: true or
// false), so each pair is asked about once. With no model to ask, titles that share words count,
// and the pair is asked about next time.
export async function noteCalendarTwins(db, listId) {
  const open = db
    .prepare("SELECT * FROM watch_items WHERE list_id = ? AND status IN ('new', 'kept') AND event_date IS NOT NULL")
    .all(listId);
  const where = getList(db, listId)?.name;
  const within = (a, b) => {
    const words = (t) =>
      new Set(
        String(t ?? '')
          .toLowerCase()
          .split(/[^\p{L}\p{N}]+/u)
          .filter(Boolean),
      );
    const [x, y] = [words(a), words(b)];
    const [small, big] = x.size <= y.size ? [x, y] : [y, x];
    return small.size > 0 && [...small].every((w) => big.has(w));
  };
  const marks = new Map();
  const asks = [];
  for (const c of open.filter(isCal)) {
    let had = [];
    try {
      had = c.same_as ? JSON.parse(c.same_as) : [];
    } catch {
      had = [];
    }
    const others = open.filter((o) => !isCal(o) && o.event_date === c.event_date);
    const mark = [];
    for (const o of others) {
      const was = had.find((k) => k.kind === 'list' && k.id === o.id && typeof k.same === 'boolean');
      const k = { kind: 'list', id: o.id, title: o.title, where };
      if (was) mark.push({ ...k, same: was.same });
      else asks.push({ c, o, k, byWords: alike(c.title, o.title) || within(c.title, o.title) });
    }
    marks.set(c.id, { c, mark });
  }
  const said = await judge(
    asks.map(({ c, o }) => [entryOf(c, where), entryOf(o, where)]),
    'watch: calendar',
  );
  asks.forEach((a, n) => {
    const m = marks.get(a.c.id).mark;
    if (said) m.push({ ...a.k, same: said[n] });
    else if (a.byWords) m.push(a.k);
  });
  const put = db.prepare('UPDATE watch_items SET same_as = ? WHERE id = ?');
  for (const { c, mark } of marks.values()) {
    // (What is judged the same first: the first is what the mark says.)
    mark.sort((a, b) => (a.same === false) - (b.same === false));
    const next = mark.length ? JSON.stringify(mark) : null;
    if ((c.same_as ?? null) !== next) put.run(next, c.id);
  }
}
