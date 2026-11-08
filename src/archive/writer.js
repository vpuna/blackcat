// The statements that write into the archive, shared by everything that collects: the
// WhatsApp and Telegram sources and any plugin that adds a source. One definition, so a
// chat, a person or a message is recorded the same way wherever it came from.
import { record } from '../activity/log.js';
import { ownRefs } from '../channels/registry.js';
import { sourceOf, sourceSql } from './sources.js';

// A chat that is blackcat itself (src/channels/registry.js, ownRefs) is never written: not
// the chat, not a message in it. This is held here, for every source, so that one written
// later cannot forget it.
const never = { changes: 0, lastInsertRowid: 0 };
const unlessOwn = (stmt, refOf) => ({ run: (row) => (ownRefs().includes(refOf(row)) ? never : stmt.run(row)) });

// How many messages came in, by where from: counted here as they are written and noted on
// the activity record a minute's worth at a time (a count for the day, never an entry each).
const arrived = new Map();
let noting = null;
export function noteArrived() {
  noting = null;
  for (const [source, n] of arrived) record({ kind: 'event', category: `messages: ${source}`, countOnly: true, count: n });
  arrived.clear();
}
process.on('exit', () => arrived.size && noteArrived());
// `isNew`: for a statement that also updates a message already there (its changes count both).
const counted = (stmt, isNew = null) => ({
  run: (row) => {
    const fresh = isNew ? isNew(row) : true;
    const r = stmt.run(row);
    if (r.changes && fresh) {
      const source = sourceOf(row.chat);
      arrived.set(source, (arrived.get(source) ?? 0) + 1);
      noting ??= setTimeout(noteArrived, 60_000).unref();
    }
    return r;
  },
});

// What kind of file it is. A sender may say no more than "a file" (`application/octet-stream`,
// as some mail programs do of every attachment), and then its name says: "scan.pdf" is a
// PDF, and is read as one. A type that says what it is is kept as it is.
const GENERIC = /^(application\/(octet-stream|x-download|force-download|binary)|binary\/octet-stream)?$/;
export const BY_NAME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  txt: 'text/plain',
  csv: 'text/csv',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};
