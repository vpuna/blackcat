// Reading the files that come with messages: voice notes, pictures, documents. It is done
// here, in one place, when a file arrives, and not by whatever happens to read the message:
// a job looks every minute for files with no words yet and has them read, one at a time. So
// by the time a watch reads a chat, or the owner searches, the words are with the message;
// and nothing that reads messages ever waits for a file.
//
// Who reads is the owner's choice, for each kind of file (`bc msg reading`):
//   off     nothing reads it
//   local   something on this machine does (a plugin that says so: `fileReaders` in its manifest)
//   model   the engine's model does, where it can take that kind of file
//   both    this machine first, and the model when that reading is not sure enough (the
//           default). Where the model cannot take the kind, the local reading stands.
// A local reading may say how sure it is, 0 to 100; under the level set for the kind, the
// file goes to the model.
//
// Voice notes, pictures and documents are all read here.
import { load, update } from '../config.js';
import { withDb } from '../db.js';
import { NoModel, engineName, modelNow } from '../engines/registry.js';
import { READER_KINDS, loaded, makeCtx } from '../plugins/registry.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { record } from '../activity/log.js';
import {
  AUDIO_SQL,
  DOCUMENT_SQL,
  NOTE_CHARS,
  PICTURE_SQL,
  Unreadable,
  askModelAboutDocument,
  askModelAboutPicture,
  askModelAboutText,
  isDocument,
  doneHearing,
  heardElsewhere,
  hearable,
  isPicture,
  keepWords,
  localReader,
  noteFor,
  openNotesDb,
  readAttachment,
  saveNote,
} from './attachments.js';

export { localReader };
import { openRead } from './db.js';
import { fetchMedia } from './media.js';
import { plural } from '../util/format.js';

export const KINDS = READER_KINDS;
export const MODES = ['off', 'local', 'model', 'both'];
// Under this, a local reading is not sure enough and the model is asked. (None for voice
// notes: what listens here does not say how sure it is.)
export const LEVELS = { pictures: 60, documents: 90 };
// A picture or a document older than this when reading began is left alone.
const PICTURES_BACK_S = 30 * 86400;
const FULL_TEXT = 40_000; // characters of a document's text kept with its message, for searching

// How a kind is read: { mode, level }. (Before there were modes, voice notes were on or off.)
export function reading(kind) {
  const a = load().archive ?? {};
  const r = a.reading?.[kind] ?? {};
  return { mode: r.mode ?? (kind === 'voice' && a.voiceNotes === false ? 'off' : 'both'), level: r.level ?? LEVELS[kind] ?? null };
}
export function setReading(kind, patch) {
  if (!KINDS.includes(kind)) throw new Error(`not a kind of file that is read: ${kind}`);
  if (patch.mode != null && !MODES.includes(patch.mode)) throw new Error(`a mode is one of: ${MODES.join(', ')}`);
  if (patch.level != null && !(Number.isInteger(patch.level) && patch.level >= 0 && patch.level <= 100))
    throw new Error('a level is a whole number from 0 to 100');
  update((cfg) => {
    const { voiceNotes: _was, ...archive } = cfg.archive ?? {};
    const now = { ...reading(kind), ...patch };
    const since = archive.reading?.[kind]?.since;
    return {
      ...cfg,
      archive: {
        ...archive,
        reading: {
          ...archive.reading,
          [kind]: { mode: now.mode, ...(now.level != null ? { level: now.level } : {}), ...(since ? { since } : {}) },
        },
      },
    };
  });
}

// Since when a kind has been read here (unix seconds), noted the first time the job finds it
// switched on. What reads messages takes in such files only from then on: the older ones are
// read for searching, and are not news to anyone.
export const readSince = (kind) => load().archive?.reading?.[kind]?.since ?? null;
function noteSince(kind) {
  if (readSince(kind) || !reads(kind)) return;
  update((cfg) => {
    const r = cfg.archive?.reading ?? {};
    return { ...cfg, archive: { ...cfg.archive, reading: { ...r, [kind]: { ...r[kind], since: Math.floor(Date.now() / 1000) } } } };
  });
}

