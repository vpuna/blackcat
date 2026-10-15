import { fileURLToPath } from 'node:url';
import { docxText } from '../util/run.js';
import { askReader } from '../readers.js';
import fs from 'node:fs';
import path from 'node:path';
import { openAgentDb } from '../agentdb.js';
import { upgrade } from '../db.js';
import { fetchMedia } from './media.js';
import { setHeard } from './db.js';
import { record } from '../activity/log.js';
import { loaded, makeCtx } from '../plugins/registry.js';

// What reads a kind on this machine: the first plugin that says it does, and is able to
// (the program it needs is installed). → { plugin, reader } or null
export function localReader(kind) {
  for (const p of loaded()) {
    const reader = (p.manifest.fileReaders ?? []).find((r) => {
      if (r.kind !== kind) return false;
      try {
        return r.ready ? !!r.ready() : true;
      } catch {
        return false;
      }
    });
    if (reader) return { plugin: p, reader };
  }
  return null;
}

// Keep a file's words with its message, for searching; the meaning index is told the chat
// changed. (The note is kept either way: this is for searching, and can fail without harm.)
export function keepWords(id, words, max) {
  try {
    const chat = setHeard(id, words, max);
    if (chat) import('./semantic.js').then((x) => x.noteChanged(chat)).catch(() => {});
  } catch {}
}

