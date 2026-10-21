// The daily briefing: what is on the lists, the reminders of the day, what other parts of
// blackcat have to say, and what is not working. Sent at the times the owner chose, or shown
// on asking (bc watch briefing --print).
import { isCalendarItem, syncAgenda } from './agenda.js';
import { isQuiet } from './lists.js';
import { COMING, WAITING } from './shape.js';
import { pendingNudge, wasNudged } from '../reminders/nudges.js';
import { expirePast, listItems, listWatches, openWatchDb, sameAsText, setItemStatus } from './db.js';
import { actions, errMsg, esc, hm, listReminders, loaded, log, makeCtx, ymd } from '../internal.js';
import { withDb } from '../db.js';
import { dateLabel, numbered } from './chat.js';

// What the other parts of blackcat, and plugins, have for the briefing: each may offer
// `briefing` in its manifest, giving { problems: [html], fine: html | null, buttons?: [{ label, id }],
// note?: html } (a note is shown at the end, every time: what the model used).
export async function fromOthers() {
  const out = [];
  for (const p of loaded()) {
    if (!p.manifest.briefing) continue;
    try {
      const said = await p.manifest.briefing(makeCtx(p, { caller: 'job' }));
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
// `bc watch item <id> …` or `bc remind done <id>` instead of a button.
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
        e.reminder
          ? { n: i + 1, kind: 'reminder', id: e.reminder.id, title: e.reminder.text }
          : { n: i + 1, kind: 'item', id: e.id, title: e.title, date: e.event_date ?? null },
      ),
    };
  });
}

