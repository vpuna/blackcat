import fs from 'node:fs';
import { OlderData, hasTable, madeReady, openSqlite } from '../db.js';
import { ARCHIVE_DB } from './files.js';

export const DB_PATH = ARCHIVE_DB;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chats (
  ref      TEXT PRIMARY KEY,
  name     TEXT,
  is_group INTEGER NOT NULL DEFAULT 0,
  last_ts  INTEGER            -- last activity WhatsApp reported, even if we stored no messages
);

CREATE TABLE IF NOT EXISTS contacts (
  ref    TEXT PRIMARY KEY,    -- phone-number JID (…@s.whatsapp.net) or hidden ID (…@lid)
  name   TEXT,                -- name saved in your phone
  notify TEXT,                -- name they set themselves
  phone  TEXT
);

-- WhatsApp is moving to hidden IDs (@lid); this maps them back to phone-number JIDs.
CREATE TABLE IF NOT EXISTS lid_map (
  lid TEXT PRIMARY KEY,
  pn  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  chat_ref   TEXT NOT NULL,
  id         TEXT NOT NULL,
  sender_ref TEXT,
  from_me    INTEGER NOT NULL DEFAULT 0,
  ts         INTEGER NOT NULL, -- unix seconds
  type       TEXT NOT NULL,    -- text, image, video, voice, audio, document, sticker, location, contact, poll, other
  text       TEXT,             -- message text, caption, or a short description for media
  quoted_id  TEXT,             -- id of the message this replies to
  edited     INTEGER NOT NULL DEFAULT 0,
  deleted    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_ref, id)
);
CREATE INDEX IF NOT EXISTS messages_chat_ts ON messages (chat_ref, ts);
CREATE INDEX IF NOT EXISTS messages_ts ON messages (ts);

