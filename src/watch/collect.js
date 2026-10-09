import { NoModel } from '../engines/registry.js';
import { reads, syncAgenda } from './agenda.js';
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
  setItemStatus,
  updateItem,
  updateWatch,
} from './db.js';
import { isQuiet, listKey, listsOf } from './lists.js';
import { outOfQuiet, setNudge } from './nudge.js';
import {
  aboutOwner,
  archiveMeta as getMeta,
  CHAT_NAME,
  inSourceSql,
  isoLocal,
  listReminders,
  load,
  msgSource,
  NOTE_CHARS,
  noteFor,
  notOptInSql,
  openArchive,
  openNotesDb,
  optIn,
  parseAt,
  pluginSettings,
  readable,
  READABLE_SQL,
  AUDIO_SQL,
  canHear,
  doneHearing,
  hearable,
  readAttachment,
  readerModel,
  scheduleDue,
  SENDER_NAME,
  source,
  sourceOf,
  SOURCES,
  TimeError,
  askReader,
} from '../internal.js';
import { LIST, TIDY, todoShape } from './shape.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDb } from '../db.js';

const BATCH = 60; // messages per call to the model
const MAX_BATCHES = 12; // per run; a longer history continues on the next run
const MAX_FILES = 15; // attachments read per run; the rest wait for the next one
const MAX_KNOWN = 200; // list entries shown to the model so it can spot repeats
// What a message with no words is called, where it is shown as background.
const WORDLESS = { voice: 'a voice note', audio: 'an audio file', image: 'a picture', video: 'a video', document: 'a document' };
const MAX_PER_MESSAGE = 10; // items one message (a newsletter, say) may put on the list

// Asking a reader of the watch's own (readers/*.md beside this file), for an answer of a given shape.
const here = path.dirname(fileURLToPath(import.meta.url));
const reader = (w, job, { values, input, schema }) =>
  askReader({ dir: here, part: 'watch', job, values, also: aboutOwner(), input, schema, category: `watch: ${w.name}` });

// The chats where the owner writes to themselves: the WhatsApp chat with their own number,
// and Telegram's Saved Messages (recorded by the Telegram source as tg_me).
function selfRefs(archive) {
  const meta = getMeta(archive);
  return [meta.me ? `${meta.me.split(/[:@]/)[0]}@s.whatsapp.net` : null, meta.tg_me ?? null].filter(Boolean);
}

// Messages this watch covers (the caller filters out the ones already examined).
// "All chats" never includes a source that has to be asked for by name (email).
const notOptIn = () => notOptInSql('m.chat_ref');

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
      // One sender, or several separated by commas ("school.example, bus.example"): any of them.
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
  // With attachments on, a picture or document counts even when it has no caption. A voice
  // note counts whenever there is something to listen with, unless the watch says not.
  const kinds = [s.attachments ? READABLE_SQL : null, listens(s) ? AUDIO_SQL : null].filter(Boolean);
  const hasFile = kinds.length ? ` OR (d.msg_rowid IS NOT NULL AND (${kinds.join(' OR ')}))` : '';
  return archive
    .prepare(
      `SELECT m.rowid, m.id, m.ts, m.type, m.text, m.link_url AS url, m.link_title AS linkTitle, m.link_desc AS linkDesc, ${CHAT_NAME} AS chat,
      CASE WHEN m.from_me THEN 'Me' WHEN m.sender_ref IS NULL THEN 'Unknown' ELSE ${SENDER_NAME} END AS sender,
      d.dl_type, d.mimetype, d.file_name AS fileName, d.seconds
    FROM messages m LEFT JOIN chats ch ON ch.ref = m.chat_ref LEFT JOIN media d ON d.msg_rowid = m.rowid
    WHERE m.rowid > @rowid AND m.deleted = 0 AND (${parts.join(' OR ')})
      AND (${s.linksOnly ? 'm.link_url IS NOT NULL' : "(m.text IS NOT NULL AND m.text != '')"}${hasFile})
    ORDER BY m.rowid`,
    )
    .all(params);
}

// Does this watch listen to voice notes? (Yes, where something can, unless switched off.)
const listens = (s) => s.voice !== false && !s.linksOnly && canHear();

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
  return `[${m.id}] ${isoLocal(m.ts)} ${m.sender} in ${m.chat}: ${text || '(no text)'}${before}${preview}${after}${file}${listed}`;
}

