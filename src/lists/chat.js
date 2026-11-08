// `/list` in the chat: a button for each list; a list's open entries, numbered. An entry is
// opened, and ticked off, by the same buttons as any entry on a list (wi:…, src/watch/chat.js).
import { SOURCES, actions, esc, msgSource } from '../internal.js';
import { withDb } from '../db.js';
import {
  allLists,
  getItem,
  getList,
  itemCounts,
  keptDays,
  lapsedItems,
  listItems,
  openWatchDb,
  seeList,
  watchOfList,
} from '../watch/db.js';
import { numbered } from '../watch/chat.js';
import { valuesOf } from '../watch/fields.js';
import { listLabel, listsOf } from '../watch/lists.js';

const MAX_SHOWN = 30;
const EXPIRED_PAGE = 25;

export function showLists(c) {
  return withDb(openWatchDb, (db) => {
    const lists = allLists(db);
    if (!lists.length)
      return c.reply('No lists yet. Ask me to start one, e.g. "make a list of my spare electronics, with how many of each".');
    const kb = actions();
    const lines = ['📋 <b>Your lists</b>', ''];
    lists.forEach((l, i) => {
      const n = itemCounts(db, l.id);
      lines.push(`${i + 1}. <b>${esc(l.name)}</b> · ${(n.new ?? 0) + (n.kept ?? 0)} open`);
      kb.add(`${i + 1}. ${l.name}`.slice(0, 40), `ll:${l.id}`).row();
    });
    return c.reply(lines.join('\n'), { html: true, actions: kb });
  });
}

const typeLabel = (w, key) => (key === 'other' ? 'Other' : w ? listLabel(key) : key);

// A list with entries of more than one type: a button for each type, and one for everything.
// (A type's button carries one of its entries, by which the type is found again: a type's
// name may be longer than a button can carry.)
export function typeMenu(db, l) {
  const w = watchOfList(db, l.id);
  const types = listsOf(db, l.id, w).filter((t) => t.count);
  if (types.length < 2) return null;
  const kb = actions();
  types.forEach((t, i) => {
    const one = listItems(db, l.id, { status: 'new,kept', list: t.key })[0];
    kb.add(`${typeLabel(w, t.key)} · ${t.count}${t.quiet ? ' 🔕' : ''}`.slice(0, 40), `lt:${l.id}:${one.id}`);
    if (i % 2 === 1) kb.row();
  });
  kb.row().add('Everything', `lt:${l.id}:*`);
  const gone = lapsedOf(db, l.id);
  if (gone.length) kb.row().add(`⌛ Expired · ${gone.length}`, `lx:${l.id}:0`);
  return { text: `📋 <b>${esc(l.name)}</b>: which?${types.some((t) => t.quiet) ? '\n🔕 = quiet, not in reports' : ''}`, actions: kb };
}

// One list as a message (or the entries of one type on it): its open entries with what each
// has, and a number to tap for each.
export function listMessage(db, l, key = null) {
  const w = watchOfList(db, l.id);
  const all = listItems(db, l.id, { status: 'new,kept', ...(key ? { list: key } : {}) });
  const items = all.slice(0, MAX_SHOWN);
  seeList(db, l.id);
  const head = `📋 <b>${esc(l.name)}${key ? ` · ${esc(typeLabel(w, key))}` : ''}</b>`;
  if (!items.length) return { text: `${head}\n\nNothing open on it.` };
  const out = [head, ''];
  items.forEach((it, i) => {
    const type = it.category && !key ? typeLabel(w, it.category) : null;
    const bits = [type, it.event_date, it.place, ...Object.entries(valuesOf(it)).map(([k, v]) => `${k}: ${v}`)].filter(Boolean);
    out.push(`${i + 1}. <b>${esc(it.title)}</b>${bits.length ? ` · ${esc(bits.join(' · '))}` : ''}`);
  });
  if (all.length > items.length) out.push('', `<i>${all.length - items.length} more: ask me, or bc list show ${l.id}</i>`);
  out.push('', 'Tap a number to open it, and to mark it done, keep it or drop it.');
  const kb = numbered(actions(), items, (it) => `wi:${it.id}:o`);
  const gone = key ? [] : lapsedOf(db, l.id);
  if (gone.length) {
    out.push('', `⌛ ${esc(expiredHead(gone))}`);
    kb.row().add(`⌛ Expired · ${gone.length}`, `lx:${l.id}:0`);
  }
  return { text: out.join('\n').slice(0, 4000), actions: kb };
}

