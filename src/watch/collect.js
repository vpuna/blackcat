import { NoModel } from '../engines/registry.js';
import {
  TODO,
  addItem,
  expirePast,
  getItem,
  listItems,
  listWatches,
  markSeen,
  removeItem,
  seenIds,
  noteSameAs,
  setItemStatus,
  updateItem,
} from './db.js';
import { isQuiet, listKey, listsOf } from './lists.js';
import { setNudge } from './nudge.js';
import {
  aboutOwner,
  archiveMeta as getMeta,
  askReader,
  AUDIO_SQL,
  CHAT_NAME,
  DOCUMENT_SQL,
  hearable,
  isDocument,
  isoLocal,
  listReminders,
  isPicture,
  msgSource,
  NOTE_CHARS,
  noteFor,
  notOptInSql,
  openArchive,
  openNotesDb,
  PICTURE_SQL,
  scheduleDue,
  SENDER_LABEL,
  SENDER_NAME,
  source,
} from '../internal.js';
import { LIST, TIDY, clause } from './shape.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDb } from '../db.js';
import { listening, readSince, reads as fileIsRead, wordsOf } from '../archive/reading.js';

const BATCH = 60; // messages per call to the model
const MAX_BATCHES = 12; // per run; a longer history continues on the next run
const MAX_KNOWN = 200; // list entries shown to the model so it can spot repeats
// What a message with no words is called, where it is shown as background.
export const WORDLESS = { voice: 'a voice note', audio: 'an audio file', image: 'a picture', video: 'a video', document: 'a document' };
const MAX_PER_MESSAGE = 10; // items one message (a newsletter, say) may put on the list

// Asking a reader of the watch's own (readers/*.md beside this file), for an answer of a given shape.
const here = path.dirname(fileURLToPath(import.meta.url));
// (Every one of them is told who reads what it writes: the instructions speak of "the owner",
// and what comes back is shown to that very person.)
const TO_YOU =
  'Whatever you write down (a title, a summary, a note of what something came to) is read by the owner themselves. Write it to them: "you" and "your", never "the owner", "the user" or their name. "You set Tuesday as the limit", not "The owner set Tuesday as the limit".';
export const reader = (w, job, { values, input, schema }) =>
  askReader({
    dir: here,
    part: 'watch',
    job,
    values,
    also: [TO_YOU, aboutOwner()].filter(Boolean).join('\n\n'),
    input,
    schema,
    category: `watch: ${w.name}`,
  });

// The chats where the owner writes to themselves: the WhatsApp chat with their own number,
// and Telegram's Saved Messages (recorded by the Telegram source as tg_me).
function selfRefs(archive) {
  const meta = getMeta(archive);
  return [meta.me ? `${meta.me.split(/[:@]/)[0]}@s.whatsapp.net` : null, meta.tg_me ?? null].filter(Boolean);
}

// Messages this watch covers (the caller filters out the ones already examined).
// "All chats" never includes a source that has to be asked for by name (email).
export const notOptIn = () => notOptInSql('m.chat_ref');