// Reading attachments: an image, PDF or document from the archive is downloaded and given
// to a model with no tools, which writes down what it says. That note is kept, so each
// file is read once however many features ask about it.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS attachment_notes (
  msg_id     TEXT PRIMARY KEY,
  status     TEXT NOT NULL,              -- ok | unreadable (final) | error (will be retried)
  note       TEXT,                       -- what the file says, or why it couldn't be read
  attempts   INTEGER NOT NULL DEFAULT 1,
  created_ts INTEGER NOT NULL
);
`;
const STEPS = [
  (db) => db.exec(SCHEMA), // 1: the table
  // 2: by what it was read ('local', 'model', or 'both': this machine first, then the model),
  //    and how sure the local reading was, 0 to 100. A status may also be 'empty': it was
  //    read, and there is nothing in it to read (a photo, to something that reads text).
  (db) => db.exec('ALTER TABLE attachment_notes ADD COLUMN by TEXT; ALTER TABLE attachment_notes ADD COLUMN score INTEGER;'),
  // 3: for looking back on how reading goes, and whether the level is right: the kind of
  //    file, the level in force when it was read, how long each reading took, and what this
  //    machine read when the model was asked as well (so the two can be compared later).
  (db) =>
    db.exec(`ALTER TABLE attachment_notes ADD COLUMN kind TEXT; ALTER TABLE attachment_notes ADD COLUMN level INTEGER;
      ALTER TABLE attachment_notes ADD COLUMN local_ms INTEGER; ALTER TABLE attachment_notes ADD COLUMN model_ms INTEGER;
      ALTER TABLE attachment_notes ADD COLUMN local_note TEXT;`),
];
export const openNotesDb = () => {
  const db = openAgentDb();
  upgrade(db, 'attachment-notes', STEPS);
  return db;
};

const IMAGES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DOC = 'application/msword'; // an old Word file: read on this machine only
const MAX_IMAGE = 3.7 * 1024 ** 2; // 5 MB once base64-encoded
const MAX_PDF = 20 * 1024 ** 2;
const MAX_TEXT = 40_000; // characters of a text document given to the model
const MAX_TRIES = 3;
export const NOTE_CHARS = 2500;

const mime = (m) => (m.mimetype ?? '').split(';')[0].trim().toLowerCase();

// Can this media message be read? `m` has dl_type and mimetype from the media table.
export function readable(m) {
  if (!m.mimetype || m.dl_type === 'sticker') return false;
  const t = mime(m);
  return IMAGES.includes(t) || t === 'application/pdf' || t === DOCX || t === DOC || t.startsWith('text/');
}

// A picture, as the kinds of file go (src/archive/reading.js).
export const isPicture = (m) => m.dl_type !== 'sticker' && IMAGES.includes(mime(m));
export const PICTURE_SQL = `(d.dl_type != 'sticker' AND (d.mimetype LIKE 'image/jpeg%' OR d.mimetype LIKE 'image/png%' OR d.mimetype LIKE 'image/gif%' OR d.mimetype LIKE 'image/webp%'))`;

// A document, as the kinds of file go: a PDF, a Word file, a text file.
export const isDocument = (m) => readable(m) && !isPicture(m);
export const DOCUMENT_SQL = `(d.mimetype LIKE 'application/pdf%' OR d.mimetype LIKE '${DOCX}%' OR d.mimetype LIKE '${DOC}%' OR d.mimetype LIKE 'text/%')`;

// A voice note or an audio file is not read but listened to: turned into words on this
// machine by whichever plugin can (the voice plugin), with no model. Its note is those words.
const AUDIO_MAX_S = 10 * 60;
// (Whichever plugin says it reads voice notes, and can now.)
const listener = () => localReader('voice');
export const hearable = (m) => ['ptt', 'audio'].includes(m.dl_type) || mime(m).startsWith('audio/');
export const AUDIO_SQL = "(d.dl_type IN ('ptt', 'audio') OR d.mimetype LIKE 'audio/%')";
// The helper that listens keeps the speech model in memory: let it go when the work is done.
export const doneHearing = async () => void (await listener()?.reader.stop?.());
// Blackcat is stopping: every reader lets go of what it keeps running.
export const stopReaders = () =>
  Promise.all(loaded().flatMap((p) => (p.manifest.fileReaders ?? []).map((r) => Promise.resolve(r.stop?.()).catch(() => {}))));

async function hear(file, m) {
  if ((m.seconds ?? 0) > AUDIO_MAX_S) throw new Unreadable(`it is ${Math.round(m.seconds / 60)} minutes long, too long to listen to`);
  const l = listener();
  if (!l) throw new Error('nothing to listen with is switched on');
  const t0 = Date.now();
  const r = (await l.reader.read(makeCtx(l.plugin, { caller: 'owner', surface: 'job' }), { file, seconds: m.seconds ?? null })) ?? {};
  // How long it was and how long it took; never the words.
  record({
    kind: 'event',
    category: 'attachments',
    surface: 'job',
    ok: !r.error,
    ms: Date.now() - t0,
    summary: r.error ? 'a voice note was not transcribed' : `listened to ${r.seconds ?? '?'} s of audio`,
    data: {
      id: m.id,
      file: 'voice',
      audioS: r.seconds ?? null,
      model: r.model ?? null,
      ...(Number.isFinite(r.score) ? { score: Math.round(r.score) } : {}),
      ...(r.error ? { error: String(r.error).slice(0, 120) } : {}),
    },
  });
  if (r.error) throw new Error(r.error);
  if (!r.text) throw new Unreadable('no words could be made out');
  // What was said is kept with the message too, so that a search finds it and whoever reads
  // the chat sees it; and the chat is indexed again, so that it is found by meaning.
  keepWords(m.id, r.text);
  const score = Number.isFinite(r.score) ? Math.max(0, Math.min(100, Math.round(r.score))) : null;
  return { note: `(${r.seconds} s of speech, written down by a machine: a word or a name may be wrong) ${r.text}`, score };
}

// The reader that writes down what a file says (readers/attachment.md). Its answer is text.
const here = path.dirname(fileURLToPath(import.meta.url));
const reader = (input, model) => askReader({ dir: here, part: 'archive', job: 'attachment', input, model, category: 'attachments' });
const QUESTION = 'Write down what this attachment says.';

const unzipText = async (file) => {
  const text = await docxText(file);
  if (text == null) throw new Error('the document could not be opened');
  return text;
};

export class Unreadable extends Error {} // reading it again won't help

// A picture file, given to the model. → what it says is in it (text)
export function askModelAboutPicture(file, m, model) {
  if (fs.statSync(file).size > MAX_IMAGE) throw new Unreadable('the image is too large to read');
  return reader(
    [
      { type: 'image', source: { type: 'base64', media_type: mime(m), data: fs.readFileSync(file).toString('base64') } },
      { type: 'text', text: QUESTION },
    ],
    model,
  );
}
// A document file, given to the model whole. → what it says (text)
export async function askModelAboutDocument(file, m, model) {
  const t = mime(m);
  if (t === 'application/pdf') {
    if (fs.statSync(file).size > MAX_PDF) throw new Unreadable('the PDF is too large to read');
    return reader(
      [
        { type: 'document', source: { type: 'base64', media_type: t, data: fs.readFileSync(file).toString('base64') } },
        { type: 'text', text: QUESTION },
      ],
      model,
    );
  }
  // (Its text cannot be taken out here, and a model is not given a file of this kind.)
  if (t === DOC) throw new Unreadable('an old Word file is read on this machine only: bc msg reading --documents both');
  const text = (
    t === DOCX
      ? await unzipText(file).catch((e) => {
          throw new Unreadable(e.message);
        })
      : fs.readFileSync(file, 'utf8')
  ).trim();
  if (!text) throw new Unreadable('the document has no text');
  return askModelAboutText(text, model);
}
// The text of a document, already taken out of it, given to the model to say what matters in it.
export const askModelAboutText = (text, model) => reader(`${QUESTION}\n\nThe attachment's text:\n${text.slice(0, MAX_TEXT)}`, model);

