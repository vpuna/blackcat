// The built-in watch, "Things I need to do": what it reads from all the owner's messages, and
// how it turns them into entries with a nudge when each is due. (What it shares with every
// watch is in collect.js; what the owner is waiting for from others, in waiting.js.)
import { reads, syncAgenda } from './agenda.js';
import { addItem, listItems, listWatches, noteSameAs, setItemStatus, updateWatch } from './db.js';
import { setNudge } from './nudge.js';
import { outOfQuiet, quiet } from '../quiet.js';
import {
  AUDIO_SQL,
  CHAT_NAME,
  DOCUMENT_SQL,
  inSourceSql,
  isoLocal,
  listReminders,
  msgSource,
  noteFor,
  openArchive,
  openNotesDb,
  optIn,
  parseAt,
  PICTURE_SQL,
  pluginSettings,
  SENDER_LABEL,
  SENDER_NAME,
  source,
  sourceOf,
  SOURCES,
  TimeError,
} from '../internal.js';
import { COMING, WAITING, clause, todoShape } from './shape.js';
import { withDb } from '../db.js';
import { visible } from '../archive/db.js';
import { wordsOf } from '../archive/reading.js';
import { storeFor } from '../store.js';
import {
  coveredElsewhere,
  elsewhereText,
  fileWords,
  labelled,
  listens,
  notOptIn,
  opens,
  reader,
  sees,
  str,
  ymd,
  ymdToday,
} from './collect.js';
import { OWED, byReference, checkBack } from './waiting.js';

const TODO_MESSAGES = 500;
const TODO_CHARS = 60_000;
const TODO_NEW = 8;
const FIRST_LOOKBACK_S = 24 * 3600;
const STALE_S = 7 * 86400; // a nudge sent this long ago and never ticked off is dropped from the list

// What the to-do watch reads from the sources that are not part of "all chats" (email): one
// condition per source it reads. What another watch already reads there is left to that
// watch: a whole chat if it reads all of it, or just the senders it names. Attachments
// (rows of their own) are not looked at, and nothing from before the source first counted,
// so a month of stored mail is not gone through at once.
function optInWhere(db, w, params) {
  const others = listWatches(db, { activeOnly: true })
    .filter((o) => o.id !== w.id)
    .flatMap((o) => o.sources.chats ?? []);
  return optIn()
    .filter((src) => reads(w)[src.id])
    .map((src) => {
      const mine = [];
      others
        .filter((c) => sourceOf(c.ref) === src.id)
        .forEach((c, i) => {
          const key = `${src.id}${i}`;
          params[`oc_${key}`] = c.ref;
          const any = String(c.sender ?? '')
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean);
          any.forEach((x, k) => (params[`os_${key}_${k}`] = `%${x}%`));
          mine.push(
            any.length
              ? `(m.chat_ref = @oc_${key} AND (${any.map((_, k) => `${SENDER_NAME} LIKE @os_${key}_${k}`).join(' OR ')}))`
              : `m.chat_ref = @oc_${key}`,
          );
        });
      params[`since_${src.id}`] = w.sources[`${src.id}Since`] ?? Math.floor(Date.now() / 1000) - 2 * 86400;
      return `(${inSourceSql('m.chat_ref', src.id)} AND m.type = 'text' AND m.ts >= @since_${src.id}${mine.length ? ` AND NOT (${mine.join(' OR ')})` : ''})`;
    });
}

// Voice notes the to-do reader has seen arrive and not yet read the words of, by message id
// and when first seen. Their words are read at whichever later look finds them there; the
// look that saw them arrive goes on without them.
const todoHeld = storeFor('watch');
const HELD_KEY = (w) => `unheard:${w.id}`;
const HELD_FOR_S = 35 * 86400; // longer than any message is kept