// Can the model that reads for blackcat be given this kind of file? Its engine says.
export function modelTakes(kind) {
  const engine = loaded().find((p) => p.manifest.engine && p.name === engineName('readers'))?.manifest.engine;
  try {
    return !!engine?.takes?.().includes(kind);
  } catch {
    return false;
  }
}
// By what a kind is read, as things stand: { local, model }. Both false: nothing reads it.
export function ways(kind) {
  const { mode } = reading(kind);
  const local = !!localReader(kind);
  const model = modelTakes(kind);
  if (mode === 'off') return { local: false, model: false };
  if (mode === 'local') return { local, model: false };
  if (mode === 'model') return { local: false, model };
  // Both: this machine first. With nothing here to read it, it is not read at all: handing
  // every file to the model is a choice the owner makes by name ("model"), not a fallback.
  return { local, model: local && model };
}
export const reads = (kind) => {
  const w = ways(kind);
  return w.local || w.model;
};
// Voice notes are listened to on this machine or not at all, until a model can take audio.
export const listening = () => ways('voice').local;

// The files with no words yet and nothing final said of them: the newest first, so that
// what just arrived is ready for the next look and an older pile waits its turn.
export function unheard(archive, notes) {
  return archive
    .prepare(
      `SELECT m.id, m.ts, d.dl_type, d.mimetype, d.seconds FROM messages m JOIN media d ON d.msg_rowid = m.rowid
      WHERE ${AUDIO_SQL} AND m.deleted = 0 AND m.heard IS NULL ORDER BY m.ts DESC`,
    )
    .all()
    .filter((m) => !noteFor(notes, m.id) && !triedLately(notes, m.id));
}
const unreadOf = (archive, notes, kind, sql) => {
  const since = readSince(kind);
  if (!since) return [];
  return archive
    .prepare(
      `SELECT m.id, m.ts, d.dl_type, d.mimetype, d.file_name AS fileName FROM messages m JOIN media d ON d.msg_rowid = m.rowid
      WHERE ${sql} AND m.deleted = 0 AND m.heard IS NULL AND m.ts >= ? ORDER BY m.ts DESC`,
    )
    .all(since - PICTURES_BACK_S)
    .filter((m) => !noteFor(notes, m.id) && !triedLately(notes, m.id));
};
export const unseen = (archive, notes) => unreadOf(archive, notes, 'pictures', PICTURE_SQL);
export const unopened = (archive, notes) => unreadOf(archive, notes, 'documents', DOCUMENT_SQL);
// One that failed (the file could not be fetched just then, the helper fell over) is tried
// again, but not straight away: a few minutes of no network must not use up its tries.
const RETRY_AFTER_S = 10 * 60;
const triedLately = (notes, id) =>
  (notes.prepare("SELECT created_ts FROM attachment_notes WHERE msg_id = ? AND status = 'error'").pluck().get(id) ?? 0) >
  Math.floor(Date.now() / 1000) - RETRY_AFTER_S;
const kindOfFile = (m) => (hearable(m) ? 'voice' : isPicture(m) ? 'pictures' : 'documents');
const waiting = () =>
  withDb(openNotesDb, (notes) =>
    withDb(openRead, (archive) =>
      [
        ...(listening() ? unheard(archive, notes) : []),
        ...(reads('pictures') ? unseen(archive, notes) : []),
        ...(reads('documents') ? unopened(archive, notes) : []),
      ].sort((a, b) => b.ts - a.ts),
    ),
  );
// How many files are waiting to be read, of each kind. → { voice, pictures, documents }
export function waitingCount() {
  const out = { voice: 0, pictures: 0, documents: 0 };
  for (const m of waiting()) out[kindOfFile(m)]++;
  return out;
}
// Is there anything for the job to do: a file waiting, or a kind just switched on whose start is still to be noted?
export const somethingToRead = () => ['pictures', 'documents'].some((k) => reads(k) && !readSince(k)) || waiting().length > 0;
// What a run came to, in words: "listened to 2 voice notes, read 3 pictures (1 could not be)".
export function tallyText(tally, left = 0) {
  const part = (t, verb, one, many) =>
    t && t.done + t.failed ? `${verb} ${t.done} ${t.done === 1 ? one : many}${t.failed ? `, ${t.failed} could not be` : ''}` : null;
  const said = [
    part(tally.voice, 'listened to', 'voice note', 'voice notes'),
    part(tally.pictures, 'read', 'picture', 'pictures'),
    part(tally.documents, 'read', 'document', 'documents'),
  ]
    .filter(Boolean)
    .join(', ');
  return said ? `${said}${left ? `, ${left} left for later` : ''}` : '';
}