export async function composeBriefing(db, chatId, { terminal = false } = {}) {
  {
    // The calendar's events for the coming week are items of "Things I need to do".
    await syncAgenda(db);
    const watches = listWatches(db, { activeOnly: true }).filter((w) => w.chat_id === chatId);
    for (const w of watches) expirePast(db, w.id);
    const byId = new Map(watches.map((w) => [w.id, w]));
    // (What the owner is waiting on somebody for is under a heading of its own, not under the
    // day it will be looked at again: until then it says when an answer is expected, and
    // after that, that none has come.)
    const everything = watches.flatMap((w) => listItems(db, w.id, { status: 'new,kept' }));
    const waiting = everything.filter((i) => i.category === WAITING);
    const told = new Set(waiting.filter((i) => wasNudged(db, i.id) || pendingNudge(db, i.id)).map((i) => i.id));
    // (What is still to come, a booking or something on its way, is under "Coming up" too, not under a day.)
    const items = everything.filter((i) => i.category !== WAITING && !COMING.includes(i.category));
    const coming = everything.filter((i) => COMING.includes(i.category));
    // The day an item belongs to: its own date, or the day it is due to be nudged.
    const dayOf = (it) => it.event_date ?? (it.remind_ts ? ymd(it.remind_ts * 1000) : null);
    const now = Date.now();
    const today = ymd(now);
    const tomorrow = ymd(now + 86400000);
    const weekEnd = ymd(now + 7 * 86400000);
    // Reminders you set yourself (nudges are shown through their items). One that was sent
    // and never marked done stays under Today until you deal with it.
    const own = listReminders(db, { chatId }).filter((r) => !r.item_id);

    const listed = [];
    const out = [`☀️ <b>${esc(new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }))}</b>`];
    // Everything gets a number, so everything can be opened and dealt with: items from
    // watches, and reminders you set yourself (shown with ⏰).
    const section = (title, rows, reminders = []) => {
      // Within a day: calendar events in time order (all-day ones first), then the rest.
      const order = (r) => (isCalendarItem(r) ? (/^all day/.test(r.summary ?? '') ? 0 : (r.msg_ts ?? 0)) : Number.MAX_SAFE_INTEGER);
      rows = rows
        .filter((r) => !listed.includes(r))
        .sort((x, y) => (dayOf(x) ?? '').localeCompare(dayOf(y) ?? '') || order(x) - order(y))
        .slice(0, MAX_BRIEFING - listed.length);
      reminders = reminders.slice(0, MAX_BRIEFING - listed.length - rows.length);
      if (!rows.length && !reminders.length) return;
      out.push('', `<b>${esc(title)}</b>`);
      for (const r of reminders) {
        listed.push({ reminder: r });
        const due = ymd(r.due_ts * 1000);
        const when =
          r.status === 'sent' ? 'due earlier, not marked done' : due > tomorrow ? `${dateLabel(due)}, ${hm(r.due_ts)}` : hm(r.due_ts);
        out.push(
          `${listed.length}. ⏰ <b>${esc(r.text)}</b> · <i>${esc(when)}</i>${r.file ? ' 📎' : ''}${terminal ? ` [reminder ${r.id}]` : ''}`,
        );
      }
      for (const r of rows) {
        listed.push(r);
        const where = [r.place, r.area].filter(Boolean).join(', ');
        const when = COMING.includes(r.category)
          ? ` · <i>${esc(
              r.category === 'booking'
                ? dateLabel(r.event_date ?? ymd(r.remind_ts * 1000))
                : r.remind_ts
                  ? `due ${dateLabel(ymd((r.remind_ts - 86400) * 1000))}`
                  : 'on its way',
            )}</i>${/^Moved: /.test(r.summary ?? '') ? ` · ${esc(r.summary.replace(/^Moved: /, 'moved: '))}` : ''}`
          : r.category === WAITING
            ? ` · <i>${[
                r.msg_ts ? `asked ${dateLabel(ymd(r.msg_ts * 1000))}` : null,
                told.has(r.id)
                  ? 'no reply yet'
                  : r.remind_ts
                    ? `expected by ${dateLabel(ymd(r.remind_ts * 1000))}, ${hm(r.remind_ts)}`
                    : null,
              ]
                .filter(Boolean)
                .map(esc)
                .join(' · ')}</i>${/^Since then: /.test(r.summary ?? '') ? ` · ${esc(r.summary.replace(/^Since then: /, ''))}` : ''}`
            : r.event_date && r.event_date > tomorrow
              ? ` · <i>${esc(dateLabel(r.event_date))}</i>`
              : !r.event_date && r.remind_ts && dayOf(r) <= tomorrow
                ? ` · <i>${hm(r.remind_ts)}</i>`
                : '';
        // A calendar event shows its time first; anything else is a thing to do on that day.
        const cal = isCalendarItem(r);
        // (And who it is from, when somebody else organised it.)
        const by = cal && r.msg_sender ? ` · organised by ${esc(r.msg_sender)}` : '';
        out.push(
          `${listed.length}. ${cal ? `📅 <i>${esc(r.summary ?? '')}</i> ` : ''}<b>${esc(r.title)}</b>${by}${where ? ` · ${esc(where)}` : ''}${when}${sameAsText(r) ? ` · ⚠️ <i>${esc(sameAsText(r))}</i>` : ''}${terminal ? ` [item ${r.id}]` : ''}`,
        );
      }
    };
    const dueOn = (day) => own.filter((r) => (r.status === 'sent' ? day === today : ymd(r.due_ts * 1000) === day));

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
      own.filter((r) => r.status === 'pending' && ymd(r.due_ts * 1000) > tomorrow && ymd(r.due_ts * 1000) <= weekEnd),
    );
    section(
      'Coming up',
      coming.filter((i) => (i.event_date ?? ymd((i.remind_ts ?? 0) * 1000)) <= ymd(now + 30 * 86400000)),
    );
    section('Waiting on others', waiting);
    // What was answered, or done, in the last day is said once here, since nothing else says
    // it. What was done can be undone: it was ticked off by a reader, not by the owner.
    const closed = watches.flatMap((w) => listItems(db, w.id, { status: 'done' })).filter((i) => (i.checked_ts ?? 0) > now / 1000 - 86400);
    const answered = closed.filter((i) => i.category === WAITING && /^Answered: /.test(i.summary ?? ''));
    if (answered.length) {
      if (!waiting.length) out.push('', '<b>Waiting on others</b>');
      for (const i of answered)
        out.push(`✓ <i>${esc(i.title.replace(/^Waiting on /, ''))}</i> · ${esc(i.summary.replace(/^Answered: /, 'answered: '))}`);
    }
    const done = closed.filter((i) => i.category !== WAITING && /^(Done|Arrived|Cancelled): /.test(i.summary ?? ''));
    if (done.length) {
      out.push('', '<b>Done, by the look of it</b>');
      for (const i of done)
        out.push(
          `✓ <i>${esc(i.title)}</i> · ${esc(i.summary.replace(/^(Done|Arrived|Cancelled): /, (_, k) => `${{ Done: 'done', Arrived: 'arrived', Cancelled: 'cancelled' }[k]}: `))}${terminal ? ` [item ${i.id}]` : ''}`,
        );
      if (terminal) out.push('Not done after all? bc watch item &lt;id&gt; keep');
    }
    // What's new, for the watches that report here rather than on a schedule of their own.
    const fresh = [];
    for (const w of watches.filter((x) => x.mode === 'briefing')) {
      const rows = items.filter((i) => i.watch_id === w.id && i.status === 'new' && !isQuiet(w, i.category));
      section(`New · ${w.name}`, rows);
      fresh.push(...rows);
    }
    const older = items.filter(
      (i) => byId.get(i.watch_id).mode === 'briefing' && !listed.includes(i) && !isQuiet(byId.get(i.watch_id), i.category),
    ).length;

    // What other parts of blackcat have to say in a briefing (the checks: what is not working,
    // or that all is well), and then the health of blackcat itself.
    const said = await fromOthers();
    const problems = [...said.flatMap((x) => x.problems ?? []), ...(await systemLines())];
    if (!problems.length) for (const x of said) if (x.fine) out.push('', x.fine);
    if (problems.length) out.push('', ...problems);
    if (!listed.length && out.length === 1) out.push('', 'Nothing on today or tomorrow, and nothing new.');
    if (older) out.push('', `<i>${older} more on your lists: ${terminal ? 'bc watch list' : '/watch'}</i>`);
    if (listed.length)
      out.push(
        '',
        terminal
          ? 'To deal with one: bc watch item &lt;id&gt; done|keep|drop · bc remind done|cancel|snooze &lt;id&gt;. Or just tell me.'
          : 'Tap a number to open it, and to mark it done, keep it or drop it.',
      );

    const notes = said
      .filter((x) => x.note)
      .map((x) => `\n\n${x.note}`)
      .join('');
    const kb = actions();
    numbered(kb, listed, (it) => (it.reminder ? `rm:${it.reminder.id}:o` : `wi:${it.id}:o`));
    for (const i of done) kb.row().add(`↩ Not done: ${i.title.slice(0, 40)}`, `wi:${i.id}:k`);
    // And what the other parts offer to act on (a check that is not working: snooze it, say it is fixed).
    for (const b of said.flatMap((x) => x.buttons ?? [])) kb.row().add(b.label, b.id);
    return {
      // (The notes at the end are kept whole: what is cut, when it is too long, is the lists.)
      html: [out.join('\n').slice(0, 4000 - notes.length), notes].join('').trim(),
      keyboard: kb,
      listed,
      // New items have now been reported: they stay on the list as "kept" until dealt with.
      markReported: () => fresh.filter((it) => listed.includes(it)).forEach((it) => setItemStatus(db, it.id, 'kept')),
    };
  }
}
