import { size } from '../util/format.js';
import { agoShort, isoLocal } from '../util/time.js';
import fs from 'node:fs';
import { CHAT_NAME, DB_PATH, SENDER_NAME, getMeta, openRead, sourceOf, sourceSql } from './db.js';
import { howToConnect } from './sources.js';

export class QueryError extends Error {}

export function open() {
  const db = openRead();
  if (!db) throw new QueryError(`No message archive yet. Connect ${howToConnect().join(' or ') || 'a source of messages'} first.`);
  return db;
}

// "7d", "12h", "2w", "3m" (months) or a date like 2026-09-01.
export function parseTime(s) {
  if (s == null) return null;
  const rel = /^(\d+)\s*([hdwm])$/i.exec(s.trim());
  if (rel) {
    const secs = { h: 3600, d: 86400, w: 7 * 86400, m: 30 * 86400 }[rel[2].toLowerCase()];
    return Math.floor(Date.now() / 1000) - Number(rel[1]) * secs;
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new QueryError(`Can't read time "${s}". Use e.g. 7d, 12h, 2w, or 2026-09-01.`);
  return Math.floor(t / 1000);
}

export const fmtTime = isoLocal;

export const ago = agoShort;

const CHAT_ROWS = `
  SELECT ch.ref, ${CHAT_NAME} AS name, ch.is_group AS isGroup,
         MAX(COALESCE(ch.last_ts, 0), COALESCE(mx.ts, 0)) AS last, COALESCE(mx.n, 0) AS stored
  FROM chats ch
  LEFT JOIN (SELECT chat_ref, COUNT(*) AS n, MAX(ts) AS ts FROM messages GROUP BY chat_ref) mx ON mx.chat_ref = ch.ref`;

// Every row that names a chat or message also says which service it came from.
const withSource = (rows) => rows.map((r) => ({ ...r, source: sourceOf(r.chatRef ?? r.ref) }));

// Chats, most recent activity first. `source` limits it to 'wa' or 'tg'.
export function listChats(db, { since = 0, limit = 50, offset = 0, match, source, stored = false } = {}) {
  // Filter in an outer query: inside CHAT_ROWS, `name` would mean the raw chats.name
  // column (empty for 1:1 chats) instead of the resolved display name.
  const where = ['last >= @since', sourceSql('ref', source)];
  if (stored) where.push('stored > 0'); // leave out chats that are known but not collected
  if (match) where.push('(name LIKE @like OR ref = @match)');
  return withSource(
    db
      .prepare(`SELECT * FROM (${CHAT_ROWS}) WHERE ${where.join(' AND ')} ORDER BY last DESC LIMIT @limit OFFSET @offset`)
      .all({ since, limit, offset, match: match ?? null, like: `%${match ?? ''}%` }),
  );
}

export function countChats(db, { since = 0, source, stored = false } = {}) {
  return db
    .prepare(`SELECT COUNT(*) AS n FROM (${CHAT_ROWS}) WHERE last >= ? AND ${sourceSql('ref', source)}${stored ? ' AND stored > 0' : ''}`)
    .get(since).n;
}

// A --chat argument can be an id or part of a name. Returns matching chats.
export function resolveChats(db, pattern, source) {
  // A name that matches a chat with messages means that chat, not an empty one of a similar name.
  let rows = listChats(db, { match: pattern, limit: 20, source, stored: true });
  if (!rows.length) rows = listChats(db, { match: pattern, limit: 20, source });
  if (!rows.length) throw new QueryError(`No chat matches "${pattern}". Try \`bc msg chats\`.`);
  return rows;
}

const MSG_COLS = `m.rowid AS rowid, m.chat_ref AS chatRef, ${CHAT_NAME} AS chat, m.id, m.ts,
  CASE WHEN m.from_me THEN 'Me' WHEN m.sender_ref IS NULL THEN 'Unknown sender' ELSE ${SENDER_NAME} END AS sender,
  m.from_me AS fromMe, m.type, m.text, m.quoted_id AS quotedId, m.edited, m.deleted,
  m.link_url AS linkUrl, m.link_title AS linkTitle, m.link_desc AS linkDesc,
  EXISTS (SELECT 1 FROM link_thumbs t WHERE t.msg_rowid = m.rowid) AS linkThumb,
  md.mimetype AS mediaType, md.size AS mediaSize, md.width AS mediaWidth, md.height AS mediaHeight,
  md.seconds AS mediaSeconds, md.file_name AS mediaFile,
  md.thumb IS NOT NULL AS mediaThumb,
  (md.dl_type = 'tg' OR (md.media_key IS NOT NULL AND (md.direct_path IS NOT NULL OR md.url IS NOT NULL))) AS mediaFetchable`;

// Joined into every message query for the media columns above.
const MEDIA_JOIN = 'LEFT JOIN media md ON md.msg_rowid = m.rowid';

// Words are ANDed and matched as whole words; `word*` matches a prefix.
// Anything FTS5 would treat as syntax is quoted, so user text can't break the query.
function ftsQuery(text, any) {
  const terms = (text.match(/"[^"]+"|\S+/g) ?? [])
    .map((t) => {
      const prefix = t.endsWith('*') && !t.startsWith('"');
      const bare = t.replace(/^"|"$/g, '').replace(/\*$/, '').replace(/"/g, '""');
      return bare ? `"${bare}"${prefix ? '*' : ''}` : null;
    })
    .filter(Boolean);
  if (!terms.length) throw new QueryError('Nothing to search for.');
  return terms.join(any ? ' OR ' : ' ');
}

export function search(db, text, { chat, from, since, until, limit = 20, any = false, sort = 'relevance', source } = {}) {
  const params = { q: ftsQuery(text, any), limit };
  const where = ['messages_fts MATCH @q', sourceSql('m.chat_ref', source)];
  if (chat) {
    const refs = resolveChats(db, chat, source).map((r) => r.ref);
    where.push(`m.chat_ref IN (${refs.map((_, i) => `@c${i}`).join(', ')})`);
    refs.forEach((j, i) => (params[`c${i}`] = j));
  }
  if (from) {
    params.from = `%${from}%`;
    where.push(/^me$/i.test(from) ? 'm.from_me = 1' : `(NOT m.from_me AND ${SENDER_NAME} LIKE @from)`);
  }
  if (since) ((params.since = parseTime(since)), where.push('m.ts >= @since'));
  if (until) ((params.until = parseTime(until)), where.push('m.ts <= @until'));

  return withSource(
    db
      .prepare(
        `
    SELECT ${MSG_COLS},
      snippet(messages_fts, 0, '«', '»', '…', 16) AS snippet,
      snippet(messages_fts, 1, '«', '»', '…', 12) AS titleSnippet,
      snippet(messages_fts, 2, '«', '»', '…', 16) AS descSnippet
    FROM messages_fts
    JOIN messages m ON m.rowid = messages_fts.rowid
    LEFT JOIN chats ch ON ch.ref = m.chat_ref
    ${MEDIA_JOIN}
    WHERE ${where.join(' AND ')}
    ORDER BY ${sort === 'time' ? 'm.ts DESC' : 'bm25(messages_fts), m.ts DESC'}
    LIMIT @limit`,
      )
      .all(params),
  );
}

// Messages from one chat: the latest N, or N either side of a message, or a time range.
export function thread(db, chat, { around, context = 10, last = 30, since, until, source } = {}) {
  const chats = resolveChats(db, chat, source);
  if (chats.length > 1 && !chats.some((c) => c.ref === chat)) {
    throw new QueryError(
      `"${chat}" matches ${chats.length} chats: ${chats
        .slice(0, 8)
        .map((c) => c.name)
        .join(', ')}. Be more specific or pass the JID.`,
    );
  }
  const ref = (chats.find((c) => c.ref === chat) ?? chats[0]).ref;
  const base = `SELECT ${MSG_COLS} FROM messages m LEFT JOIN chats ch ON ch.ref = m.chat_ref ${MEDIA_JOIN} WHERE m.chat_ref = @ref`;

  if (around) {
    const pivot = db.prepare('SELECT ts, rowid FROM messages WHERE chat_ref = ? AND id = ?').get(ref, around);
    if (!pivot) throw new QueryError(`No message ${around} in that chat.`);
    const p = { ref, ts: pivot.ts, rowid: pivot.rowid, n: context };
    const before = db
      .prepare(`${base} AND (m.ts < @ts OR (m.ts = @ts AND m.rowid < @rowid)) ORDER BY m.ts DESC, m.rowid DESC LIMIT @n`)
      .all(p);
    const rest = db.prepare(`${base} AND (m.ts > @ts OR (m.ts = @ts AND m.rowid >= @rowid)) ORDER BY m.ts, m.rowid LIMIT @n + 1`).all(p);
    return { chat: chats.find((c) => c.ref === ref), messages: withSource([...before.reverse(), ...rest]) };
  }

  const p = { ref, n: last, since: since ? parseTime(since) : 0, until: until ? parseTime(until) : 2 ** 31 };
  const rows = db.prepare(`${base} AND m.ts BETWEEN @since AND @until ORDER BY m.ts DESC, m.rowid DESC LIMIT @n`).all(p);
  return { chat: chats.find((c) => c.ref === ref), messages: withSource(rows.reverse()) };
}

// Totals for the whole archive, or for one source.
export function stats(db, source) {
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS messages, COUNT(DISTINCT chat_ref) AS chats, MIN(ts) AS oldest, MAX(ts) AS newest FROM messages WHERE ${sourceSql('chat_ref', source)}`,
    )
    .get();
  const knownChats = db.prepare(`SELECT COUNT(*) AS n FROM chats WHERE ${sourceSql('ref', source)}`).get().n;
  const size = ['', '-wal'].reduce((a, s) => a + (fs.statSync(DB_PATH + s, { throwIfNoEntry: false })?.size ?? 0), 0);
  const hasMedia = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'media'").get();
  const media = hasMedia
    ? db
        .prepare(
          `SELECT COUNT(*) AS files, COALESCE(SUM(md.thumb IS NOT NULL), 0) AS thumbs,
        COALESCE(SUM(md.media_key IS NOT NULL AND (md.direct_path IS NOT NULL OR md.url IS NOT NULL)), 0) AS fetchable
        FROM media md JOIN messages m ON m.rowid = md.msg_rowid WHERE ${sourceSql('m.chat_ref', source)}`,
        )
        .get()
    : { files: 0, thumbs: 0, fetchable: 0 };
  return { ...totals, knownChats, bytes: size, media, meta: getMeta(db) };
}

// One line per message, for people and for the agent.
// `tag` adds [wa]/[tg] in front, for listings that mix sources.
export function formatMessage(m, { withChat = false, tag = false } = {}) {
  // e.g. [image 240 KB], [voice 0:42], [document report.pdf 1.2 MB]
  const bits = [m.type];
  if (m.mediaSeconds) bits.push(`${Math.floor(m.mediaSeconds / 60)}:${String(m.mediaSeconds % 60).padStart(2, '0')}`);
  if (m.mediaSize) bits.push(size(m.mediaSize));
  const media = m.type !== 'text' ? `[${bits.join(' ')}] ` : '';
  const flags = `${m.edited ? ' (edited)' : ''}${m.deleted ? ' (deleted)' : ''}`;
  const where = `${tag ? `[${m.source}] ` : ''}${withChat ? `${m.chat} · ` : ''}`;
  const body = m.snippet || m.text || '';
  // Search results carry highlighted snippets of the preview too; otherwise show it plain.
  const title = m.titleSnippet || m.linkTitle;
  const desc = m.descSnippet || m.linkDesc;
  const preview = title || desc ? `  🔗 ${[title, desc].filter(Boolean).join(' – ').slice(0, 160)}` : '';
  return `${fmtTime(m.ts)}  ${where}${m.sender}: ${media}${body}${flags}${preview}`;
}