function candidates(archive, w, covered = []) {
  const s = w.sources;
  const parts = [];
  const params = { rowid: w.last_rowid };
  if (s.everywhere) {
    covered.forEach((ref, i) => (params[`x${i}`] = ref));
    parts.push(
      `(${notOptIn()} AND ${s.everywhere === 'direct' ? 'ch.is_group = 0 AND ' : ''}m.chat_ref NOT IN (${covered.map((_, i) => `@x${i}`).join(', ') || "''"})${s.mine === false ? ' AND NOT m.from_me' : ''})`,
    );
  }
  (s.chats ?? []).forEach((c, i) => {
    params[`j${i}`] = c.ref;
    let cond = `m.chat_ref = @j${i}`;
    if (c.sender) {
      // One sender, or several separated by commas ("school.example, club.example"): any of them.
      const any = String(c.sender)
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
      any.forEach((x, k) => (params[`s${i}_${k}`] = `%${x}%`));
      cond += ` AND NOT m.from_me AND (${any.map((_, k) => `${SENDER_NAME} LIKE @s${i}_${k}`).join(' OR ')})`;
    } else if (s.mine === false) cond += ' AND NOT m.from_me';
    // (Switched on for a watch that was already running: only the owner's messages from then on.)
    else if (s.mineSince) ((params.mineSince = s.mineSince), (cond += ' AND (NOT m.from_me OR m.ts >= @mineSince)'));
    parts.push(`(${cond})`);
  });
  (s.self ? selfRefs(archive) : []).forEach((ref, i) => {
    params[`self${i}`] = ref;
    parts.push(`(m.chat_ref = @self${i} AND m.from_me)`);
  });
  if (!parts.length) return [];
  // A message that is only a file counts where that kind of file is read as it arrives: a
  // voice note whenever there is something to listen with (unless the watch says not), a
  // picture or a document from when the reading of those began. Its words are with it, and
  // one that turns out to have none is passed over.
  if (sees(s)) params.picsSince = readSince('pictures');
  if (opens(s)) params.docsSince = readSince('documents');
  const kinds = [
    listens(s) ? AUDIO_SQL : null,
    sees(s) ? `(${PICTURE_SQL} AND m.ts >= @picsSince)` : null,
    opens(s) ? `(${DOCUMENT_SQL} AND m.ts >= @docsSince)` : null,
  ].filter(Boolean);
  const hasFile = kinds.length ? ` OR (d.msg_rowid IS NOT NULL AND (${kinds.join(' OR ')}))` : '';
  return archive
    .prepare(
      `SELECT m.rowid, m.id, m.ts, m.type, m.text, m.link_url AS url, m.link_title AS linkTitle, m.link_desc AS linkDesc, ${CHAT_NAME} AS chat,
      ${SENDER_LABEL} AS sender,
      d.dl_type, d.mimetype, d.file_name AS fileName, d.seconds, m.heard
    FROM messages m LEFT JOIN chats ch ON ch.ref = m.chat_ref LEFT JOIN media d ON d.msg_rowid = m.rowid
    WHERE m.rowid > @rowid AND m.deleted = 0 AND (${parts.join(' OR ')})
      AND (${s.linksOnly ? 'm.link_url IS NOT NULL' : "(m.text IS NOT NULL AND m.text != '')"}${hasFile})
    ORDER BY m.rowid`,
    )
    .all(params);
}

// Does this watch read what was said in voice notes? (Yes, where they are listened to, unless
// switched off for it.) No watch listens itself: a voice note is written down when it arrives
// (archive/listen.js), and a watch reads the words.
export const listens = (s) => s.voice !== false && !s.linksOnly && listening();
// Does it read the text in pictures? (Yes, where pictures are read as they arrive.)
export const sees = (s) => !s.linksOnly && fileIsRead('pictures') && !!readSince('pictures');
// And the text of documents? (The same.)
export const opens = (s) => !s.linksOnly && fileIsRead('documents') && !!readSince('documents');
// What the words of a file are called, where they stand in for a message.
export const fileWords = (r) =>
  r.type === 'image'
    ? '(text in a picture, read by a machine)'
    : r.type === 'document'
      ? '(a document, read by a machine)'
      : '(a voice note, written down by a machine)';

// A reader names a message by what stands in square brackets before it. A long id (32
// characters from WhatsApp, a whole address for a mail) is easily taken for the one beside
// it, so such a message is shown under a short label instead ([m1], [m2] …).
// → what a reader named, by label or by id
const LONG_ID = 12;
export function labelled(rows) {
  const by = new Map();
  rows.forEach((r, i) => {
    r.tag = String(r.id).length > LONG_ID ? `m${i + 1}` : r.id;
    by.set(r.id, r);
  });
  for (const r of rows) if (!by.has(r.tag)) by.set(r.tag, r);
  return { get: (said) => by.get(String(said ?? '').replace(/^\[|\]$/g, '')) };
}

