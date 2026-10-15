import { isCalendarItem } from './agenda.js';
import { view } from './commands.js';
import { isQuiet, listLabel, listsOf } from './lists.js';
import { nudgeText } from './nudge.js';
import {
  expirePast,
  getItem,
  getWatch,
  itemCounts,
  listItems,
  listWatches,
  openWatchDb,
  sameAsText,
  setItemStatus,
  updateWatch,
} from './db.js';
import { actions, errMsg, esc, fmtWhen, log, scheduleDue } from '../internal.js';
import { withDb } from '../db.js';

const MAX_LISTED = 20;
// A button for each entry of a list, by its number, six to a row.
export function numbered(kb, list, data) {
  list.forEach((it, i) => {
    kb.add(String(i + 1), data(it));
    if (i % 6 === 5) kb.row();
  });
  return kb;
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function dateLabel(ymd) {
  const d = new Date(`${ymd}T12:00:00`);
  const days = Math.round((d - new Date(new Date().toDateString())) / 86400000 - 0.5);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `${DAY_NAMES[d.getDay()]} ${d.getDate()} ${d.toLocaleString('en-GB', { month: 'short' })}`;
}

const line = (n, it) => {
  const where = [it.place, it.area].filter(Boolean).join(', ');
  const same = sameAsText(it);
  return `${n}. <b>${esc(it.title)}</b>${where ? ` · ${esc(where)}` : ''}${it.event_date ? ` · <i>${esc(dateLabel(it.event_date))}</i>` : ''}${same ? ` · ⚠️ <i>${esc(same)}</i>` : ''}`;
};

// The detail card for one item: what it is, who sent it, the link, and what to do with it.
function card(it, { watchName, heading } = {}) {
  const where = [it.place, it.area].filter(Boolean).join(', ');
  const lines = [`${heading ?? '📌'} <b>${esc(it.title)}</b>`];
  const meta = [
    it.category && it.category !== 'other' ? cap(it.category) : null,
    where || null,
    it.event_date ? `📅 ${dateLabel(it.event_date)}` : null,
  ].filter(Boolean);
  if (meta.length) lines.push(esc(meta.join(' · ')));
  if (it.summary) lines.push(esc(it.summary));
  const same = sameAsText(it);
  if (same) lines.push(`⚠️ <i>This ${esc(same)}: if it is, drop one.</i>`);
  if (it.msg_sender && isCalendarItem(it))
    lines.push(
      `<i>Organised by ${esc(it.msg_sender)}${it.msg_chat ? ` · ${esc(it.msg_chat)}` : ''}${watchName ? ` · list: ${esc(watchName)}` : ''}</i>`,
    );
  else if (it.msg_sender)
    lines.push(
      `<i>From ${esc(it.msg_sender)}${it.msg_chat && it.msg_chat !== it.msg_sender ? ` in ${esc(it.msg_chat)}` : ''}${it.msg_ts ? `, ${esc(fmtWhen(it.msg_ts))}` : ''}${watchName ? ` · list: ${esc(watchName)}` : ''}</i>`,
    );
  if (it.url) lines.push(esc(it.url));
  if (it.file) lines.push('📎 Picture below');
  return lines.join('\n\n');
}

const itemActions = (id) => actions().add('✅ Did it', `wi:${id}:d`).add('📌 Keep', `wi:${id}:k`).add('🗑 Not interested', `wi:${id}:x`);

// The most recent report time that has passed since the last report (or since the watch was made), or null.
const reportDue = (w, nowMs = Date.now()) => scheduleDue(w.report, Math.max(w.last_digest ?? 0, w.created_ts ?? 0), nowMs);

// The scheduled report: what's new, anything with a date coming up, and what's still on the list.
// `peek` shows the list on demand without counting as the scheduled report.
export async function sendDigest(ui, db, w, { force = false, peek = false } = {}) {
  expirePast(db, w.id);
  // Quiet lists stay out of reports: they are only shown when asked for.
  const items = listItems(db, w.id, { status: 'new,kept' }).filter((i) => !isQuiet(w, i.category));
  const fresh = items.filter((i) => i.status === 'new');
  const kept = items.filter((i) => i.status === 'kept');
  const soon = (i) => i.event_date && (new Date(`${i.event_date}T12:00:00`) - Date.now()) / 86400000 <= 10;

  const listed = []; // in display order; position + 1 is the number shown
  const out = [`🗓 <b>${esc(w.name)}</b>${fresh.length ? ` · ${fresh.length} new` : ''}`];
  const section = (title, rows) => {
    rows = rows.filter((r) => !listed.includes(r)).slice(0, MAX_LISTED - listed.length);
    if (!rows.length) return;
    out.push('', `<b>${esc(title)}</b>`);
    for (const r of rows) {
      listed.push(r);
      out.push(line(listed.length, r));
    }
  };

  section(
    'Coming up',
    items.filter(soon).sort((a, b) => a.event_date.localeCompare(b.event_date)),
  );
  const cats = [...new Set(fresh.map((i) => i.category ?? 'other'))].sort(
    (a, b) => (a === 'unclear') - (b === 'unclear') || a.localeCompare(b),
  );
  for (const cat of cats)
    section(
      listLabel(cat),
      fresh.filter((i) => (i.category ?? 'other') === cat),
    );
  section('Still on the list', kept.slice(0, 5));
  const hidden = items.length - listed.length;

  if (!listed.length) {
    if (!force) return false; // nothing to say: don't send an empty report
    out.push('', 'Nothing on the list yet.');
  } else if (!fresh.length) out.splice(1, 0, '', 'Nothing new this time.');
  if (hidden > 0) out.push('', `<i>…and ${hidden} more. Ask me for the full list.</i>`);
  if (listed.length) out.push('', 'Tap a number for the link and to mark it done, keep it or drop it.');

  const kb = actions();
  numbered(kb, listed, (it) => `wi:${it.id}:o`);
  await ui.send(w.chat_id, out.join('\n'), { html: true, actions: kb, preview: false, what: `the report of "${w.name}"` });
  if (peek) return true;
  // Reported items stay on the list as "kept" until the owner does something with them.
  for (const it of fresh) setItemStatus(db, it.id, 'kept');
  updateWatch(db, w.id, { lastDigest: Math.floor(Date.now() / 1000) });
  return true;
}

// Alert-mode watches: tell the owner straight away, one card per new item.
export async function sendAlerts(ui, db, w, itemIds) {
  for (const id of itemIds) {
    const it = getItem(db, id);
    if (!it) continue;
    await ui
      .send(w.chat_id, card(it, { watchName: w.name, heading: '🔔' }), { html: true, actions: itemActions(it.id) })
      .catch((e) => log(`could not send alert: ${errMsg(e)}`));
    setItemStatus(db, it.id, 'kept');
  }
}

// Called by the scheduler: send any digest whose time has come (once, even if blackcat was off then).
export async function sendDueDigests(ui) {
  return withDb(openWatchDb, async (db) => {
    for (const w of listWatches(db, { activeOnly: true })) {
      if (w.mode !== 'digest') continue;
      if (!reportDue(w)) continue;
      try {
        const sent = await sendDigest(ui, db, w);
        if (!sent) updateWatch(db, w.id, { lastDigest: Math.floor(Date.now() / 1000) });
        log(`watch "${w.name}": ${sent ? 'report sent' : 'nothing to report'}`);
      } catch (e) {
        log(`watch "${w.name}" report failed, will retry: ${errMsg(e)}`);
      }
    }
  });
}

// ---------- the daily briefing ----------

// One list of a watch, with a numbered button per item.
async function sendList(ui, db, w, key) {
  const items = listItems(db, w.id, { status: 'new,kept', list: key }).slice(0, 30);
  if (!items.length) return ui.send(w.chat_id, `Nothing on ${esc(listLabel(key))} right now.`);
  const kb = actions();
  const out = [`📋 <b>${esc(w.name)} · ${esc(listLabel(key))}</b>${isQuiet(w, key) ? ' <i>(quiet: not in reports)</i>' : ''}`, ''];
  items.forEach((it, i) => {
    out.push(`${line(i + 1, it)}${it.file ? ' 📎' : ''}`);
  });
  numbered(kb, items, (it) => `wi:${it.id}:o`);
  out.push('', 'Tap a number for details, and to mark it done, keep it or drop it.');
  return ui.send(w.chat_id, out.join('\n').slice(0, 4000), { html: true, actions: kb, preview: false });
}

// "Show list" on a watch with several lists: choose one.
function listMenu(db, w) {
  const all = listsOf(db, w).filter((l) => l.count);
  const kb = actions();
  all.forEach((l, i) => {
    kb.add(`${l.label} · ${l.count}${l.quiet ? ' 🔕' : ''}`.slice(0, 40), `wl:${w.id}:${l.key}`.slice(0, 60));
    if (i % 2 === 1) kb.row();
  });
  kb.row().add('Everything', `wl:${w.id}:*`);
  return { text: `📋 <b>${esc(w.name)}</b>: which list?${all.some((l) => l.quiet) ? '\n🔕 = quiet, not in reports' : ''}`, keyboard: kb };
}

function watchCard(db, w) {
  const n = itemCounts(db, w.id);
  const v = view(w);
  return {
    text: [
      `👁 <b>${esc(w.name)}</b>${w.active ? '' : ' · ⏸ paused'}`,
      `<b>Looks for:</b> ${esc(w.look_for)}`,
      `<b>Watching:</b> ${esc(v.sourcesText)}`,
      `<b>Looks:</b> ${esc(v.looks)}`,
      `<b>Reports:</b> ${esc(v.schedule)} · ${esc(nudgeText(w.nudge))}`,
      `<b>List:</b> ${(n.new ?? 0) + (n.kept ?? 0)} to do (${n.new ?? 0} new since the last report) · ${n.done ?? 0} done · ${n.dropped ?? 0} dropped`,
    ].join('\n'),
    keyboard: actions()
      .add('📋 Show list', `wt:${w.id}:l`)
      .add('🔄 Check for new', `wt:${w.id}:c`)
      .row()
      .add(w.active ? '⏸ Pause' : '▶️ Resume', `wt:${w.id}:p`)
      .add('✅ Done ones', `wt:${w.id}:h`),
  };
}

// /watch: one button per watch. With a single watch, go straight to it.
export async function showWatches(c) {
  return withDb(openWatchDb, (db) => {
    const mine = listWatches(db).filter((w) => w.chat_id === c.chat);
    if (!mine.length)
      return c.reply(
        'No watches yet. Ask me to keep a tab on something, e.g. "collect the links Maya sends about things to do and send me the list every Thursday at 6".',
      );
    if (mine.length === 1) {
      const card1 = watchCard(db, mine[0]);
      return c.reply(card1.text, { html: true, actions: card1.keyboard });
    }
    const kb = actions();
    const lines = ['👁 <b>Your watches</b>', ''];
    mine.forEach((w, i) => {
      const n = itemCounts(db, w.id);
      lines.push(
        `${i + 1}. <b>${esc(w.name)}</b>${w.active ? '' : ' ⏸'} · ${(n.new ?? 0) + (n.kept ?? 0)} on the list${n.new ? `, ${n.new} new` : ''}\n    ${esc(view(w).schedule)}`,
      );
      kb.add(`${i + 1}. ${w.name}`.slice(0, 40), `wt:${w.id}:o`).row();
    });
    return c.reply(lines.join('\n'), { html: true, actions: kb });
  });
}

export function installWatches(ui) {
  ui.action(/^wt:(\d+):([olcph])$/, async (c) => {
    const [, id, what] = c.match;
    return withDb(openWatchDb, async (db) => {
      try {
        let w = getWatch(db, Number(id));
        if (!w || w.chat_id !== c.chat) return c.gone('That watch no longer exists.');
        if (what === 'o') {
          await c.toast();
          const card = watchCard(db, w);
          return c.reply(card.text, { html: true, actions: card.keyboard });
        }
        if (what === 'l') {
          await c.toast();
          if (listsOf(db, w).filter((l) => l.count).length > 1) {
            const m = listMenu(db, w);
            return c.reply(m.text, { html: true, actions: m.keyboard });
          }
          return sendDigest(ui, db, w, { force: true, peek: true });
        }
        if (what === 'h') {
          await c.toast();
          const done = listItems(db, w.id, { status: 'done' });
          return c.reply(
            done.length
              ? [
                  `✅ <b>Done from ${esc(w.name)}</b>`,
                  '',
                  ...done.slice(0, 30).map((it) => `• ${esc(it.title)}${it.place ? ` · ${esc(it.place)}` : ''}`),
                ].join('\n')
              : 'Nothing marked done yet.',
            { html: true },
          );
        }
        if (what === 'p') {
          w = updateWatch(db, w.id, { active: w.active ? 0 : 1 });
          await c.toast(w.active ? 'Resumed' : 'Paused');
          const card = watchCard(db, w);
          return c.edit(card.text, { html: true, actions: card.keyboard }).catch(() => {});
        }
        // 'c': look at new messages now. This can take a little while, so answer first.
        await c.toast('Checking…');
        await c.working().catch(() => {});
        const { collect } = await import('./collect.js');
        const r = await collect(db, w);
        if (!r.added.length)
          return c.reply(
            r.looked
              ? `Looked at ${r.looked} new message${r.looked === 1 ? '' : 's'}. Nothing for the list.`
              : 'No new messages since the last check.',
          );
        await c.reply(`Found ${r.added.length} new for "${w.name}".`);
        return sendDigest(ui, db, getWatch(db, w.id), { force: true, peek: true });
      } catch (e) {
        log(`watch button failed: ${errMsg(e)}`);
        return c.reply(`😿 ${errMsg(e)}`).catch(() => {});
      }
    });
  });

  // A list chosen from the menu.
  ui.action(/^wl:(\d+):(.+)$/, async (c) => {
    return withDb(openWatchDb, async (db) => {
      const w = getWatch(db, Number(c.match[1]));
      if (!w || w.chat_id !== c.chat) return c.gone('That watch no longer exists.');
      await c.toast();
      return c.match[2] === '*' ? sendDigest(ui, db, w, { force: true, peek: true }) : sendList(ui, db, w, c.match[2]);
    });
  });

  // The ui's middleware has already checked this is a paired account in a private chat.
  ui.action(/^wi:(\d+):([odkx])$/, async (c) => {
    const [, id, what] = c.match;
    return withDb(openWatchDb, async (db) => {
      const it = getItem(db, Number(id));
      const w = it && getWatch(db, it.watch_id);
      if (!it || !w || w.chat_id !== c.chat) return c.gone('That item is no longer on the list.');
      if (what === 'o') {
        await c.toast();
        await c.reply(card(it, { watchName: w.name }), { html: true, actions: itemActions(it.id) });
        if (it.file) await ui.sendFile(w.chat_id, it.file).catch(() => {});
        return undefined;
      }
      const [status, label] = { d: ['done', '✅ Done'], k: ['kept', '📌 Kept on the list'], x: ['dropped', '🗑 Dropped'] }[what];
      setItemStatus(db, it.id, status);
      await c.toast(label);
      await c.edit(`${card(it, { watchName: w.name })}\n\n<b>${label}</b>`, { html: true }).catch(() => {});
    });
  });
}