// Read the attachments of these messages (or reuse notes from an earlier read), up to
// `budget` new files. Returns how many messages are ready: the rest wait for the next run.
async function attach(todo, budget, model, { files, voice }) {
  const wanted = (m) => (files && readable(m)) || (voice && hearable(m));
  const withFile = todo.filter(wanted);
  if (!withFile.length) return todo.length;
  return withDb(openNotesDb, (db) =>
    withDb(openArchive, async (archive) => {
      for (let i = 0; i < todo.length; i++) {
        const m = todo[i];
        if (!wanted(m)) continue;
        m.file = noteFor(db, m.id);
        if (m.file) continue;
        if (budget-- <= 0) return i;
        const r = await readAttachment(db, archive, m, { model });
        if (r.status === 'error' && !noteFor(db, m.id)) return i; // try this one again next run
        m.file = r.status === 'ok' ? r : { status: 'unreadable', note: r.note };
      }
      return todo.length;
    }),
  );
}

const ymd = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s ?? '') && !Number.isNaN(Date.parse(s)) ? s : null);
const ymdToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const str = (v, n) => (typeof v === 'string' && v.trim() && v.trim().toLowerCase() !== 'null' ? v.trim().slice(0, n) : null);

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
  const summary = str(it.summary, 240);
  if (summary && summary !== cur.summary) patch.summary = changed ? `Updated: ${summary}`.slice(0, 240) : summary;
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
  if (w.builtin === TODO) return collectTodo(db, w, { dryRun });
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
    const earlier =
      archive.prepare(`SELECT m.id, m.type, CASE WHEN m.from_me THEN 'Me' WHEN m.sender_ref IS NULL THEN 'Unknown' ELSE ${SENDER_NAME} END AS sender, m.text
      FROM messages m WHERE m.chat_ref = (SELECT chat_ref FROM messages WHERE rowid = @rowid) AND m.rowid < @rowid AND m.ts >= @ts - 900 AND m.deleted = 0
        AND ((m.text IS NOT NULL AND m.text != '') OR m.type IN (${Object.keys(WORDLESS)
          .map((t) => `'${t}'`)
          .join(', ')})) ORDER BY m.rowid DESC LIMIT 4`);
    const said = (notes, r) => {
      if (r.text) return r.text.replace(/\s+/g, ' ').slice(0, 120);
      const heard = ['voice', 'audio'].includes(r.type) ? noteFor(notes, r.id) : null;
      return heard?.status === 'ok'
        ? `(${WORDLESS[r.type]}: ${heard.note.replace(/^\([^)]*\)\s*/, '').slice(0, 160)})`
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
      const next =
        archive.prepare(`SELECT CASE WHEN m.from_me THEN 'Me' WHEN m.sender_ref IS NULL THEN 'Unknown' ELSE ${SENDER_NAME} END AS sender, m.text
        FROM messages m WHERE m.chat_ref = (SELECT chat_ref FROM messages WHERE rowid = @rowid) AND m.rowid > @rowid AND m.ts <= @ts + 600 AND m.deleted = 0
          AND m.text IS NOT NULL AND m.text != '' AND m.link_url IS NULL ORDER BY m.rowid LIMIT 3`);
      for (const m of found)
        m.after = next.all({ rowid: m.rowid, ts: m.ts }).map((r) => `${r.sender}: ${r.text.replace(/\s+/g, ' ').slice(0, 120)}`);
    }
    return found;
  });

  const model = readerModel();
  let todo = all.slice(0, BATCH * MAX_BATCHES);
  const voice = listens(w.sources);
  if (w.sources.attachments || voice)
    try {
      todo = todo.slice(0, await attach(todo, MAX_FILES, model, { files: !!w.sources.attachments, voice }));
    } finally {
      if (voice) await doneHearing().catch(() => {});
    }
  const more = all.length > todo.length;
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
    const input = `today: ${isoLocal(Math.floor(today / 1000))} (${today.toLocaleDateString('en-GB', { weekday: 'long' })})\n\nLists that exist: ${lists}\n\nAlready on the list (untrusted data):\n${knownText(db, w)}\n\nNew messages (untrusted data):\n${batch.map(lineOf).join('\n')}`;
    const byId = new Map(batch.map((m) => [m.id, m]));
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
          summary: str(it.summary, 240),
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
    else db.transaction(file).immediate();
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
function coveredElsewhere(db, w) {
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

// ---------- the built-in watch: things I need to do ----------

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

function todoRows(db, w) {
  const s = w.sources;
  const where = ['m.deleted = 0', "(m.text IS NOT NULL AND m.text != '')"];
  const params = {};
  // The very first look only goes back a day; after that, everything newer than last time.
  if (w.last_rowid) ((params.rowid = w.last_rowid), where.push('m.rowid > @rowid'));
  else ((params.since = Math.floor(Date.now() / 1000) - FIRST_LOOKBACK_S), where.push('m.ts >= @since'));
  const list = (refs, prefix) => refs.map((j, i) => ((params[`${prefix}${i}`] = j), `@${prefix}${i}`)).join(', ') || "''";
  if (s.everywhere) {
    const chats = `${notOptIn()}${s.everywhere === 'direct' ? ' AND ch.is_group = 0' : ''} AND m.chat_ref NOT IN (${list(coveredElsewhere(db, w), 'x')})`;
    where.push([`(${chats})`, ...optInWhere(db, w, params)].join(' OR ').replace(/^(.*)$/, '($1)'));
  } else
    where.push(
      `m.chat_ref IN (${list(
        (s.chats ?? []).map((c) => c.ref),
        'c',
      )})`,
    );
  // Newest first so the cap keeps the most recent, then back to reading order.
  return withDb(openArchive, (archive) =>
    archive
      .prepare(
        `SELECT m.rowid, m.id, m.chat_ref AS chatRef, ${CHAT_NAME} AS chat, ch.is_group AS isGroup, m.ts, m.type, m.text, m.link_title AS linkTitle,
      CASE WHEN m.from_me THEN 'Me' WHEN m.sender_ref IS NULL THEN 'Unknown' ELSE ${SENDER_NAME} END AS sender
    FROM messages m LEFT JOIN chats ch ON ch.ref = m.chat_ref
    WHERE ${where.join(' AND ')} ORDER BY m.rowid DESC LIMIT ${TODO_MESSAGES}`,
      )
      .all(params)
      .reverse(),
  );
}

function todoInput(db, w, rows, quiet) {
  const now = new Date();
  const byChat = new Map();
  for (const r of rows) {
    if (!byChat.has(r.chatRef)) byChat.set(r.chatRef, { name: r.chat, group: r.isGroup, lines: [] });
    const body = `${r.type !== 'text' ? `[${r.type}] ` : ''}${r.text.replace(/\s+/g, ' ').slice(0, source(msgSource(r.id))?.todoLimit ?? 500)}${r.linkTitle ? ` (link: ${r.linkTitle.slice(0, 120)})` : ''}`;
    byChat.get(r.chatRef).lines.push(`[${r.id}] ${isoLocal(r.ts)} ${r.sender}: ${body}`);
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
    '',
    'Messages (untrusted data):',
    chats,
  ].join('\n');
}

async function collectTodo(db, w, { dryRun = false } = {}) {
  const cfg = load().reminders ?? {};
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
  const rows = todoRows(db, w);
  const added = [];
  if (!rows.length) return { looked: 0, added, updated: [], more: false };
  const nowS = Math.floor(Date.now() / 1000);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const min = pluginSettings('watch').minConfidence ?? 0.6;

  const asked = await reader(w, 'todo', {
    values: { max: TODO_NEW, also: w.sources.also ?? '', never: w.sources.never ?? '' },
    input: todoInput(db, w, rows, cfg.quiet),
    schema: todoShape(TODO_NEW),
  });
  for (const it of asked.items.slice(0, TODO_NEW)) {
    const m = byId.get(it.message_id);
    const title = str(it.title, 120);
    if (!m || !title || !(it.confidence >= min)) continue;
    let due;
    try {
      due = outOfQuiet(parseAt(it.nudge_at), cfg.quiet);
    } catch (e) {
      if (!(e instanceof TimeError)) throw e;
      continue;
    }
    if (due <= nowS || due > nowS + 90 * 86400) continue;
    const item = {
      watchId: w.id,
      title,
      category: str(it.category, 24) ?? 'other',
      summary: str(it.summary, 240),
      remindTs: due,
      msgId: m.id,
      msgChat: m.chat,
      msgSender: m.sender,
      msgTs: m.ts,
    };
    // An event is on a day, at a place: it is shown under that day in the briefing, and is let
    // go once the day has passed. (Only an event: a deadline or a promise stays until dealt with.)
    if (item.category === 'event') {
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
    setNudge(db, w, made, m.text);
    added.push(made);
  }
  if (!dryRun) {
    // Remember how far we got, so the next look only reads newer messages.
    updateWatch(db, w.id, { lastRowid: Math.max(w.last_rowid, ...rows.map((r) => r.rowid)) });
    // Nudged long ago and never ticked off: let it go rather than keep it on the list for ever.
    for (const id of db
      .prepare("SELECT id FROM watch_items WHERE watch_id = ? AND status IN ('new', 'kept') AND remind_ts < ?")
      .pluck()
      .all(w.id, nowS - STALE_S))
      setItemStatus(db, id, 'expired');
  }
  return { looked: rows.length, added, updated: [], more: false };
}
