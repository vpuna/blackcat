// The daily briefing: what is on the lists, the reminders of the day, what other parts of
// blackcat have to say, and what is not working. Sent at the times the owner chose, or shown
// on asking (bc watch briefing --print).
import { isCalendarItem, syncAgenda } from './agenda.js';
import { isQuiet } from './lists.js';
import { COMING, WAITING } from './shape.js';
import { pendingNudge, wasNudged } from '../reminders/nudges.js';
import { briefingLists, cameTo, expirePast, listItems, listWatches, openWatchDb, sameAsOf, sameAsText, setItemStatus } from './db.js';
import { actions, agoLabel, errMsg, esc, hm, loaded, log, makeCtx, ymd } from '../internal.js';
import { withDb } from '../db.js';
import { dateLabel, numbered } from './chat.js';

// What the other parts of blackcat, and plugins, have for the briefing: each may offer
// `briefing(ctx, { chatId, terminal })` in its manifest, giving { problems: [html], fine: html |
// null, buttons?: [{ label, id }], note?: html, entries?: [{ day, line, action, kind, id, title }] }
// (a note is shown at the end, every time: what the model used; entries go under their day with
// the list's entries, numbered, the number opening `action`).
// One message's length, as a chat takes it.
const LIMIT = 4000;
// The lines that fit in `room` characters, whole, with `more` said in place of the rest.
// → { lines, dropped }
export function fitLines(lines, room, more) {
  const len = (ls) => ls.join('\n').length;
  if (len(lines) <= room) return { lines, dropped: 0 };
  const kept = [];
  for (const l of lines) {
    if (len([...kept, l, '', more]) > room) break;
    kept.push(l);
  }
  // (nor a heading left with nothing under it)
  while (kept.length && (kept.at(-1) === '' || /^<b>[^<]*<\/b>$/.test(kept.at(-1)))) kept.pop();
  return { lines: [...kept, '', more], dropped: lines.length - kept.length };
}

export async function fromOthers(opts = {}) {
  const out = [];
  for (const p of loaded()) {
    if (!p.manifest.briefing) continue;
    try {
      const said = await p.manifest.briefing(makeCtx(p, { caller: 'job' }), opts);
      if (said) out.push(said);
    } catch (e) {
      log(`the briefing went without ${p.name}: ${errMsg(e)}`);
    }
  }
  return out;
}

export const MAX_BRIEFING = 24;

// What blackcat itself can see is wrong: a service that should be running and isn't.
export async function systemLines() {
  try {
    const { services, isInstalled, show } = await import('../internal.js');
    const down = [];
    for (const [name, svc] of Object.entries(await services())) {
      if (isInstalled(svc) && (await show(svc)).ActiveState !== 'active') down.push(name);
    }
    return down.length ? [`⚠️ Not running: ${down.join(', ')}. See <code>bc status</code> on this machine.`] : [];
  } catch {
    return [];
  }
}

// One message for the day, across every watch: what is on today and tomorrow, what is
// coming up this week, and what is new. Things with a number can be opened and ticked off.
// `peek` (asked for on demand) leaves the "new" marks alone.
export async function sendBriefing(ui, chatId, { peek = false } = {}) {
  return withDb(openWatchDb, async (db) => {
    const b = await composeBriefing(db, chatId);
    await ui.send(chatId, b.html, { html: true, actions: b.keyboard, preview: false, what: 'the briefing' });
    if (!peek) b.markReported();
    return true;
  });
}

// The same briefing as plain text, for a terminal: each line carries the id to use with
// `bc list mark <id> …` or `bc remind done <id>` instead of a button.
export async function printBriefing(chatId, { peek = false } = {}) {
  return withDb(openWatchDb, async (db) => {
    const b = await composeBriefing(db, chatId, { terminal: true });
    if (!peek) b.markReported();
    const text = b.html
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    return {
      text,
      entries: b.listed.map((e, i) =>
        e.entry
          ? { n: i + 1, kind: e.entry.kind, id: e.entry.id, title: e.entry.title }
          : { n: i + 1, kind: 'item', id: e.id, title: e.title, date: e.event_date ?? null },
      ),
    };
  });
}

