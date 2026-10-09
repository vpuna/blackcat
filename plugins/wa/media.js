// Fetching a WhatsApp file: a plain HTTPS download from WhatsApp's media servers plus local
// decryption, the same thing WhatsApp Web does when you open a photo. It needs no login and
// tells nobody anything: the keys came with the message.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';

export async function fetchWhatsAppMedia(row, dest) {
  if (!row.media_key || !(row.direct_path || row.url)) throw new Error('This message has no download reference.');
  const { downloadContentFromMessage } = await import('baileys');
  try {
    const stream = await downloadContentFromMessage({ mediaKey: row.media_key, directPath: row.direct_path, url: row.url }, row.dl_type);
    const hash = crypto.createHash('sha256');
    stream.on('data', (d) => hash.update(d));
    await pipeline(stream, fs.createWriteStream(dest, { mode: 0o600 }));
    if (row.file_sha256 && !hash.digest().equals(row.file_sha256)) throw new Error('downloaded file failed its integrity check');
  } catch (e) {
    const status = e?.output?.statusCode ?? e?.response?.status ?? e?.status;
    const gone = [403, 404, 410].includes(status) || /40[34]|410|not found|expired/i.test(e?.message ?? '');
    throw new Error(
      gone
        ? "The file is no longer on WhatsApp's servers (they only keep media for a limited time)."
        : `Download failed (${e?.message ?? e}).`,
    );
  }
}