export function fileType(mimetype, name) {
  const said = String(mimetype ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (!GENERIC.test(said)) return mimetype;
  return BY_NAME[/\.([a-z0-9]+)$/i.exec(String(name ?? ''))?.[1]?.toLowerCase()] ?? (mimetype || null);
}

// `account()`: the key of the owner's account it collects through (src/archive/db.js,
// accountFor), written on every chat and message; null while it is not known yet (the rows
// are claimed for it once it is).
export function archiveStatements(db, account = () => null) {
  const q = statements(db);
  const on = (stmt) => ({ run: (row) => stmt.run({ account: account() ?? null, ...row }) });
  return {
    ...q,
    chat: unlessOwn(on(q.chat), (r) => r.ref),
    media: { run: (row) => q.media.run(mediaRow({ ...row, mimetype: fileType(row.mimetype, row.fileName) })) },
    msg: counted(unlessOwn(on(q.msg), (r) => r.chat)),
    msgFill: counted(
      unlessOwn(on(q.msgFill), (r) => r.chat),
      (r) => !q.exists.get(r.chat, r.id),
    ),
  };
}

function statements(db) {
  return {
    // A chat. A name already known is kept when none is given.
    chat: db.prepare(`INSERT INTO chats (ref, name, is_group, last_ts, account) VALUES (@ref, @name, @isGroup, @ts, @account)
      ON CONFLICT (ref) DO UPDATE SET name = COALESCE(excluded.name, chats.name),
        last_ts = MAX(COALESCE(chats.last_ts, 0), COALESCE(excluded.last_ts, 0)),
        account = COALESCE(chats.account, excluded.account)`),
    // A person: the name saved for them, the name they gave themselves, their number.
    contact: db.prepare(`INSERT INTO contacts (ref, name, notify, phone) VALUES (@ref, @name, @notify, @phone)
      ON CONFLICT (ref) DO UPDATE SET name = COALESCE(excluded.name, contacts.name),
        notify = COALESCE(excluded.notify, contacts.notify), phone = COALESCE(excluded.phone, contacts.phone)`),
    // A message. One already stored is left as it is.
    msg: db.prepare(`INSERT INTO messages (chat_ref, id, sender_ref, from_me, ts, type, text, quoted_id, link_url, link_title, link_desc, account)
      VALUES (@chat, @id, @sender, @fromMe, @ts, @type, @text, @quoted, @linkUrl, @linkTitle, @linkDesc, @account)
      ON CONFLICT (chat_ref, id) DO NOTHING`),
    // The same, for a source that sends a message more than once with more detail the
    // second time (a WhatsApp history sync): a missing sender or link preview is filled in.
    msgFill:
      db.prepare(`INSERT INTO messages (chat_ref, id, sender_ref, from_me, ts, type, text, quoted_id, link_url, link_title, link_desc, account)
      VALUES (@chat, @id, @sender, @fromMe, @ts, @type, @text, @quoted, @linkUrl, @linkTitle, @linkDesc, @account)
      ON CONFLICT (chat_ref, id) DO UPDATE SET
        sender_ref = COALESCE(messages.sender_ref, excluded.sender_ref),
        link_url = COALESCE(messages.link_url, excluded.link_url),
        link_title = COALESCE(messages.link_title, excluded.link_title),
        link_desc = COALESCE(messages.link_desc, excluded.link_desc)
      WHERE (messages.sender_ref IS NULL AND excluded.sender_ref IS NOT NULL)
        OR (excluded.link_url IS NOT NULL
          AND (messages.link_url IS NULL OR (messages.link_title IS NULL AND excluded.link_title IS NOT NULL)
               OR (messages.link_desc IS NULL AND excluded.link_desc IS NOT NULL)))`),
    exists: db.prepare('SELECT rowid FROM messages WHERE chat_ref = ? AND id = ?'),
    // The file a message carries: enough to fetch it later.
    media:
      db.prepare(`INSERT OR IGNORE INTO media (msg_rowid, dl_type, mimetype, size, width, height, seconds, file_name, file_sha256, thumb, fetch)
      VALUES (@rowid, @dlType, @mimetype, @size, @width, @height, @seconds, @fileName, @sha256, @thumb, @fetch)`),
    edit: db.prepare(`UPDATE messages SET text = @text, edited = 1,
      link_url = COALESCE(@linkUrl, link_url), link_title = COALESCE(@linkTitle, link_title), link_desc = COALESCE(@linkDesc, link_desc)
      WHERE chat_ref = @chat AND id = @id`),
    del: db.prepare('UPDATE messages SET deleted = 1 WHERE chat_ref = ? AND id = ?'),
    // Taking something out altogether (a source forgetting what it no longer keeps).
    remove: db.prepare('DELETE FROM messages WHERE chat_ref = ? AND id = ?'),
    removeLike: db.prepare('DELETE FROM messages WHERE chat_ref = ? AND id LIKE ?'),
    removeChat: db.prepare('DELETE FROM chats WHERE ref = ?'),
    removeChatMessages: db.prepare('DELETE FROM messages WHERE chat_ref = ?'),
    text: db.prepare('SELECT text FROM messages WHERE chat_ref = ? AND id = ?').pluck(),
    // What else a source does to what it keeps, so that none writes these tables itself.
    // The owner's own messages that were stored as someone else's (from `ref`, the owner).
    markMine: db.prepare('UPDATE messages SET from_me = 1, sender_ref = NULL WHERE sender_ref = ? AND from_me = 0'),
    // What a chat is (a group, a channel, a bot), and how far back its history is fetched.
    chatInfo: db.prepare(`INSERT INTO chat_info (ref, kind, members, username) VALUES (@ref, @kind, @members, @username)
      ON CONFLICT (ref) DO UPDATE SET kind = excluded.kind, members = COALESCE(excluded.members, chat_info.members), username = COALESCE(excluded.username, chat_info.username)`),
    setCutoff: db.prepare('UPDATE chat_info SET backfill_cutoff = ? WHERE ref = ?'),
    // A chat known under another name: its chat, its messages, and where it is the sender,
    // under the one name from now on; and the other name noted, to be read as the same.
    alias: db.prepare('INSERT OR REPLACE INTO aliases (ref, same_as) VALUES (?, ?)'),
    mergeChat:
      db.prepare(`INSERT INTO chats (ref, name, is_group, last_ts, account) SELECT ?, name, is_group, last_ts, account FROM chats WHERE ref = ?
      ON CONFLICT (ref) DO UPDATE SET name = COALESCE(chats.name, excluded.name), last_ts = MAX(COALESCE(chats.last_ts, 0), COALESCE(excluded.last_ts, 0))`),
    moveChatMessages: db.prepare('UPDATE OR IGNORE messages SET chat_ref = ? WHERE chat_ref = ?'),
    moveSender: db.prepare('UPDATE messages SET sender_ref = ? WHERE sender_ref = ?'),
    // A link's picture, and the message as the source gave it.
    linkThumb: db.prepare('INSERT OR IGNORE INTO link_thumbs (msg_rowid, jpeg, width, height) VALUES (?, ?, ?, ?)'),
    keepRaw: db.prepare('INSERT OR IGNORE INTO raw (msg_rowid, proto) VALUES (?, ?)'),
    renameChat: db.prepare('UPDATE chats SET name = ? WHERE ref = ?'),
  };
}

// The operations of a source on the whole of what it keeps. (`src`: its key, "wa".)
export function sourceChanges(db) {
  return {
    // The other ids its chats and people are known by: [{ ref, sameAs }].
    aliases: (src) => db.prepare(`SELECT ref, same_as AS sameAs FROM aliases WHERE ${sourceSql('ref', src)}`).all(),
    // A chat known as `from` is `to`: one person or chat never shows up twice.
    sameAs(from, to) {
      const q = statements(db);
      q.alias.run(from, to);
      q.mergeChat.run(to, from);
      q.removeChat.run(from);
      q.moveChatMessages.run(to, from);
      q.moveSender.run(to, from);
    },
    // Each of its chats' history to be fetched again (the chats it collects changed).
    refetchAll: (src) => db.prepare(`UPDATE chat_info SET backfill_cutoff = NULL WHERE ${sourceSql('ref', src)}`).run().changes,
    // A message deleted, known by its id alone: in any of the source's chats but those whose ref
    // starts with `except` (a deletion of a channel's names the channel). `idLike`: a LIKE pattern.
    deletedAnywhere: (src, idLike, except) =>
      db
        .prepare(`UPDATE messages SET deleted = 1 WHERE id LIKE ? ESCAPE '\\' AND ${sourceSql('chat_ref', src)} AND chat_ref NOT LIKE ?`)
        .run(idLike, `${except}%`).changes,
    // The source unlinked, and what it kept to go too: its messages, chats, people, what its chats
    // are, the other names of its chats, and its own notes. → how many messages went
    forget(src) {
      const n = db.prepare(`DELETE FROM messages WHERE ${sourceSql('chat_ref', src)}`).run().changes;
      for (const [t, col] of [
        ['chats', 'ref'],
        ['contacts', 'ref'],
        ['chat_info', 'ref'],
        ['aliases', 'ref'],
      ])
        db.prepare(`DELETE FROM ${t} WHERE ${sourceSql(col, src)}`).run();
      db.prepare("DELETE FROM meta WHERE key LIKE ? ESCAPE '\\'").run(`${src}\\_%`);
      return n;
    },
  };
}

// The columns of a media row that a source may leave out.
export const mediaRow = (m) => ({
  mimetype: null,
  size: null,
  width: null,
  height: null,
  seconds: null,
  fileName: null,
  sha256: null,
  thumb: null,
  ...m,
  // What the source keeps to fetch the file later, as it likes (src/archive/db.js, part 10): null when it can't be.
  fetch: m.fetch == null ? null : typeof m.fetch === 'string' ? m.fetch : JSON.stringify(m.fetch),
});
// The columns of a message that a source may leave out.
export const messageRow = (m) => ({
  sender: null,
  fromMe: 0,
  type: 'text',
  quoted: null,
  linkUrl: null,
  linkTitle: null,
  linkDesc: null,
  ...m,
});