-- Source state (connection, last event) for \`bc wa status\`.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

// Writer: the service and `bc wa select` (pruning).
export function openWrite() {
  return madeReady(openSqlite(DB_PATH, { relaxed: true }), make);
}

// (A chat, and whoever sent a message, is known here by a "ref": tg:…, mail:…, or the id
// WhatsApp gives.)

// The rest of the archive's shape, made after the tables above: the keyword index, and
// what was added to the tables. A new archive gets all of it at once and is marked with
// how many parts there are (SQLite's user_version); a later change goes at the end, and an
// archive marked lower gets what it lacks. Only writers do this.
const PARTS = [
  // 1: keyword index over message text.
  (db) =>
    db.exec(`
    CREATE VIRTUAL TABLE messages_fts USING fts5(
      text, content='messages', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
    CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts (rowid, text) VALUES (new.rowid, new.text);
    END;
    CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    END;
    CREATE TRIGGER messages_au AFTER UPDATE OF text ON messages BEGIN
      INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
      INSERT INTO messages_fts (rowid, text) VALUES (new.rowid, new.text);
    END;`),

  // 2: link previews. The sender's phone embeds title, description and a small
  // thumbnail in the message; store them and make title/description searchable.
  (db) =>
    db.exec(`
    ALTER TABLE messages ADD COLUMN link_url TEXT;
    ALTER TABLE messages ADD COLUMN link_title TEXT;
    ALTER TABLE messages ADD COLUMN link_desc TEXT;

    CREATE TABLE link_thumbs (
      msg_rowid INTEGER PRIMARY KEY,  -- messages.rowid (stable even if chat_ref is rewritten)
      jpeg      BLOB NOT NULL,
      width     INTEGER,
      height    INTEGER
    );

    DROP TRIGGER messages_ai;
    DROP TRIGGER messages_ad;
    DROP TRIGGER messages_au;
    DROP TABLE messages_fts;
    CREATE VIRTUAL TABLE messages_fts USING fts5(
      text, link_title, link_desc,
      content='messages', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
    CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts (rowid, text, link_title, link_desc)
        VALUES (new.rowid, new.text, new.link_title, new.link_desc);
    END;
    CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts (messages_fts, rowid, text, link_title, link_desc)
        VALUES ('delete', old.rowid, old.text, old.link_title, old.link_desc);
      DELETE FROM link_thumbs WHERE msg_rowid = old.rowid;
    END;
    CREATE TRIGGER messages_au AFTER UPDATE OF text, link_url, link_title, link_desc ON messages BEGIN
      INSERT INTO messages_fts (messages_fts, rowid, text, link_title, link_desc)
        VALUES ('delete', old.rowid, old.text, old.link_title, old.link_desc);
      INSERT INTO messages_fts (rowid, text, link_title, link_desc)
        VALUES (new.rowid, new.text, new.link_title, new.link_desc);
    END;
    INSERT INTO messages_fts (messages_fts) VALUES ('rebuild');`),

  // 3: recover plain URLs from messages stored before link previews existed.
  // (Their titles, descriptions and thumbnails weren't kept, so only the URL.)
  (db) => {
    const set = db.prepare('UPDATE messages SET link_url = ? WHERE rowid = ?');
    for (const r of db.prepare("SELECT rowid, text FROM messages WHERE link_url IS NULL AND text LIKE '%http%'").all()) {
      const url = r.text.match(/https?:\/\/[^\s<>"']+/i)?.[0];
      if (url) set.run(url, r.rowid);
    }
  },

  // 4: history messages in groups were stored with the group itself as sender (the real
  // sender is on WebMessageInfo.participant). Mark them unknown so a re-sync can fill them
  // in, and drop contact rows that the bug created for group IDs.
  (db) =>
    db.exec(`
    UPDATE messages SET sender_ref = NULL WHERE sender_ref = chat_ref AND chat_ref LIKE '%@g.us';
    DELETE FROM contacts WHERE ref LIKE '%@g.us';`),

  // 5: media. Keep each file's details and download reference (server path + decryption
  // key) and the thumbnail embedded in the message; the full file is fetched on demand.
  // Also keep every message's original protobuf, so later features can read fields we
  // don't extract today without another history sync.
  (db) =>
    db.exec(`
    CREATE TABLE media (
      msg_rowid       INTEGER PRIMARY KEY,  -- messages.rowid
      dl_type         TEXT NOT NULL,        -- image, video, gif, audio, ptt, document, sticker
      mimetype        TEXT,
      size            INTEGER,              -- bytes
      width           INTEGER,
      height          INTEGER,
      seconds         INTEGER,
      file_name       TEXT,
      direct_path     TEXT,                 -- location on WhatsApp's media servers
      url             TEXT,
      media_key       BLOB,                 -- decrypts the downloaded file
      file_sha256     BLOB,
      file_enc_sha256 BLOB,
      thumb           BLOB                  -- small preview embedded in the message
    );
    CREATE TABLE raw (
      msg_rowid INTEGER PRIMARY KEY,
      proto     BLOB NOT NULL               -- encoded WebMessageInfo
    );
    DROP TRIGGER messages_ad;
    CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts (messages_fts, rowid, text, link_title, link_desc)
        VALUES ('delete', old.rowid, old.text, old.link_title, old.link_desc);
      DELETE FROM link_thumbs WHERE msg_rowid = old.rowid;
      DELETE FROM media WHERE msg_rowid = old.rowid;
      DELETE FROM raw WHERE msg_rowid = old.rowid;
    END;`),

  // 6: what kind of chat each one is, and how far back its history has been fetched.
  // Used by the Telegram source, where chats come in kinds (person, bot, group,
  // large group, broadcast channel) that are included or left out by default.
  (db) =>
    db.exec(`
    CREATE TABLE chat_info (
      ref             TEXT PRIMARY KEY,
      kind            TEXT,      -- user | bot | group | supergroup | channel
      members         INTEGER,
      username        TEXT,
      backfill_cutoff INTEGER    -- history has been fetched back to this time (unix seconds)
    );`),
];

// The number the first published version started at: an archive marked lower than this, or
// one with messages and no mark at all, is from an earlier blackcat and is not guessed at.
const BASE = 6;
function make(db) {
  let v = db.pragma('user_version', { simple: true });
  if (v >= PARTS.length) return;
  if (v > 0 ? v < BASE : hasTable(db, 'messages')) throw new OlderData('archive', v, BASE);
  db.transaction(() => {
    if (v === 0) db.exec(SCHEMA);
    for (; v < PARTS.length; v++) PARTS[v](db);
    db.pragma(`user_version = ${PARTS.length}`);
  })();
}

// Reader: every query command. Read-only at the SQLite level, so nothing
// the agent runs can change the archive.
export function openRead() {
  if (!fs.existsSync(DB_PATH)) return null;
  return openSqlite(DB_PATH, { readonly: true });
}

export function setMeta(db, values) {
  const stmt = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(values)) stmt.run(k, v == null ? null : String(v));
}

export function getMeta(db) {
  return Object.fromEntries(
    db
      .prepare('SELECT key, value FROM meta')
      .all()
      .map((r) => [r.key, r.value]),
  );
}

// ---------- sources ----------
// The archive holds more than one messaging service; which one a row belongs to is read off
// the start of its id. See src/archive/sources.js, where plugins add their own.
export { SOURCES, msgSource, sourceOf, sourceSql } from './sources.js';

// SQL fragments that turn ids into display names: saved name, then their own name, then
// the phone number (WhatsApp) or the raw id (anything without an "@").
// Hidden WhatsApp ids (@lid) are mapped to phone-number ids first.
const real = (col) => `COALESCE((SELECT pn FROM lid_map WHERE lid = ${col}), ${col})`;
const fallback = (col) =>
  `CASE WHEN instr(${real(col)}, '@') = 0 THEN ${real(col)} ELSE '+' || substr(${real(col)}, 1, instr(${real(col)}, '@') - 1) END`;

export const SENDER_NAME = `COALESCE(
  (SELECT COALESCE(c.name, c.notify) FROM contacts c WHERE c.ref = ${real('m.sender_ref')}),
  (SELECT c.notify FROM contacts c WHERE c.ref = m.sender_ref),
  ${fallback('m.sender_ref')}
)`;

export const CHAT_NAME = `COALESCE(
  ch.name,
  (SELECT COALESCE(c.name, c.notify) FROM contacts c WHERE c.ref = ${real('ch.ref')}),
  ${fallback('ch.ref')}
)`;