function lineOf(m) {
  // A chat message is short; a mail is not, and what matters is often further down.
  const text = (m.text ?? '').replace(/\s+/g, ' ').slice(0, source(msgSource(m.id))?.textLimit ?? 400);
  const preview =
    m.linkTitle || m.linkDesc
      ? ` | preview: ${[m.linkTitle, m.linkDesc].filter(Boolean).join(' – ').replace(/\s+/g, ' ').slice(0, 500)}`
      : m.url
        ? ' | preview: (none stored)'
        : '';
  // What kind of file it is: WhatsApp says so itself; for other sources it is told from the file's type.
  const named = m.fileName ? ` "${m.fileName}"` : '';
  const kind = hearable(m)
    ? m.dl_type === 'ptt' || m.type === 'voice'
      ? 'voice note'
      : `audio${named}`
    : m.dl_type === 'document'
      ? `document${named}`
      : m.dl_type === 'tg'
        ? 'file'
        : source(m.dl_type)
          ? `${(m.mimetype ?? '').startsWith('image/') ? 'picture' : 'document'}${named}`
          : m.dl_type;
  const file = !m.file
    ? ''
    : m.file.status === 'ok'
      ? ` | attachment: ${kind}, which says: ${m.file.note.replace(/\s*\n\s*/g, ' / ').slice(0, NOTE_CHARS)}`
      : ` | attachment: ${kind} (not read: ${m.file.note})`;
  const listed = m.listed?.length ? ` | already on the list from this message: ${m.listed.map((t) => `"${t}"`).join('; ')}` : '';
  const after = m.after?.length ? ` | said next: ${m.after.join(' / ')}` : '';
  const before = m.before?.length ? ` | said just before: ${m.before.join(' / ')}` : '';
  return `[${m.tag ?? m.id}] ${isoLocal(m.ts)} ${m.sender} in ${m.chat}: ${text || '(no text)'}${before}${preview}${after}${file}${listed}`;
}

// Put with each of these messages what its file says. No file is read here: its words are
// there already (a voice note, a picture and a document are read when they arrive), or it is
// marked as waiting for them (`m.unheard`), to be read at a later look without holding the
// rest up. A picture or a document with nothing in it and no caption has nothing to say (`m.nothing`).
function attach(todo, { voice, pics, docs }) {
  const filed = (m) => (pics && isPicture(m)) || (docs && isDocument(m));
  const wanted = (m) => (voice && hearable(m)) || filed(m);
  if (!todo.some(wanted)) return;
  withDb(openNotesDb, (db) => {
    for (const m of todo) {
      if (!wanted(m)) continue;
      const v = wordsOf(db, m);
      if (v.state === 'waiting') m.unheard = true;
      else if (v.state === 'ok')
        m.file = noteFor(db, m.id) ?? {
          status: 'ok',
          note: `${hearable(m) ? '(speech, written down by a machine: a word or a name may be wrong)' : '(read by a machine: a word may be wrong)'} ${v.words}`,
        };
      // What could not be read is said of a voice note and of a document (there was something
      // there, and the reader should know); a picture without text is only a picture.
      else if (hearable(m) || (isDocument(m) && noteFor(db, m.id)?.status === 'unreadable')) m.file = { status: 'unreadable', note: v.why };
      else m.nothing = !m.text;
    }
  });
}

export const ymd = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s ?? '') && !Number.isNaN(Date.parse(s)) ? s : null);
export const ymdToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const str = (v, n) => (typeof v === 'string' && v.trim() && v.trim().toLowerCase() !== 'null' ? v.trim().slice(0, n) : null);

// What the owner's other watches are keeping, for a reader to avoid filing the same thing a
// second time: each watch works alone, and the same matter told to two people would
// otherwise be on two lists. Open entries only, the latest first, and not the calendar's.
const MAX_ELSEWHERE = 50;
export function elsewhereText(db, w) {
  const rows = db
    .prepare(
      `SELECT i.title, i.summary, i.event_date, i.remind_ts, o.name AS list FROM watch_items i JOIN watches o ON o.id = i.watch_id
      WHERE i.watch_id != ? AND o.active = 1 AND i.status IN ('new', 'kept') AND (i.msg_id IS NULL OR i.msg_id NOT LIKE 'cal:%')
      ORDER BY i.id DESC LIMIT ?`,
    )
    .all(w.id, MAX_ELSEWHERE);
  // (With the start of what it is about: a title alone, "Coding awards programme", does not
  // say that it is the same as "register Leo for it".)
  const lines = rows.map(
    (r) =>
      `- [${r.list}] ${r.title}${r.event_date ? ` (${r.event_date})` : r.remind_ts ? ` (${isoLocal(r.remind_ts).slice(0, 10)})` : ''}${r.summary ? `: ${r.summary.replace(/\s+/g, ' ').slice(0, 120)}` : ''}`,
  );
  // And what the owner asked to be reminded of: that is being kept too.
  for (const r of listReminders(db, {}).filter((x) => x.status === 'pending' && x.source === 'user' && !x.item_id))
    lines.push(`- [a reminder they set, ${isoLocal(r.due_ts).slice(0, 10)}] ${r.text.replace(/\s+/g, ' ').slice(0, 160)}`);
  return lines.join('\n') || '(nothing)';
}

