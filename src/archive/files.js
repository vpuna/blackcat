// Where the message archive is kept, under data/:
//   archive.db         every source's messages (WhatsApp, Telegram, mail, any a plugin adds)
//   archive-index.db   the index for searching by meaning (derived: it can be rebuilt)
//   archive-media/     files fetched from messages on request
import path from 'node:path';
import { DATA } from '../config.js';

export const ARCHIVE_DB = path.join(DATA, 'archive.db');
export const INDEX_DB = path.join(DATA, 'archive-index.db');
export const INDEX_LOCK = path.join(DATA, 'archive-index.lock');
export const MEDIA_DIR = path.join(DATA, 'archive-media');
