import { fileURLToPath } from 'node:url';
import { docxText } from '../util/run.js';
import { NoModel } from '../engines/registry.js';
import { askReader } from '../readers.js';
import fs from 'node:fs';
import path from 'node:path';
import { openAgentDb } from '../agentdb.js';
import { upgrade } from '../db.js';
import { fetchMedia } from './media.js';
import { record } from '../activity/log.js';
import { chatHooks } from '../channels/hooks.js';
import { loaded, makeCtx } from '../plugins/registry.js';

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
const STEPS = [(db) => db.exec(SCHEMA)]; // 1: the table
export const openNotesDb = () => {
  const db = openAgentDb();
  upgrade(db, 'attachment-notes', STEPS);
  return db;
};

const IMAGES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
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
  return IMAGES.includes(t) || t === 'application/pdf' || t === DOCX || t.startsWith('text/');
}
// For SQL: the same test, on a `media` row aliased d.
export const READABLE_SQL = `(d.dl_type != 'sticker' AND (d.mimetype LIKE 'image/jpeg%' OR d.mimetype LIKE 'image/png%' OR d.mimetype LIKE 'image/gif%' OR d.mimetype LIKE 'image/webp%'
  OR d.mimetype LIKE 'application/pdf%' OR d.mimetype LIKE '${DOCX}%' OR d.mimetype LIKE 'text/%'))`;

// A voice note or an audio file is not read but listened to: turned into words on this
// machine by whichever plugin can (the voice plugin), with no model. Its note is those words.
const AUDIO_MAX_S = 5 * 60;
const listener = () => loaded().find((p) => chatHooks(p).voice);
export const canHear = () => !!listener();
export const hearable = (m) => ['ptt', 'audio'].includes(m.dl_type) || mime(m).startsWith('audio/');
export const AUDIO_SQL = "(d.dl_type IN ('ptt', 'audio') OR d.mimetype LIKE 'audio/%')";
// The helper that listens keeps the speech model in memory: let it go when the work is done.
export const doneHearing = async () => void (await chatHooks(listener() ?? {}).stop?.());

async function hear(file, m) {
  if ((m.seconds ?? 0) > AUDIO_MAX_S) throw new Unreadable(`it is ${Math.round(m.seconds / 60)} minutes long, too long to listen to`);
  const p = listener();
  if (!p) throw new Error('nothing to listen with is switched on');
  const t0 = Date.now();
  const r = (await chatHooks(p).voice(file, { ctx: makeCtx(p, { caller: 'owner', surface: 'job' }) })) ?? {};
  // How long it was and how long it took; never the words.
  record({
    kind: 'event',
    category: 'attachments',
    surface: 'job',
    ok: !r.error,
    ms: Date.now() - t0,
    summary: r.error ? 'a voice note was not transcribed' : `listened to ${r.seconds ?? '?'} s of audio`,
    data: { audioS: r.seconds ?? null, model: r.model ?? null, ...(r.error ? { error: String(r.error).slice(0, 120) } : {}) },
  });
  if (r.error) throw new Error(r.error);
  if (!r.text) throw new Unreadable('no words could be made out');
  return `(${r.seconds} s of speech, written down by a machine: a word or a name may be wrong) ${r.text}`;
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

class Unreadable extends Error {} // reading it again won't help

async function read(archive, m, model) {
  const got = await fetchMedia(archive, m.id).catch((e) => {
    throw new Unreadable(e.message);
  });
  if (got.source === 'thumbnail') throw new Unreadable(got.note ?? 'the file is no longer available');
  if (hearable(m)) return hear(got.path, m);
  const bytes = fs.statSync(got.path).size;
  const t = mime(m);
  if (IMAGES.includes(t)) {
    if (bytes > MAX_IMAGE) throw new Unreadable('the image is too large to read');
    return reader(
      [
        { type: 'image', source: { type: 'base64', media_type: t, data: fs.readFileSync(got.path).toString('base64') } },
        { type: 'text', text: QUESTION },
      ],
      model,
    );
  }
  if (t === 'application/pdf') {
    if (bytes > MAX_PDF) throw new Unreadable('the PDF is too large to read');
    return reader(
      [
        { type: 'document', source: { type: 'base64', media_type: t, data: fs.readFileSync(got.path).toString('base64') } },
        { type: 'text', text: QUESTION },
      ],
      model,
    );
  }
  const text = (
    t === DOCX
      ? await unzipText(got.path).catch((e) => {
          throw new Unreadable(e.message);
        })
      : fs.readFileSync(got.path, 'utf8')
  ).trim();
  if (!text) throw new Unreadable('the document has no text');
  return reader(`${QUESTION}\n\nThe attachment's text:\n${text.slice(0, MAX_TEXT)}`, model);
}

// The stored note for a message, if its file has been dealt with for good.
// → { status: 'ok' | 'unreadable', note } or null (not read yet, or worth another try).
export function noteFor(db, id) {
  const r = db.prepare('SELECT status, note, attempts FROM attachment_notes WHERE msg_id = ?').get(id);
  if (!r) return null;
  if (r.status === 'error') return r.attempts >= MAX_TRIES ? { status: 'unreadable', note: r.note } : null;
  return r;
}

// Read one attachment and keep the note. `archive` is the open archive; `m` has id, dl_type, mimetype.
// → { status: 'ok' | 'unreadable' | 'error', note }. 'error' may work next time (the model was busy, the network dropped).
export async function readAttachment(db, archive, m, { model = 'sonnet' } = {}) {
  const save = (status, note) => {
    db.prepare(
      `INSERT INTO attachment_notes (msg_id, status, note, created_ts) VALUES (?, ?, ?, ?)
      ON CONFLICT (msg_id) DO UPDATE SET status = excluded.status, note = excluded.note, attempts = attempts + 1, created_ts = excluded.created_ts`,
    ).run(m.id, status, note, Math.floor(Date.now() / 1000));
    return { status, note };
  };
  try {
    const note = (await read(archive, m, model)).trim().slice(0, NOTE_CHARS);
    return note ? save('ok', note) : save('unreadable', 'nothing could be read from it');
  } catch (e) {
    if (e instanceof NoModel) throw e; // nothing is wrong with the file: it waits for a model
    return save(e instanceof Unreadable ? 'unreadable' : 'error', e.message.slice(0, 300));
  }
}