// What is already on the list, for the model to check new messages against. Things the owner
// marked done or dropped are included so they aren't added again.
function knownText(db, w) {
  const items = listItems(db, w.id, { status: 'new,kept,done,dropped' })
    .sort((a, b) => b.id - a.id)
    .slice(0, MAX_KNOWN);
  if (!items.length) return '(nothing yet)';
  return items
    .map(
      (i) =>
        `#${i.id} [${i.category ?? 'other'}] ${i.title}${i.event_date ? ` | ${i.event_date}` : ''}${i.place ? ` | ${i.place}` : ''}${i.summary ? ` | ${i.summary.slice(0, 160)}` : ''}`,
    )
    .join('\n');
}

// A later message about something already on the list: fill in or change its details.
function applyUpdate(db, w, it, m) {
  const cur = getItem(db, Number(it.existing_id));
  if (!cur || cur.watch_id !== w.id || !['new', 'kept'].includes(cur.status)) return null;
  const changed = it.changed === true;
  const patch = {};
  const date = ymd(it.event_date);
  if (date && date !== cur.event_date && (!cur.event_date || changed)) patch.eventDate = date;
  const place = str(it.place, 80);
  if (place && place !== cur.place && (!cur.place || changed)) patch.place = place;
  const summary = clause(it.summary, 240);
  if (summary && summary !== cur.summary) patch.summary = changed ? `Updated: ${clause(summary, 230)}` : summary;
  if (!Object.keys(patch).length) return null;
  // A real change to something already reported is worth reporting again.
  if (changed && cur.status === 'kept') patch.status = 'new';
  const out = updateItem(db, cur.id, patch);
  setNudge(db, w, out, m.linkTitle || m.text); // a new date moves the nudge
  return out;
}

// Look at new messages for one watch and add what fits. Returns { looked, added: [items], more }.
// Without a model a watch reads nothing and marks nothing as read: its messages wait, and
// are read when there is one. (`waiting`: why.)
export async function collect(db, w, opts = {}) {
  try {
    return await reading(db, w, opts);
  } catch (e) {
    if (!(e instanceof NoModel)) throw e;
    return { looked: 0, added: [], updated: [], more: false, waiting: e.message };
  }
}