// Where a file stands, for whatever reads the message: its words, that it is still to be
// read, or that it never will have any (and why).
// → { state: 'ok', words } | { state: 'waiting' } | { state: 'none', why }
// (A document's words are its note: its whole text, kept for searching, may be far too long.)
export function wordsOf(notes, m) {
  const n = noteFor(notes, m.id);
  const noted = () => n.note.replace(/^\([^)]*\)\s*/, '');
  if (n?.status === 'ok') return { state: 'ok', words: isDocument(m) ? noted() : (m.heard ?? noted()) };
  if (m.heard) return { state: 'ok', words: m.heard };
  if (n) return { state: 'none', why: n.note };
  for (const [kind, is] of [
    ['pictures', isPicture],
    ['documents', isDocument],
  ]) {
    if (!is(m)) continue;
    const since = readSince(kind);
    return reads(kind) && since && (m.ts == null || m.ts >= since - PICTURES_BACK_S)
      ? { state: 'waiting' }
      : { state: 'none', why: `${kind} are not read here` };
  }
  return listening() ? { state: 'waiting' } : { state: 'none', why: 'nothing listens to voice notes here' };
}

// The words of one picture file. This machine first; the model when that reading is not
// sure enough against `level` (or alone, when `mode` is 'model'). Used for a picture that
// came with a message, and for one inside a document (a scanned page, a picture in a Word file).
// → { words, by, score, count, localMs, modelMs, unsure, localWords }, or with
//   `wait` (no model to be had, and nothing read here), `gone` (it can never be read: why) or `error`.
async function pictureWords(file, mimetype, { mode, level }) {
  const l = mode === 'model' ? null : localReader('pictures');
  const canModel = mode !== 'local' && modelTakes('pictures') && (mode === 'model' || !!l);
  const out = { words: '', by: null, score: null, count: null, localMs: null, modelMs: null, unsure: false, localWords: null };
  let local = null;
  if (l) {
    const t1 = Date.now();
    local = (await l.reader.read(makeCtx(l.plugin, { caller: 'owner', surface: 'job' }), { file, mime: mimetype })) ?? {};
    out.localMs = Date.now() - t1;
    if (local.error) return { ...out, error: String(local.error) };
    out.score = Number.isFinite(local.score) ? Math.round(local.score) : null;
    out.count = local.words ?? null;
    out.unsure = out.score != null && level != null && out.score < level;
    const extra = local.extra?.length ? `${local.text ? '\n' : ''}(also in the picture, read less surely: ${local.extra.join(' ')})` : '';
    out.localWords = `${local.text ?? ''}${extra}`.trim();
    out.plain = `${local.text ?? ''} ${(local.extra ?? []).join(' ')}`.trim(); // (the words alone, without what is said of them)
  }
  if (canModel && (!local || (mode === 'both' && out.unsure))) {
    const t2 = Date.now();
    try {
      const said = (await askModelAboutPicture(file, { mimetype }, modelNow('readers') ?? undefined)).trim();
      return { ...out, words: said, by: local ? 'both' : 'model', modelMs: Date.now() - t2 };
    } catch (e) {
      // No model just now, or it failed: what this machine read stands, said to be unsure.
      // With nothing read here, the picture waits and is tried again.
      if (!local)
        return e instanceof NoModel
          ? { ...out, wait: true, error: e.message }
          : e instanceof Unreadable
            ? { ...out, gone: e.message }
            : { ...out, error: e.message };
      out.modelFailed = e instanceof NoModel ? 'no model' : String(e.message).slice(0, 80);
    }
  }
  if (!local) return { ...out, gone: 'nothing here reads pictures' };
  return { ...out, words: out.localWords, by: 'local' };
}