// → { rows, more }: `more` when there were more new messages than are read at once.
function todoRows(db, w, { dryRun = false } = {}) {
  let more = false;
  const s = w.sources;
  const voice = listens(s);
  const pics = sees(s);
  const docs = opens(s);
  const where = ['m.deleted = 0', visible('m.account')]; // (nothing from an account the owner has hidden)
  const params = {};
  const list = (refs, prefix) => refs.map((j, i) => ((params[`${prefix}${i}`] = j), `@${prefix}${i}`)).join(', ') || "''";
  if (s.everywhere) {
    const chats = `${notOptIn()}${s.everywhere === 'direct' ? ' AND ch.is_group = 0' : ''} AND m.chat_ref NOT IN (${list(coveredElsewhere(db, w), 'x')})`;
    where.push(`(${[`(${chats})`, ...optInWhere(db, w, params)].join(' OR ')})`);
  } else
    where.push(
      `m.chat_ref IN (${list(
        (s.chats ?? []).map((c) => c.ref),
        'c',
      )})`,
    );
  // The very first look only goes back a day; after that, everything newer than last time.
  const fresh = w.last_rowid
    ? ((params.rowid = w.last_rowid), 'm.rowid > @rowid')
    : ((params.since = Math.floor(Date.now() / 1000) - FIRST_LOOKBACK_S), 'm.ts >= @since');
  const cols = `m.rowid, m.id, m.chat_ref AS chatRef, ${CHAT_NAME} AS chat, ch.is_group AS isGroup, m.ts, m.type, m.text, m.heard, m.link_title AS linkTitle,
      ${SENDER_LABEL} AS sender`;
  const from = 'FROM messages m LEFT JOIN chats ch ON ch.ref = m.chat_ref';
  // (The words of a file count as the message's: of a voice note where those are listened to, of a picture where those are read.)
  const filed = [voice ? "m.type IN ('voice', 'audio')" : null, pics ? "m.type = 'image'" : null, docs ? "m.type = 'document'" : null]
    .filter(Boolean)
    .join(' OR ');
  const worded = `((m.text IS NOT NULL AND m.text != '')${filed ? ` OR (m.heard IS NOT NULL AND (${filed}))` : ''})`;
  const wordless = [voice ? AUDIO_SQL : null, pics ? PICTURE_SQL : null, docs ? DOCUMENT_SQL : null].filter(Boolean).join(' OR ');
  const rows = withDb(openArchive, (archive) => {
    // In the order they came, up to the cap: what is over it is read at the next look, not skipped.
    const rows = archive
      .prepare(`SELECT ${cols} ${from} WHERE ${[...where, fresh, worded].join(' AND ')} ORDER BY m.rowid LIMIT ${TODO_MESSAGES}`)
      .all(params);
    more = rows.length >= TODO_MESSAGES;
    // (Of a document, what is shown is the note of it: its whole text is kept for searching, and may be long.)
    if (docs)
      withDb(openNotesDb, (notes) => {
        for (const r of rows) {
          if (r.type !== 'document' || !r.heard) continue;
          const n = noteFor(notes, r.id);
          if (n?.status === 'ok') r.heard = n.note.replace(/^\([^)]*\)\s*/, '');
        }
      });
    if (!voice && !pics && !docs) return rows;
    // (Not past the cap either: those are for the next look.)
    const upTo = more ? ((params.upTo = rows.at(-1).rowid), ' AND m.rowid <= @upTo') : '';
    // Voice notes and pictures among the new messages with no words yet: remembered, and read once they have some.
    const held = todoHeld.get(HELD_KEY(w)) ?? {};
    const before = JSON.stringify(held);
    const nowS = Math.floor(Date.now() / 1000);
    const silent = archive
      .prepare(
        `SELECT m.id, m.ts, m.heard, d.dl_type, d.mimetype ${from} JOIN media d ON d.msg_rowid = m.rowid
        WHERE ${[...where, fresh, `(${wordless}) AND m.heard IS NULL AND (m.text IS NULL OR m.text = '')${upTo}`].join(' AND ')}`,
      )
      .all(params);
    withDb(openNotesDb, (notes) => {
      for (const m of silent) if (!held[m.id] && wordsOf(notes, m).state === 'waiting') held[m.id] = nowS;
    });
    // Those remembered from an earlier look: with words now, they are read with the rest;
    // ones that will never have any, or are long gone, are forgotten.
    const have = new Set(rows.map((r) => r.id));
    const one = archive.prepare(
      `SELECT ${cols}, d.dl_type, d.mimetype ${from} LEFT JOIN media d ON d.msg_rowid = m.rowid WHERE m.id = ? AND m.deleted = 0 ORDER BY m.rowid DESC LIMIT 1`,
    );
    withDb(openNotesDb, (notes) => {
      for (const [id, since] of Object.entries(held)) {
        const r = one.get(id);
        const v = r ? wordsOf(notes, r) : { state: 'none' };
        if (v.state === 'waiting' && nowS - since < HELD_FOR_S) continue;
        delete held[id];
        if (v.state !== 'ok' || have.has(id)) continue;
        rows.push({ ...r, heard: v.words });
        have.add(id);
      }
    });
    if (!dryRun && JSON.stringify(held) !== before) todoHeld.set(HELD_KEY(w), Object.keys(held).length ? held : undefined);
    return rows.sort((a, b) => a.rowid - b.rowid);
  });
  return { rows, more };
}