async function reading(db, w, { dryRun = false } = {}) {
  if (w.builtin === TODO) return (await import('./todo.js')).collectTodo(db, w, { dryRun });
  const seen = seenIds(db, w.id);
  const all = withDb(openArchive, (archive) => {
    const found = candidates(archive, w, w.sources.everywhere ? coveredElsewhere(db, w) : []).filter((m) => !seen.has(m.id));
    // A link on its own says little. What was said straight after it ("I want this",
    // "let's go Saturday") often says what it is for, so a links-only watch reads that too.
    // A chat message often only makes sense after the lines before it ("let's talk to him
    // tonight"): the reader is shown those too, whoever wrote them, as background and not
    // as things to list. (Not for mail: the mail before it is another matter altogether.)
    // (A picture, a video or a voice note with no words is shown as that, so that "what do you
    // think of this?" is not read as being about nothing; a voice note already listened to, with what was heard.)
    const earlier = archive.prepare(`SELECT m.id, m.type, ${SENDER_LABEL} AS sender, m.text
      FROM messages m WHERE m.chat_ref = (SELECT chat_ref FROM messages WHERE rowid = @rowid) AND m.rowid < @rowid AND m.ts >= @ts - 900 AND m.deleted = 0
        AND ((m.text IS NOT NULL AND m.text != '') OR m.type IN (${Object.keys(WORDLESS)
          .map((t) => `'${t}'`)
          .join(', ')})) ORDER BY m.rowid DESC LIMIT 4`);
    const hears = listens(w.sources);
    const looks = sees(w.sources);
    const said = (notes, r) => {
      if (r.text) return r.text.replace(/\s+/g, ' ').slice(0, 120);
      const heard = (hears && ['voice', 'audio'].includes(r.type)) || (looks && r.type === 'image') ? noteFor(notes, r.id) : null;
      return heard?.status === 'ok'
        ? `(${WORDLESS[r.type]}: ${heard.note
            .replace(/^\([^)]*\)\s*/, '')
            .replace(/\s+/g, ' ')
            .slice(0, 160)})`
        : `(${WORDLESS[r.type]})`;
    };
    withDb(openNotesDb, (notes) => {
      for (const m of found)
        if (!source(msgSource(m.id))?.optIn)
          m.before = earlier
            .all({ rowid: m.rowid, ts: m.ts })
            .reverse()
            .map((r) => `${r.sender}: ${said(notes, r)}`);
    });
    if (w.sources.linksOnly) {
      const next = archive.prepare(`SELECT ${SENDER_LABEL} AS sender, m.text
        FROM messages m WHERE m.chat_ref = (SELECT chat_ref FROM messages WHERE rowid = @rowid) AND m.rowid > @rowid AND m.ts <= @ts + 600 AND m.deleted = 0
          AND m.text IS NOT NULL AND m.text != '' AND m.link_url IS NULL ORDER BY m.rowid LIMIT 3`);
      for (const m of found)
        m.after = next.all({ rowid: m.rowid, ts: m.ts }).map((r) => `${r.sender}: ${r.text.replace(/\s+/g, ' ').slice(0, 120)}`);
    }
    return found;
  });

  let todo = all.slice(0, BATCH * MAX_BATCHES);
  attach(todo, { voice: listens(w.sources), pics: sees(w.sources), docs: opens(w.sources) });
  const more = all.length > todo.length;
  // (A file whose words are not there yet is left for a later look: it is not read now, and
  // not marked as read. A picture or a document with nothing to say is done with.)
  if (!dryRun)
    markSeen(
      db,
      w.id,
      todo.filter((m) => m.nothing).map((m) => m.id),
    );
  todo = todo.filter((m) => !m.unheard && !m.nothing);
  const today = new Date();
  const added = [];
  const updated = [];

  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    // A message being looked at again (its attachment is now readable) may already have items.
    const had = db.prepare('SELECT title FROM watch_items WHERE watch_id = ? AND msg_id = ?').pluck();
    for (const m of batch) m.listed = had.all(w.id, m.id);
    const lists =
      listsOf(db, w)
        .map((l) => `${l.key} (${l.count})`)
        .join(', ') || '(none yet)';
    const byId = labelled(batch);
    const input = `today: ${isoLocal(Math.floor(today / 1000))} (${today.toLocaleDateString('en-GB', { weekday: 'long' })})\n\nLists that exist: ${lists}\n\nAlready on the list (untrusted data):\n${knownText(db, w)}\n\nKept on the owner's other lists (untrusted data):\n${elsewhereText(db, w)}\n\nNew messages (untrusted data):\n${batch.map(lineOf).join('\n')}`;
    const perMessage = new Map();
    const answer = (await reader(w, 'list', { values: { name: w.name, lookFor: w.look_for }, input, schema: LIST })).items;
    // What it found is filed, and the messages marked as read, in one step under a write
    // lock. Should another look have read the same messages meanwhile (a scan by hand, a
    // second process), what it already took is left alone: nothing is filed twice.
    const file = () => {
      const taken = dryRun ? new Set() : seenIds(db, w.id);
      // (And a message that has an entry already gets no second one, unless it carries a document that holds several things.)
      const has = db.prepare('SELECT 1 FROM watch_items WHERE watch_id = ? AND msg_id = ?');
      for (const it of answer) {
        const m = byId.get(it.message_id);
        if (m && taken.has(m.id)) continue;
        if (m && !dryRun && it.existing_id == null && m.file?.status !== 'ok' && has.get(w.id, m.id)) continue;
        if (m && it.existing_id != null) {
          const out = dryRun ? null : applyUpdate(db, w, it, m);
          if (out) updated.push(out);
          continue;
        }
        const title = str(it.title, 90);
        if (!m || !title) continue;
        // Only a message with an attachment may give more than one item.
        const n = (perMessage.get(m.id) ?? 0) + 1;
        if (n > (m.file?.status === 'ok' ? MAX_PER_MESSAGE : 1)) continue;
        perMessage.set(m.id, n);
        const item = {
          watchId: w.id,
          title,
          category: listKey(str(it.category, 24) ?? 'other'),
          place: str(it.place, 80),
          area: str(it.area, 60),
          eventDate: ymd(it.event_date),
          summary: clause(it.summary, 240),
          url: m.url,
          msgId: m.id,
          msgChat: m.chat,
          msgSender: m.sender,
          msgTs: m.ts,
        };
        if (dryRun) {
          added.push({ ...item, confidence: it.confidence });
          continue;
        }
        const made = addItem(db, item);
        if (!made) continue; // that link or message is already on the list
        // A quiet list is never reported, so there is nothing "new" about its items.
        if (isQuiet(w, made.category)) setItemStatus(db, made.id, 'kept');
        else added.push(made);
        setNudge(db, w, made, m.linkTitle || m.text);
      }
      // Remember what has been examined after every batch, so an interrupted long history run resumes.
      if (!dryRun)
        markSeen(
          db,
          w.id,
          batch.map((m) => m.id),
        );
    };
    if (dryRun) file();
    else {
      const before = added.length;
      db.transaction(file).immediate();
      await noteSameAs(db, added.slice(before));
    }
  }
  if (!dryRun) expirePast(db, w.id);
  return { looked: todo.length, added, updated, more };
}