// Undated entries no message has spoken of for longer than their source's days of history
// (src/watch/db.js lapseUndated): kept, out of the way, a tap from being open again.
const lapsedOf = lapsedItems;
// "Expired · older than 30 days (21)", or, from more than one source, "older than 30 days
// (WhatsApp) or 180 days (Email)".
export function expiredHead(items) {
  const by = new Map();
  for (const it of items) {
    const days = keptDays(it);
    if (days) by.set(days, [...(by.get(days) ?? []), SOURCES[msgSource(it.msg_id)] ?? 'other']);
  }
  const ds = [...by.entries()].sort((a, b) => a[0] - b[0]);
  const said = ds.length === 1 ? `${ds[0][0]} days` : ds.map(([d, srcs]) => `${d} days (${[...new Set(srcs)].join(', ')})`).join(' or ');
  return `Expired · older than ${said} (${items.length})`;
}

// The expired entries of a list, by type, a page at a time; "More" for the next page.
export function expiredMessage(db, l, page = 0) {
  const w = watchOfList(db, l.id);
  const gone = lapsedOf(db, l.id).sort((a, b) => typeLabel(w, a.category ?? 'other').localeCompare(typeLabel(w, b.category ?? 'other')));
  if (!gone.length)
    return {
      text: `📋 <b>${esc(l.name)}</b>

Nothing has expired on it.`,
    };
  const from = page * EXPIRED_PAGE;
  const shown = gone.slice(from, from + EXPIRED_PAGE);
  const out = [
    `📋 <b>${esc(l.name)}</b>
⌛ ${esc(expiredHead(gone))}`,
  ];
  let type = null;
  shown.forEach((it, i) => {
    const t = typeLabel(w, it.category ?? 'other');
    if (t !== type) out.push('', `<b>${esc(t)}</b>`);
    type = t;
    out.push(`${from + i + 1}. ${esc(it.title)}${it.place ? ` · ${esc(it.place)}` : ''}`);
  });
  out.push('', 'Tap a number to open it again, or to mark it done or drop it.');
  const kb = actions();
  shown.forEach((it, i) => {
    kb.add(String(from + i + 1), `wi:${it.id}:o`);
    if (i % 6 === 5) kb.row();
  });
  if (from + EXPIRED_PAGE < gone.length) kb.row().add(`More ▸ (${gone.length - from - EXPIRED_PAGE})`, `lx:${l.id}:${page + 1}`);
  return { text: out.join('\n').slice(0, 4000), actions: kb };
}

export function installLists(ui) {
  ui.action(/^lx:(\d+):(\d+)$/, async (c) =>
    withDb(openWatchDb, async (db) => {
      const l = getList(db, Number(c.match[1]));
      if (!l) return c.gone('That list no longer exists.');
      await c.toast();
      const m = expiredMessage(db, l, Number(c.match[2]));
      return c.reply(m.text, { html: true, ...(m.actions ? { actions: m.actions } : {}) });
    }),
  );
  ui.action(/^ll:(\d+)$/, async (c) =>
    withDb(openWatchDb, async (db) => {
      const l = getList(db, Number(c.match[1]));
      if (!l) return c.gone('That list no longer exists.');
      await c.toast();
      const m = typeMenu(db, l) ?? listMessage(db, l);
      return c.reply(m.text, { html: true, ...(m.actions ? { actions: m.actions } : {}) });
    }),
  );
  // A type chosen from that menu (by one of its entries), or everything.
  ui.action(/^lt:(\d+):(\d+|\*)$/, async (c) =>
    withDb(openWatchDb, async (db) => {
      const l = getList(db, Number(c.match[1]));
      if (!l) return c.gone('That list no longer exists.');
      const one = c.match[2] === '*' ? null : getItem(db, Number(c.match[2]));
      if (c.match[2] !== '*' && one?.list_id !== l.id) return c.gone('That is no longer on the list.');
      await c.toast();
      const m = listMessage(db, l, one ? (one.category ?? 'other') : null);
      return c.reply(m.text, { html: true, ...(m.actions ? { actions: m.actions } : {}) });
    }),
  );
}