function todoInput(db, w, rows, quiet) {
  const now = new Date();
  const byChat = new Map();
  for (const r of rows) {
    if (!byChat.has(r.chatRef)) byChat.set(r.chatRef, { name: r.chat, group: r.isGroup, lines: [] });
    const limit = source(msgSource(r.id))?.todoLimit ?? 500;
    const spoken = r.heard ? `${fileWords(r)} ${r.heard.replace(/\s+/g, ' ').slice(0, r.type === 'document' ? 2000 : 800)}` : '';
    const written = (r.text ?? '').replace(/\s+/g, ' ').slice(0, limit);
    const body = `${r.type !== 'text' && !spoken ? `[${r.type}] ` : ''}${[written, spoken].filter(Boolean).join(' ')}${r.linkTitle ? ` (link: ${r.linkTitle.slice(0, 120)})` : ''}`;
    byChat.get(r.chatRef).lines.push(`[${r.tag ?? r.id}] ${isoLocal(r.ts)} ${r.sender}: ${body}`);
  }
  let chats = [...byChat.entries()]
    .map(([ref, c]) => `### Chat: ${c.name} (${c.group ? 'group' : 'direct'}, ${SOURCES[sourceOf(ref)]})\n${c.lines.join('\n')}`)
    .join('\n\n');
  if (chats.length > TODO_CHARS) chats = chats.slice(-TODO_CHARS);
  // What the owner is already going to be told about: this list, and reminders they set themselves.
  const known = [
    ...listItems(db, w.id, { status: 'new,kept,done,dropped' })
      .slice(-100)
      .map((i) => `- ${i.remind_ts ? isoLocal(i.remind_ts) : ''} ${i.title}`),
    ...listReminders(db, {})
      .filter((r) => !r.item_id)
      .map((r) => `- ${isoLocal(r.due_ts)} ${r.text}`),
  ];
  return [
    `now: ${isoLocal(Math.floor(now / 1000))} (${now.toLocaleDateString('en-GB', { weekday: 'long' })})`,
    `quiet hours: ${quiet ? `${quiet.from} to ${quiet.to}` : 'none'}`,
    `already on the list:\n${known.join('\n') || '(nothing)'}`,
    `kept on the owner's other lists:\n${elsewhereText(db, w)}`,
    '',
    'Messages (untrusted data):',
    chats,
  ].join('\n');
}