// Merge entries that are the same thing. Returns [{ kept: item, removed: [items] }].
export async function tidy(db, w, { dryRun = false } = {}) {
  const items = listItems(db, w.id, { status: 'new,kept' });
  if (items.length < 2) return [];
  const byId = new Map(items.map((i) => [i.id, i]));
  const input = items
    .map((i) => `#${i.id} ${i.title} | ${i.event_date ?? 'no date'} | ${i.place ?? 'no place'} | ${i.summary ?? ''}`)
    .join('\n');
  const used = new Set();
  const out = [];
  for (const g of (await reader(w, 'tidy', { values: { name: w.name }, input: `Entries:\n${input}`, schema: TIDY })).groups) {
    const group = [...new Set((Array.isArray(g.ids) ? g.ids : []).map(Number))]
      .filter((id) => byId.has(id) && !used.has(id))
      .map((id) => byId.get(id));
    if (group.length < 2) continue;
    group.forEach((i) => used.add(i.id));
    // Keep the one already reported if there is one, otherwise the earliest.
    const keep = group.find((i) => i.status === 'kept') ?? group.reduce((a, b) => (a.id < b.id ? a : b));
    const removed = group.filter((i) => i !== keep);
    if (!dryRun) {
      const patch = {};
      const date = ymd(g.event_date);
      if (date && !keep.event_date) patch.eventDate = date;
      if (str(g.place, 80) && !keep.place) patch.place = str(g.place, 80);
      if (str(g.summary, 240)) patch.summary = str(g.summary, 240);
      // The duplicates go first: a link can only be on a list once.
      for (const r of removed) (setItemStatus(db, r.id, 'dropped'), removeItem(db, r.id));
      const url = keep.url ? null : removed.find((i) => i.url)?.url;
      if (url) patch.url = url;
      // One nudge per thing: the duplicates' went with them; the kept entry has (or gets) its own.
      setNudge(db, w, updateItem(db, keep.id, patch));
      out.push({ kept: getItem(db, keep.id), removed });
    } else out.push({ kept: keep, removed });
  }
  return out;
}

// ---------- which chats another watch already covers ----------

// Chats that have a watch of their own are left out of a watch that looks everywhere,
// so nothing is picked up twice.
export function coveredElsewhere(db, w) {
  return [
    ...new Set(
      listWatches(db, { activeOnly: true })
        .filter((o) => o.id !== w.id)
        .flatMap((o) => (o.sources.chats ?? []).map((c) => c.ref)),
    ),
  ];
}

// ---------- when each watch looks ----------

// Active watches whose turn it is to look: a scheduled moment has passed since each last looked.
export function dueWatches(db, nowMs = Date.now()) {
  return listWatches(db, { activeOnly: true }).filter((w) => scheduleDue(w.scan.cron, w.last_scan, nowMs));
}