// What is done with a file once it has been read: fetched to be read, not to be kept.
function letGo(got) {
  if (got.source !== 'download') return;
  fs.rmSync(got.path, { force: true });
  try {
    fs.rmdirSync(path.dirname(got.path)); // (its folder too, when nothing else is in it)
  } catch {}
}

// Read one picture and keep what it says.
// → { status: 'ok' | 'empty' | 'unreadable' | 'error', note }
const LOCAL_NOTE = '(text in a picture, read by a machine: a word may be wrong)';
const UNSURE_NOTE = '(text in a picture, read by a machine: some of it may be missing or wrong)';
const MODEL_NOTE = '(a picture, as a model read it)';
export async function readPicture(notes, archive, m) {
  const { mode, level } = reading('pictures');
  const t0 = Date.now();
  // What is recorded of each one: which message, by what it was read, how sure this machine
  // was and against what level, how many words, how long each reading took. Never the words.
  const facts = { id: m.id, file: 'picture', level };
  const say = (summary, data = {}) =>
    record({
      kind: 'event',
      category: 'attachments',
      surface: 'job',
      ok: !data.error,
      ms: Date.now() - t0,
      summary,
      data: { ...facts, ...data },
    });
  const got = await fetchMedia(archive, m.id).catch((e) => ({ error: e.message, gone: e.gone }));
  if (got.error || got.source === 'thumbnail') {
    const why = got.error ?? got.note ?? 'the file is no longer available';
    if (!got.gone) {
      // (No network, a source not running: tried again later, a few times.)
      say('a picture could not be fetched just now', { again: String(why).slice(0, 120) });
      return saveNote(notes, m.id, 'error', String(why).slice(0, 300), { kind: 'pictures' });
    }
    say('a picture could not be fetched', { gone: String(why).slice(0, 120) }); // (not a failure of anything here: the file is no longer to be had)
    return saveNote(notes, m.id, 'unreadable', why, { kind: 'pictures' });
  }
  try {
    const r = await pictureWords(got.path, m.mimetype, { mode, level });
    if (r.wait) return { status: 'error', note: r.error, wait: true };
    if (r.gone) return saveNote(notes, m.id, 'unreadable', r.gone, { kind: 'pictures' });
    if (r.error) {
      say('a picture could not be read', { error: r.error.slice(0, 120) });
      return saveNote(notes, m.id, 'error', r.error.slice(0, 300), { kind: 'pictures' });
    }
    if (r.modelFailed) facts.modelFailed = r.modelFailed;
    const model = r.by !== 'local';
    say(
      model
        ? `read a picture: by the model${r.by === 'both' ? ` (this machine was sure to ${r.score} of 100)` : ''}`
        : `read a picture: on this machine (${r.words ? `sure to ${r.score ?? '?'} of 100` : 'no text in it'})`,
      { by: r.by, score: r.score, words: r.count, localMs: r.localMs, ...(model ? { modelMs: r.modelMs } : {}) },
    );
    // (What this machine read is kept beside what the model read: to tell later whether it would have done.)
    const more = {
      by: r.by,
      score: r.score,
      kind: 'pictures',
      level,
      localMs: r.localMs,
      modelMs: r.modelMs,
      local: r.by === 'both' ? r.localWords.slice(0, 4000) : null,
    };
    if (!r.words) return saveNote(notes, m.id, 'empty', model ? 'there is nothing to read in it' : 'there is no text in it', more);
    const note = `${model ? MODEL_NOTE : r.unsure ? UNSURE_NOTE : LOCAL_NOTE} ${r.words}`.slice(0, 4000);
    const kept = saveNote(notes, m.id, 'ok', note, more);
    keepWords(m.id, note.replace(/^\([^)]*\)\s*/, ''));
    return kept;
  } finally {
    letGo(got);
  }
}