// What is open for one chat's briefing: the entries of its watches' lists and of the lists kept
// by hand that the owner put in the briefing (for the coming week).
function openFor(db, chatId) {
  const watches = listWatches(db, { activeOnly: true }).filter((w) => w.chat_id === chatId);
  for (const w of watches) expirePast(db, w.list_id);
  // A calendar event the list has from a mail too (its copy is marked as the same as that
  // entry) is shown once: as the calendar's, which has the time. The other stays on the list.
  const open = watches.flatMap((w) => listItems(db, w.list_id, { status: 'new,kept' }));
  const twins = new Set(open.filter(isCalendarItem).flatMap((c) => sameAsOf(c).flatMap((k) => (k.kind === 'list' ? [k.id] : []))));
  const everything = open.filter((i) => !twins.has(i.id));
  const byHand = new Map(briefingLists(db).map((l) => [l.id, l.name]));
  const handItems = [...byHand.keys()].flatMap((id) =>
    listItems(db, id, { status: 'new,kept' }).filter(
      (i) => i.event_date && i.event_date >= ymd(Date.now()) && i.event_date <= ymd(Date.now() + 7 * 86400000),
    ),
  );
  // (What the owner is waiting on somebody for is under a heading of its own, and so is what is
  // still to come, a booking or something on its way: not under a day.)
  const items = [...everything.filter((i) => i.category !== WAITING && !COMING.includes(i.category)), ...handItems];
  return { watches, everything, items, byHand };
}

// The day an item belongs to: its own date, or the day it is due to be nudged.
const dayOf = (it) => it.event_date ?? (it.remind_ts ? ymd(it.remind_ts * 1000) : null);

// What is past its day and not dealt with, the latest first: entries whose day has gone, and the
// other parts' entries of a day gone (a reminder sent and not marked done). (A calendar event
// is never past: it leaves the list when its day has gone.)
function pastOf(items, others, today) {
  const day = (t) => (t.entry ? t.entry.day : dayOf(t));
  return [
    ...others.filter((e) => e.day < today).map((e) => ({ entry: e })),
    ...items.filter((i) => !isCalendarItem(i) && dayOf(i) && dayOf(i) < today),
  ].sort((a, b) => day(b).localeCompare(day(a)));
}

// Past due shows this many; the rest are one line, with a button that lists them all.
const PAST_SHOWN = 5;
// Room kept for what is new, so that what is found is never crowded out by what is there every day.
const NEW_ROOM = 8;

// One numbered line of the briefing: an item of a list, or another part's entry (a reminder).
function lineOf(t, { byHand, told = new Set(), terminal }) {
  if (t.entry) return t.entry.line;
  const r = t;
  const today = ymd(Date.now());
  const tomorrow = ymd(Date.now() + 86400000);
  const where = [r.place, r.area].filter(Boolean).join(', ');
  const when = COMING.includes(r.category)
    ? ` · <i>${esc(
        r.category === 'booking'
          ? dateLabel(r.event_date ?? ymd(r.remind_ts * 1000))
          : r.remind_ts
            ? `due ${dateLabel(ymd((r.remind_ts - 86400) * 1000))}`
            : 'on its way',
      )}</i>${r.outcome === 'moved' ? ` · ${esc(cameTo(r))}` : ''}`
    : r.category === WAITING
      ? ` · <i>${[
          r.msg_ts ? `asked ${dateLabel(ymd(r.msg_ts * 1000))}` : null,
          told.has(r.id) ? 'no reply yet' : r.remind_ts ? `expected by ${dateLabel(ymd(r.remind_ts * 1000))}, ${hm(r.remind_ts)}` : null,
        ]
          .filter(Boolean)
          .map(esc)
          .join(' · ')}</i>${r.outcome === 'later' && r.outcome_text ? ` · ${esc(r.outcome_text)}` : ''}`
      : dayOf(r) && dayOf(r) < today
        ? ` · <i>due ${esc(agoLabel(dayOf(r)))}</i>`
        : r.event_date && r.event_date > tomorrow
          ? ` · <i>${esc(dateLabel(r.event_date))}</i>`
          : !r.event_date && r.remind_ts && dayOf(r) <= tomorrow
            ? ` · <i>${hm(r.remind_ts)}</i>`
            : '';
  // A calendar event shows its time first; anything else is a thing to do on that day.
  const cal = isCalendarItem(r);
  // (And who it is from, when somebody else organised it.)
  const by = cal && r.msg_sender ? ` · organised by ${esc(r.msg_sender)}` : '';
  return `${cal ? `📅 <i>${esc(r.summary ?? '')}</i> ` : ''}<b>${esc(r.title)}</b>${by}${byHand.has(r.list_id) ? ` · <i>${esc(byHand.get(r.list_id))}</i>` : ''}${where ? ` · ${esc(where)}` : ''}${when}${!cal && sameAsText(r) ? ` · ⚠️ <i>${esc(sameAsText(r, { terminal }))}</i>` : ''}${terminal ? ` [item ${r.id}]` : ''}`;
}
const actionOf = (t) => (t.entry ? t.entry.action : `wi:${t.id}:o`);