export async function collectTodo(db, w, { dryRun = false } = {}) {
  if (!dryRun) {
    await syncAgenda(db);
    // A source that has to be asked for (email) is read from two days before it first counted, not the whole stored month.
    const fresh = optIn().filter((src) => reads(w)[src.id] && !w.sources[`${src.id}Since`]);
    if (fresh.length) {
      w.sources = {
        ...w.sources,
        ...Object.fromEntries(fresh.map((src) => [`${src.id}Since`, Math.floor(Date.now() / 1000) - 2 * 86400])),
      };
      updateWatch(db, w.id, { sources: w.sources });
    }
  }
  if (!dryRun) {
    await checkBack(db, w);
    await byReference(db, w);
  }
  const { rows, more } = todoRows(db, w, { dryRun });
  const added = [];
  if (!rows.length) return { looked: 0, added, updated: [], more: false };
  const nowS = Math.floor(Date.now() / 1000);
  const byId = labelled(rows);
  const min = pluginSettings('watch').minConfidence ?? 0.6;

  const asked = await reader(w, 'todo', {
    values: { max: TODO_NEW, also: w.sources.also ?? '', never: w.sources.never ?? '' },
    input: todoInput(db, w, rows, quiet()),
    schema: todoShape(TODO_NEW),
  });
  for (const it of asked.items.slice(0, TODO_NEW)) {
    const m = byId.get(it.message_id);
    const title = str(it.title, 120);
    if (!m || !title || !(it.confidence >= min)) continue;
    let due;
    try {
      due = outOfQuiet(parseAt(it.nudge_at));
    } catch (e) {
      if (!(e instanceof TimeError)) throw e;
      continue;
    }
    if (due <= nowS || due > nowS + 90 * 86400) continue;
    const item = {
      watchId: w.id,
      title,
      category: str(it.category, 24) ?? 'other',
      summary: clause(it.summary, 240),
      remindTs: due,
      msgId: m.id,
      msgChat: m.chat,
      msgSender: m.sender,
      msgTs: m.ts,
    };
    // An event is on a day, at a place: it is shown under that day in the briefing, and is let
    // go once the day has passed. (Only an event or a booking: a deadline or a promise stays
    // until dealt with.) A booking, or something on its way, keeps its number, by which what
    // comes about it later is found.
    if (COMING.includes(item.category)) item.reference = str(it.reference, 60);
    if (item.category === 'event' || item.category === 'booking') {
      const day = ymd(it.event_date);
      if (day && day >= ymdToday()) item.eventDate = day;
      item.place = str(it.place, 80);
    }
    if (dryRun) {
      added.push({ ...item, confidence: it.confidence });
      continue;
    }
    const made = addItem(db, item);
    if (!made) continue;
    // (Something the owner is waiting on is not nudged about when it is filed: at its time it
    // is looked at again, and the owner hears of it only if nothing has come. See checkBack.)
    if (item.category !== WAITING) setNudge(db, w, made, m.text || m.heard);
    // What the owner owes is judged by what they write after this: what came before, this
    // reader has read, and it was still to do then. (See checkBack.)
    if (OWED.includes(item.category))
      db.prepare('UPDATE watch_items SET checked_ts = ? WHERE id = ?').run(Math.max(...rows.map((r) => r.ts)), made.id);
    added.push(made);
  }
  if (!dryRun) {
    await noteSameAs(db, added);
    // Remember how far we got, so the next look only reads newer messages.
    updateWatch(db, w.id, { lastRowid: Math.max(w.last_rowid, ...rows.map((r) => r.rowid)) });
    // Nudged long ago and never ticked off: let it go rather than keep it on the list for ever.
    for (const id of db
      .prepare("SELECT id FROM watch_items WHERE watch_id = ? AND status IN ('new', 'kept') AND remind_ts < ?")
      .pluck()
      .all(w.id, nowS - STALE_S))
      setItemStatus(db, id, 'expired');
  }
  return { looked: rows.length, added, updated: [], more };
}