// Keep what came of reading a file. → { status, note }
export function saveNote(
  db,
  id,
  status,
  note,
  { by = null, score = null, kind = null, level = null, localMs = null, modelMs = null, local = null } = {},
) {
  db.prepare(
    `INSERT INTO attachment_notes (msg_id, status, note, created_ts, by, score, kind, level, local_ms, model_ms, local_note)
      VALUES (@id, @status, @note, @ts, @by, @score, @kind, @level, @localMs, @modelMs, @local)
    ON CONFLICT (msg_id) DO UPDATE SET status = excluded.status, note = excluded.note, attempts = attempts + 1, created_ts = excluded.created_ts,
      by = excluded.by, score = excluded.score, kind = excluded.kind, level = excluded.level, local_ms = excluded.local_ms,
      model_ms = excluded.model_ms, local_note = excluded.local_note`,
  ).run({ id, status, note, ts: Math.floor(Date.now() / 1000), by, score, kind, level, localMs, modelMs, local });
  return { status, note };
}

// Listen to one voice note or audio file. → its note, with what was said in it
async function listen(archive, m) {
  // (Gone for good: unreadable. Not to be had just now: an error, tried again later.)
  const got = await fetchMedia(archive, m.id).catch((e) => {
    throw e.gone ? new Unreadable(e.message) : new Error(e.message);
  });
  if (got.source === 'thumbnail') {
    const why = got.note ?? 'the file is no longer available';
    throw got.gone ? new Unreadable(why) : new Error(why);
  }
  return hear(got.path, m);
}

// The stored note for a message, if its file has been dealt with for good.
// → { status: 'ok' | 'unreadable', note } or null (not read yet, or worth another try).
export function noteFor(db, id) {
  const r = db.prepare('SELECT status, note, attempts, by, score FROM attachment_notes WHERE msg_id = ?').get(id);
  if (!r) return null;
  if (r.status === 'error') return r.attempts >= MAX_TRIES ? { status: 'unreadable', note: r.note } : null;
  return r;
}

// The same recording is often in two messages: a voice note that was forwarded. One that has
// been listened to gives its words to the other, with no listening. → true when it did.
export async function heardElsewhere(db, archive, m) {
  const twin = archive
    .prepare(
      `SELECT m2.id, m2.heard FROM media d JOIN media d2 ON d2.file_sha256 = d.file_sha256 AND d2.msg_rowid != d.msg_rowid
        JOIN messages m1 ON m1.rowid = d.msg_rowid JOIN messages m2 ON m2.rowid = d2.msg_rowid
      WHERE m1.id = ? AND d.file_sha256 IS NOT NULL AND m2.heard IS NOT NULL LIMIT 1`,
    )
    .get(m.id);
  if (!twin) return false;
  const note = noteFor(db, twin.id)?.note ?? `(speech, written down by a machine: a word or a name may be wrong) ${twin.heard}`;
  db.prepare(
    `INSERT INTO attachment_notes (msg_id, status, note, created_ts) VALUES (?, 'ok', ?, ?)
    ON CONFLICT (msg_id) DO UPDATE SET status = excluded.status, note = excluded.note, created_ts = excluded.created_ts`,
  ).run(m.id, note, Math.floor(Date.now() / 1000));
  keepWords(m.id, twin.heard);
  return true;
}

// Listen to one voice note and keep the note. `archive` is the open archive; `m` has id, dl_type, mimetype.
// → { status: 'ok' | 'unreadable' | 'error', note }. 'error' may work next time (the file could not be fetched just then).
// (What listens may say how sure it is, 0 to 100: that is kept with the note. Nothing is done with it yet.)
export async function readAttachment(db, archive, m) {
  const t0 = Date.now();
  const facts = { kind: 'voice', by: 'local' };
  try {
    const heard = await listen(archive, m);
    const note = heard.note.trim().slice(0, NOTE_CHARS);
    const more = { ...facts, score: heard.score, localMs: Date.now() - t0 };
    return note ? saveNote(db, m.id, 'ok', note, more) : saveNote(db, m.id, 'unreadable', 'nothing could be read from it', more);
  } catch (e) {
    return saveNote(db, m.id, e instanceof Unreadable ? 'unreadable' : 'error', e.message.slice(0, 300), { kind: 'voice' });
  }
}
