import { MEDIA_DIR } from './files.js';
import fs from 'node:fs';
import path from 'node:path';

import { msgSource, source } from './sources.js';
import { QueryError } from './query.js';

const MAX_BYTES = 200 * 1024 ** 2;
// Files fetched on request, one folder per message. The agent may read here.
export { MEDIA_DIR };
const EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/3gpp': '.3gp',
  'video/quicktime': '.mov',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/amr': '.amr',
  'application/pdf': '.pdf',
};

const safe = (s) => s.replace(/[^A-Za-z0-9_-]/g, '_');

function extFor(row) {
  const mime = (row.mimetype ?? '').split(';')[0].trim();
  return (
    EXT[mime] ||
    path
      .extname(row.file_name ?? '')
      .toLowerCase()
      .replace(/[^.a-z0-9]/g, '') ||
    '.bin'
  );
}

// A file name that's safe on disk but still the one the sender used: no folders,
// no control characters, not hidden, not absurdly long. Unicode names are kept.
function cleanName(name) {
  const base = path
    .basename(String(name).replace(/\\/g, '/'))
    .replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  if (!base) return null;
  const ext = path.extname(base);
  return base.length > 150 ? base.slice(0, 150 - ext.length) + ext : base;
}

// Each message gets its own folder, so the file can keep its original name (that's
// the name Telegram shows) without two "invoice.pdf" files colliding. Media sent
// without a name (photos, voice notes) is named after its type and message id.
// A file existing on disk is the only record that it was downloaded, so queries
// never write to the db.
export function mediaPaths(id, row) {
  const dir = path.join(MEDIA_DIR, safe(id));
  const ext = extFor(row);
  let name = row.file_name && cleanName(row.file_name);
  if (name && !path.extname(name) && ext !== '.bin') name += ext;
  name ||= `${row.type ?? row.dl_type ?? 'file'}-${safe(id).slice(-8)}${ext}`;
  return { dir, full: path.join(dir, name), thumb: path.join(dir, `thumbnail.${row.thumb?.[0] === 0x89 ? 'png' : 'jpg'}`) };
}

// The already-downloaded file for a message, if any (ignores thumbnails and partial downloads).
export function downloadedPath(id) {
  const dir = path.join(MEDIA_DIR, safe(id));
  try {
    const f = fs.readdirSync(dir).find((n) => !n.startsWith('thumbnail.') && !n.endsWith('.part'));
    return f ? path.join(dir, f) : null;
  } catch {
    return null;
  }
}

export function findMedia(db, id) {
  const row = db
    .prepare(`SELECT m.rowid, m.id, m.type, m.text, md.* FROM messages m LEFT JOIN media md ON md.msg_rowid = m.rowid WHERE m.id = ?`)
    .get(id);
  if (!row) throw new QueryError(`No message ${id}.`);
  if (!row.dl_type) {
    throw new QueryError(
      ['image', 'video', 'gif', 'voice', 'audio', 'document', 'sticker'].includes(row.type)
        ? `That ${row.type} was stored before media details were kept. Re-link WhatsApp (bc wa pair) to fill them in.`
        : `Message ${id} is not a photo, video, audio or document.`,
    );
  }
  return row;
}

function writeThumb(id, row) {
  if (!row.thumb) return null;
  const { dir, thumb } = mediaPaths(id, row);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(thumb, row.thumb, { mode: 0o600 });
  return thumb;
}

// Returns { path, source: 'cache' | 'download' | 'thumbnail', note? }.
// Fetching is a plain HTTPS download from WhatsApp's media servers plus local
// decryption, the same thing WhatsApp Web does when you open a photo. It needs no
// WhatsApp connection and sends nothing to any chat.
export async function fetchMedia(db, id, { thumbOnly = false } = {}) {
  const row = findMedia(db, id);
  const paths = mediaPaths(id, row);

  if (thumbOnly) {
    const t = writeThumb(id, row);
    if (!t) throw new QueryError('That message has no thumbnail.');
    return { path: t, source: 'thumbnail' };
  }
  const have = downloadedPath(id);
  if (have) return { path: have, source: 'cache' };

  const fallback = (why) => {
    const t = writeThumb(id, row);
    if (t) return { path: t, source: 'thumbnail', note: `${why} Returning the small thumbnail stored with the message instead.` };
    throw new QueryError(why);
  };

  // The source the message came from knows how to get its file; the archive only knows it is there.
  const from = source(msgSource(id));
  if (!from?.fetchMedia)
    return fallback(`Its source (${from?.label ?? msgSource(id)}) is not set up to fetch files: its plugin is switched off.`);
  if (row.size > MAX_BYTES)
    return fallback(`The file is ${(row.size / 1024 ** 2).toFixed(0)} MB, over the ${MAX_BYTES / 1024 ** 2} MB limit.`);
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  const part = `${paths.full}.part`;
  try {
    await from.fetchMedia(row, part, id);
    fs.renameSync(part, paths.full);
    return { path: paths.full, source: 'download' };
  } catch (e) {
    fs.rmSync(part, { force: true });
    return fallback(/[.!?]$/.test(e.message) ? e.message : `It could not be fetched from ${from.label ?? from.id} (${e.message}).`);
  }
}