// Everything past due, from the button under the briefing: each with a number to open it.
export async function sendPastDue(ui, chatId) {
  const others = (await fromOthers({ chatId })).flatMap((x) => x.entries ?? []);
  return withDb(openWatchDb, async (db) => {
    const { items, byHand } = openFor(db, chatId);
    const past = pastOf(items, others, ymd(Date.now())).slice(0, 30);
    if (!past.length) return ui.send(chatId, 'Nothing is past due.');
    const lines = ['⏳ <b>Past due</b>', '', ...past.map((t, i) => `${i + 1}. ${lineOf(t, { byHand })}`)];
    lines.push('', 'Tap a number to open it: mark it done, or drop it if it no longer matters.');
    const cut = fitLines(lines, LIMIT, '<i>… more than fits here</i>');
    const kb = numbered(actions(), past.slice(0, cut.lines.filter((l) => /^\d+\. /.test(l)).length), actionOf);
    return ui.send(chatId, cut.lines.join('\n'), { html: true, actions: kb, preview: false, what: 'what is past due' });
  });
}

export async function composeBriefing(db, chatId, { terminal = false } = {}) {
  {
    // The calendar's events for the coming week are items of "Things I need to do".
    await syncAgenda(db);
    const { watches, everything, items, byHand } = openFor(db, chatId);
    const byId = new Map(watches.map((w) => [w.list_id, w]));
    const waiting = everything.filter((i) => i.category === WAITING);
    const told = new Set(waiting.filter((i) => wasNudged(db, i.id) || pendingNudge(db, i.id)).map((i) => i.id));
    const coming = everything.filter((i) => COMING.includes(i.category));
    const now = Date.now();
    const today = ymd(now);
    const tomorrow = ymd(now + 86400000);
    const weekEnd = ymd(now + 7 * 86400000);
    // What the other parts have to say: entries for the days (the reminders you set), and,
    // after the lists, what is not working.
    const said = await fromOthers({ chatId, terminal });
    const others = said.flatMap((x) => x.entries ?? []);
    // What's new, for the watches that report here rather than on a schedule of their own:
    // room is kept for it.
    const reportHere = watches.filter((x) => x.mode === 'briefing');
    const freshOf = (w) => items.filter((i) => i.list_id === w.list_id && i.status === 'new' && !isQuiet(w, i.category));
    const room =
      MAX_BRIEFING -
      Math.min(
        NEW_ROOM,
        reportHere.reduce((n, w) => n + freshOf(w).length, 0),
      );

    const listed = [];
    const out = [`☀️ <b>${esc(new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }))}</b>`];
    // Everything gets a number, so everything can be opened and dealt with: items from
    // watches, and the other parts' entries (a reminder, shown with ⏰).
    const put = (title, things) => {
      if (!things.length) return;
      out.push('', `<b>${esc(title)}</b>`);
      for (const t of things) {
        listed.push(t);
        out.push(`${listed.length}. ${lineOf(t, { byHand, told, terminal })}`);
      }
    };
    const section = (title, rows, entries = [], max = room) => {
      // Within a day: calendar events in time order (all-day ones first), then the rest.
      const order = (r) => (isCalendarItem(r) ? (/^all day/.test(r.summary ?? '') ? 0 : (r.msg_ts ?? 0)) : Number.MAX_SAFE_INTEGER);
      rows = rows
        .filter((r) => !listed.includes(r))
        .sort((x, y) => (dayOf(x) ?? '').localeCompare(dayOf(y) ?? '') || order(x) - order(y))
        .slice(0, Math.max(0, max - listed.length));
      entries = entries.slice(0, Math.max(0, max - listed.length - rows.length));
      put(title, [...entries.map((e) => ({ entry: e })), ...rows]);
    };
    const dueOn = (day) => others.filter((e) => e.day === day);

    // What is past its day comes first, the latest first; past a few, it is one line.
    const past = pastOf(items, others, today);
    put('Past due', past.slice(0, Math.min(PAST_SHOWN, room)));
    const rest = past.length - Math.min(PAST_SHOWN, room);
    if (rest > 0) out.push(`<i>…and ${rest} older: ${terminal ? 'bc remind list, bc watch list' : 'tap ⏳ below for all of them'}</i>`);
    section(
      'Today',
      items.filter((i) => dayOf(i) === today),
      dueOn(today),
    );
    section(
      'Tomorrow',
      items.filter((i) => dayOf(i) === tomorrow),
      dueOn(tomorrow),
    );
    section(
      'This week',
      items.filter((i) => dayOf(i) > tomorrow && dayOf(i) <= weekEnd).sort((a, b) => dayOf(a).localeCompare(dayOf(b))),
      others.filter((e) => e.day > tomorrow && e.day <= weekEnd),
    );
    section(
      'Coming up',
      coming.filter((i) => (i.event_date ?? ymd((i.remind_ts ?? 0) * 1000)) <= ymd(now + 30 * 86400000)),
    );
    section('Waiting on others', waiting);
    // What was answered, or done, in the last day is said once here, since nothing else says
    // it. What was done can be undone: it was ticked off by a reader, not by the owner.
    const closed = watches
      .flatMap((w) => listItems(db, w.list_id, { status: 'done' }))
      .filter((i) => (i.outcome_ts ?? 0) > now / 1000 - 86400);
    const answered = closed.filter((i) => i.category === WAITING && i.outcome === 'answered');
    if (answered.length) {
      if (!waiting.length) out.push('', '<b>Waiting on others</b>');
      for (const i of answered) out.push(`✓ <i>${esc(i.title.replace(/^Waiting on /, ''))}</i> · ${esc(cameTo(i))}`);
    }
    const done = closed.filter((i) => i.category !== WAITING && ['done', 'arrived', 'cancelled'].includes(i.outcome));
    if (done.length) {
      out.push('', '<b>Done, by the look of it</b>');
      for (const i of done) out.push(`✓ <i>${esc(i.title)}</i> · ${esc(cameTo(i))}${terminal ? ` [item ${i.id}]` : ''}`);
      if (terminal) out.push('Not done after all? bc list mark &lt;id&gt; open');
    }
    // (The room left is handed out in turns, so that one watch with much that is new does not take it all.)
    const fresh = [];
    const withNew = reportHere.map((w) => ({ w, rows: freshOf(w).filter((i) => !listed.includes(i)) })).filter((x) => x.rows.length);
    const give = withNew.map(() => 0);
    for (let left = MAX_BRIEFING - listed.length; left > 0 && give.some((g, k) => g < withNew[k].rows.length);)
      withNew.forEach((x, k) => {
        if (left > 0 && give[k] < x.rows.length) (give[k]++, left--);
      });
    withNew.forEach(({ w, rows }, k) => {
      section(`New · ${w.name}`, rows, [], listed.length + give[k]);
      fresh.push(...rows);
    });
    const older = items.filter(
      (i) =>
        byId.get(i.list_id)?.mode === 'briefing' && !listed.includes(i) && !past.includes(i) && !isQuiet(byId.get(i.list_id), i.category),
    ).length;

    // What other parts of blackcat have to say in a briefing (the checks: what is not working,
    // or that all is well), and then the health of blackcat itself.
    const problems = [...said.flatMap((x) => x.problems ?? []), ...(await systemLines())];
    if (!problems.length) for (const x of said) if (x.fine) out.push('', x.fine);
    if (problems.length) out.push('', ...problems);
    if (!listed.length && out.length === 1) out.push('', 'Nothing on today or tomorrow, and nothing new.');
    if (older) out.push('', `<i>${older} more on your lists: ${terminal ? 'bc watch list' : '/watch'}</i>`);
    if (listed.length)
      out.push(
        '',
        terminal
          ? 'To deal with one: bc list mark &lt;id&gt; done|open|drop · bc remind done|cancel|snooze|stop &lt;id&gt;. Or just tell me.'
          : 'Tap a number to open it, and to mark it done, keep it or drop it.',
      );

    const notes = said
      .filter((x) => x.note)
      .map((x) => `\n\n${x.note}`)
      .join('');
    // Too long for one message: the lists are cut at a line (never inside one, which would
    // break its formatting), the notes at the end kept whole, and what is not shown is not
    // numbered nor counted as told (it comes again next time).
    const cut = fitLines(out, LIMIT - notes.length, `<i>… more than fits here: ${terminal ? 'bc watch list' : '/watch'}</i>`);
    if (cut.dropped) listed.splice(Math.max(0, ...cut.lines.map((l) => Number(/^(\d+)\. /.exec(l)?.[1] ?? 0))));
    const kb = actions();
    numbered(kb, listed, (it) => (it.entry ? it.entry.action : `wi:${it.id}:o`));
    for (const i of done) kb.row().add(`↩ Not done: ${i.title.slice(0, 40)}`, `wi:${i.id}:k`);
    if (rest > 0) kb.row().add(`⏳ All ${past.length} past due`, 'wb:past');
    // And what the other parts offer to act on (a check that is not working: snooze it, say it is fixed).
    for (const b of said.flatMap((x) => x.buttons ?? [])) kb.row().add(b.label, b.id);
    return {
      html: [cut.lines.join('\n'), notes].join('').trim(),
      keyboard: kb,
      listed,
      // New items have now been reported: they stay on the list as "kept" until dealt with.
      markReported: () => fresh.filter((it) => listed.includes(it)).forEach((it) => setItemStatus(db, it.id, 'kept')),
    };
  }
}