// Read one document and keep what it says. On this machine its text is taken out, exactly;
// a page that is a picture, or a picture inside it, is read as pictures are, against the
// level set for documents. The whole text is kept with the message, for searching. What
// reads the message is shown a note: the text itself when it is short, and what the model
// noted of it when it is longer than can be shown (in `both`; on this machine only, the
// beginning). With `model`, the model is given the document whole.
// → { status: 'ok' | 'empty' | 'unreadable' | 'error', note }
const DOC_NOTE = '(a document, its text taken out by a machine)';
const DOC_CUT = '(the document goes on from here: a search covers all of it)';
const DOC_NOTED = '(a document, as a model noted what it says)';
const DOC_MODEL = '(a document, as a model read it)';
const WORD = /[\p{L}\p{N}]{3,}/gu;
export async function readDocument(notes, archive, m) {
  const { mode, level } = reading('documents');
  const w = ways('documents');
  const t0 = Date.now();
  const facts = { id: m.id, file: 'document', level };
  const say = (summary, data = {}) =>
    record({
      kind: 'event',
      category: 'attachments',
      surface: 'job',
      ok: !data.error,
      ms: Date.now() - t0,
      summary,
      data: { ...facts, ...data },
    });
  const got = await fetchMedia(archive, m.id).catch((e) => ({ error: e.message, gone: e.gone }));
  if (got.error || got.source === 'thumbnail') {
    const why = got.error ?? got.note ?? 'the file is no longer available';
    if (!got.gone) {
      say('a document could not be fetched just now', { again: String(why).slice(0, 120) });
      return saveNote(notes, m.id, 'error', String(why).slice(0, 300), { kind: 'documents' });
    }
    say('a document could not be fetched', { gone: String(why).slice(0, 120) });
    return saveNote(notes, m.id, 'unreadable', why, { kind: 'documents' });
  }
  const failed = (e) => {
    if (e instanceof NoModel) return { status: 'error', note: e.message, wait: true };
    if (e instanceof Unreadable) return saveNote(notes, m.id, 'unreadable', e.message, { kind: 'documents' });
    say('a document could not be read', { error: String(e.message).slice(0, 120) });
    return saveNote(notes, m.id, 'error', String(e.message).slice(0, 300), { kind: 'documents' });
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blackcat-doc-'));
  try {
    if (!w.local) {
      // By the model alone: it is given the file.
      try {
        const said = (await askModelAboutDocument(got.path, m, modelNow('readers') ?? undefined)).trim();
        say('read a document: by the model', { by: 'model', modelMs: Date.now() - t0 });
        if (!said) return saveNote(notes, m.id, 'empty', 'there is nothing to read in it', { by: 'model', kind: 'documents' });
        const kept = saveNote(notes, m.id, 'ok', `${DOC_MODEL} ${said}`.slice(0, 4000), {
          by: 'model',
          kind: 'documents',
          modelMs: Date.now() - t0,
        });
        keepWords(m.id, said);
        return kept;
      } catch (e) {
        return failed(e);
      }
    }
    const l = localReader('documents');
    const t1 = Date.now();
    const doc =
      (await l.reader.read(makeCtx(l.plugin, { caller: 'owner', surface: 'job' }), {
        file: got.path,
        mime: m.mimetype,
        name: m.fileName ?? '',
        tmp,
      })) ?? {};
    if (doc.error) return failed(doc.final ? new Unreadable(doc.error) : new Error(doc.error));
    let by = 'local';
    let lowest = null;
    let modelMs = 0;
    let pictures = 0;
    let byModel = 0;
    const texts = [];
    for (const part of doc.parts ?? []) {
      let text = part.text ?? '';
      if (part.picture) {
        pictures++;
        const r = await pictureWords(part.picture, `image/${path.extname(part.picture).slice(1).replace('jpg', 'jpeg')}`, { mode, level });
        if (r.score != null) lowest = lowest == null ? r.score : Math.min(lowest, r.score);
        if (r.by && r.by !== 'local') {
          by = 'both';
          byModel++;
          modelMs += r.modelMs ?? 0;
        }
        if (r.words && part.whole && text) {
          // The page has text of its own, and the picture of the page holds that text again:
          // what the picture adds is the words that are not in it.
          if (r.by !== 'local') text += `\n(the pictures on this page, as a model read the page: ${r.words})`;
          else {
            const have = new Set((text.toLowerCase().match(WORD) ?? []).map((x) => x));
            const more = [...new Set(((r.plain ?? r.words).match(WORD) ?? []).filter((x) => !have.has(x.toLowerCase())))];
            if (more.length >= 3) text += `\n(also on this page, in a picture: ${more.join(' ')})`;
          }
        } else if (r.words) text = r.by !== 'local' ? `(a picture, as a model read it) ${r.words}` : r.words;
        else if (!text && (r.wait || r.gone || r.error)) text = '(a picture, which could not be read)';
      }
      if (text.trim()) texts.push(part.label ? `[${part.label}]\n${text.trim()}` : text.trim());
    }
    const localMs = Date.now() - t1 - modelMs;
    const full = [...texts, doc.cut ? `(${doc.cut})` : null].filter(Boolean).join('\n\n');
    const more = { by, score: lowest, kind: 'documents', level, localMs, modelMs: modelMs || null };
    const told = { score: lowest, pages: doc.pages ?? null, pictures, byModel, chars: full.length, localMs };
    if (!texts.length) {
      say('read a document: on this machine (no text in it)', { by, ...told });
      return saveNote(notes, m.id, 'empty', 'there is no text in it', more);
    }
    // What a reader of the message is shown.
    let note = `${DOC_NOTE} ${full}`;
    let noted = false;
    if (note.length > NOTE_CHARS) {
      note = `${DOC_NOTE} ${full.slice(0, NOTE_CHARS - 200)}\n${DOC_CUT}`;
      if (mode === 'both' && modelTakes('documents')) {
        const t2 = Date.now();
        try {
          const said = (await askModelAboutText(full, modelNow('readers') ?? undefined)).trim();
          if (said) {
            note = `${DOC_NOTED} ${said}`;
            noted = true;
            more.by = 'both';
            more.modelMs = (more.modelMs ?? 0) + (Date.now() - t2);
          }
        } catch (e) {
          // (No model just now, or it failed: the beginning stands.)
          facts.modelFailed = e instanceof NoModel ? 'no model' : String(e.message).slice(0, 80);
        }
      }
    }
    say(
      `read a document: on this machine${byModel ? `, with the model for ${byModel} of its ${plural(pictures, 'picture')}` : ''}${noted ? ', and a note of it by the model' : ''}`,
      { by: more.by, ...told, noted, modelMs: more.modelMs },
    );
    const kept = saveNote(notes, m.id, 'ok', note.slice(0, 4000), more);
    keepWords(m.id, full, FULL_TEXT);
    return kept;
  } catch (e) {
    return failed(e);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    letGo(got);
  }
}

// Read what is waiting, for so long at most; the rest is for the next run.
// → { done, failed, left } (or { off: true })
export async function readNow({ budgetMs = 12 * 60_000, tally = {} } = {}) {
  if (!listening() && !reads('pictures') && !reads('documents')) return { off: true };
  noteSince('pictures');
  noteSince('documents');
  const t0 = Date.now();
  const tried = new Set();
  let done = 0;
  let failed = 0;
  let left = 0;
  let listened = false;
  let noModel = false;
  try {
    for (;;) {
      // (With no model to be had just now, the files that need one wait for the next run.)
      const next = waiting().filter((m) => !tried.has(m.id) && !(noModel && !hearable(m)));
      if (!next.length) break;
      if (Date.now() - t0 > budgetMs) {
        left = next.length;
        break;
      }
      const m = next[0];
      tried.add(m.id);
      const r = await withDb(openNotesDb, (notes) =>
        withDb(openRead, async (archive) => {
          // (A forwarded file is the same file: its words are taken from the one already read.)
          if (await heardElsewhere(notes, archive, m)) return { status: 'ok', reused: true };
          if (isPicture(m)) return readPicture(notes, archive, m);
          if (!hearable(m)) return readDocument(notes, archive, m);
          listened = true;
          return readAttachment(notes, archive, m);
        }),
      );
      if (r.wait) {
        noModel = true;
        continue;
      }
      const kind = kindOfFile(m);
      tally[kind] ??= { done: 0, failed: 0 };
      // (A picture with nothing to read in it was read all the same.)
      if (r.status === 'ok' || r.status === 'empty') (done++, tally[kind].done++);
      else (failed++, tally[kind].failed++);
    }
  } finally {
    // The helper that listens keeps the speech model in memory: let it go when the work is done.
    if (listened) await doneHearing().catch(() => {});
  }
  return { done, failed, left };
}

// Looking back: how reading has gone since a time. From what is kept of each file (who read
// it, how sure this machine was) and from the activity record (what the model used).
// → { pictures: { read, empty, local, model, gone, failed, scores, bands, atLevel, localMs, modelMs, cost, tokensOut, calls }, voice: { heard, failed, audioS, tookS } }
const BANDS = [0, 20, 40, 60, 80];
export function readingStats(sinceTs) {
  return withDb(openNotesDb, (db) =>
    withDb(openRead, (archive) => {
      const rows = db
        .prepare('SELECT msg_id, status, by, score, kind, attempts, local_ms, model_ms FROM attachment_notes WHERE created_ts >= ?')
        .all(sinceTs);
      // (One read before the kind was kept: told from the file it belongs to.)
      const fileOf = archive.prepare(
        'SELECT d.dl_type, d.mimetype FROM messages m JOIN media d ON d.msg_rowid = m.rowid WHERE m.id = ? LIMIT 1',
      );
      const kindOf = (r) => {
        if (r.kind) return r.kind;
        if (r.by) return 'pictures';
        const f = fileOf.get(r.msg_id);
        return !f ? null : hearable(f) ? 'voice' : isPicture(f) ? 'pictures' : isDocument(f) ? 'documents' : null;
      };
      const pics = rows.filter((r) => kindOf(r) === 'pictures');
      const voice = rows.filter((r) => kindOf(r) === 'voice');
      const docs = rows.filter((r) => kindOf(r) === 'documents');
      const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
      // Those with text in them, by this machine's reading: the ones a level decides about.
      const scored = pics.filter((r) => r.score != null && r.status !== 'empty' && r.by !== 'model');
      const scores = scored.map((r) => r.score);
      let cost = { n: 0, cost: null, out: null };
      let heard = { n: 0, audio: null, ms: null };
      try {
        cost = db
          .prepare(
            `SELECT COUNT(*) AS n, SUM(cost) AS cost, SUM(tokens_out) AS out FROM activity
            WHERE ts >= ? AND kind = 'model' AND category = 'attachments' AND json_extract(data, '$.file') = 'image'`,
          )
          .get(sinceTs);
        heard = db
          .prepare(
            `SELECT COUNT(*) AS n, SUM(json_extract(data, '$.audioS')) AS audio, SUM(ms) AS ms FROM activity
            WHERE ts >= ? AND kind = 'event' AND category = 'attachments' AND ok = 1 AND summary LIKE 'listened to %'`,
          )
          .get(sinceTs);
      } catch {
        // (Nothing is recorded here: the counts stand without what the model used.)
      }
      return {
        level: reading('pictures').level,
        pictures: {
          read: pics.filter((r) => ['ok', 'empty'].includes(r.status)).length,
          empty: pics.filter((r) => r.status === 'empty').length,
          local: pics.filter((r) => r.status === 'ok' && r.by === 'local').length,
          model: pics.filter((r) => r.status === 'ok' && (r.by === 'both' || r.by === 'model')).length,
          gone: pics.filter((r) => r.status === 'unreadable').length,
          failed: pics.filter((r) => r.status === 'error').length,
          scores: scores.length ? { lowest: Math.min(...scores), average: avg(scores), highest: Math.max(...scores) } : null,
          bands: BANDS.map((from, i) => ({
            from,
            to: BANDS[i + 1] ? BANDS[i + 1] - 1 : 100,
            n: scores.filter((x) => x >= from && x < (BANDS[i + 1] ?? 101)).length,
          })),
          // How many of them a level would have sent to the model.
          atLevel: [40, 50, 60, 70, 80, 90].map((l) => ({ level: l, model: scores.filter((x) => x < l).length })),
          localMs: avg(pics.filter((r) => r.local_ms != null).map((r) => r.local_ms)),
          modelMs: avg(pics.filter((r) => r.model_ms != null).map((r) => r.model_ms)),
          calls: cost.n ?? 0,
          cost: cost.cost ?? null,
          tokensOut: cost.out ?? null,
        },
        documents: {
          read: docs.filter((r) => ['ok', 'empty'].includes(r.status)).length,
          empty: docs.filter((r) => r.status === 'empty').length,
          local: docs.filter((r) => r.status === 'ok' && r.by === 'local').length,
          model: docs.filter((r) => r.status === 'ok' && r.by && r.by !== 'local').length,
          // (Read by a watch, before documents were read as they arrive.)
          earlier: docs.filter((r) => r.status === 'ok' && !r.by).length,
          gone: docs.filter((r) => r.status === 'unreadable').length,
          failed: docs.filter((r) => r.status === 'error').length,
          localMs: avg(docs.filter((r) => r.local_ms != null).map((r) => r.local_ms)),
        },
        voice: {
          heard: voice.filter((r) => r.status === 'ok').length,
          failed: voice.filter((r) => r.status !== 'ok').length,
          audioS: heard.audio != null ? Math.round(heard.audio) : null,
          tookS: heard.ms != null ? Math.round(heard.ms / 1000) : null,
        },
      };
    }),
  );
}
// The same, in words.
export function statsText(st, period) {
  const p = st.pictures;
  const n = (x, one, many) => `${x} ${x === 1 ? one : many}`;
  const out = [`Pictures, ${period}: ${n(p.read + p.gone + p.failed, 'picture', 'pictures')} dealt with`];
  const row = (label, count, note = '') =>
    count && out.push(`  ${label.padEnd(34)}${String(count).padStart(5)}${note ? `   ${note}` : ''}`);
  row('no text in them', p.empty);
  row('read on this machine and kept', p.local);
  row('given to the model', p.model, p.cost != null ? `${p.calls} calls, $${p.cost.toFixed(2)} at list price` : '');
  row('could not be fetched', p.gone);
  row('failed, to be tried again', p.failed);
  if (p.scores) {
    out.push(
      `How sure this machine was, of those with text (0 to 100): from ${p.scores.lowest} to ${p.scores.highest}, ${p.scores.average} on average`,
    );
    out.push(`  ${p.bands.map((b) => `${b.from}-${b.to}: ${b.n}`).join(' · ')}`);
    out.push(
      `The level is ${st.level}. What another would have given the model: ${p.atLevel.map((a) => `${a.level} → ${a.model}`).join(' · ')}`,
    );
  }
  if (p.localMs != null || p.modelMs != null)
    out.push(
      `Time for each: ${[p.localMs != null ? `${(p.localMs / 1000).toFixed(1)} s on this machine` : null, p.modelMs != null ? `${(p.modelMs / 1000).toFixed(1)} s more when the model is asked` : null].filter(Boolean).join(', ')}`,
    );
  const d = st.documents;
  const docs = d.read + d.gone + d.failed;
  out.push(
    docs
      ? `Documents, ${period}: ${n(docs, 'document', 'documents')} dealt with: ${[
          d.local ? `${d.local} read on this machine alone` : null,
          d.model ? `${d.model} with the model (for a page that is a picture, or a note of a long one)` : null,
          d.earlier ? `${d.earlier} read earlier, by a watch` : null,
          d.empty ? `${d.empty} with no text` : null,
          d.gone ? `${d.gone} could not be fetched or are not of a kind that is read` : null,
          d.failed ? `${d.failed} failed, to be tried again` : null,
        ]
          .filter(Boolean)
          .join(', ')}${d.localMs != null ? ` (${(d.localMs / 1000).toFixed(1)} s each on this machine)` : ''}`
      : `Documents, ${period}: none`,
  );
  const v = st.voice;
  out.push(
    v.heard + v.failed
      ? `Voice notes, ${period}: ${v.heard} listened to${v.failed ? `, ${v.failed} could not be` : ''}${v.audioS != null && v.tookS ? ` (${v.audioS} s of audio in ${v.tookS} s)` : ''}`
      : `Voice notes, ${period}: none`,
  );
  return out.join('\n');
}
