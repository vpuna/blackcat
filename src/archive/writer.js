// The statements that write into the archive, shared by everything that collects: the
// WhatsApp and Telegram sources and any plugin that adds a source. One definition, so a
// chat, a person or a message is recorded the same way wherever it came from.
import { ownRefs } from '../channels/registry.js';

// A chat that is blackcat itself (src/channels/registry.js, ownRefs) is never written: not
// the chat, not a message in it. This is held here, for every source, so that one written
// later cannot forget it.
const never = { changes: 0, lastInsertRowid: 0 };
const unlessOwn = (stmt, refOf) => ({ run: (row) => (ownRefs().includes(refOf(row)) ? never : stmt.run(row)) });

export function archiveStatements(db) {
  const q = statements(db);
  return {
    ...q,
    chat: unlessOwn(q.chat, (r) => r.ref),
    msg: unlessOwn(q.msg, (r) => r.chat),
    msgFill: unlessOwn(q.msgFill, (r) => r.chat),
  };
}

function statements(db) {
  return {
    // A chat. A name already known is kept when none is given.
    chat: db.prepare(`INSERT INTO chats (ref, name, is_group, last_ts) VALUES (@ref, @name, @isGroup, @ts)
      ON CONFLICT (ref) DO UPDATE SET name = COALESCE(excluded.name, chats.name),
        last_ts = MAX(COALESCE(chats.last_ts, 0), COALESCE(excluded.last_ts, 0))`),
    // A person: the name saved for them, the name they gave themselves, their number.
    contact: db.prepare(`INSERT INTO contacts (ref, name, notify, phone) VALUES (@ref, @name, @notify, @phone)
      ON CONFLICT (ref) DO UPDATE SET name = COALESCE(excluded.name, contacts.name),
        notify = COALESCE(excluded.notify, contacts.notify), phone = COALESCE(excluded.phone, contacts.phone)`),
    // A message. One already stored is left as it is.
    msg: db.prepare(`INSERT INTO messages (chat_ref, id, sender_ref, from_me, ts, type, text, quoted_id, link_url, link_title, link_desc)
      VALUES (@chat, @id, @sender, @fromMe, @ts, @type, @text, @quoted, @linkUrl, @linkTitle, @linkDesc)
      ON CONFLICT (chat_ref, id) DO NOTHING`),
    // The same, for a source that sends a message more than once with more detail the
    // second time (a WhatsApp history sync): a missing sender or link preview is filled in.
    msgFill:
      db.prepare(`INSERT INTO messages (chat_ref, id, sender_ref, from_me, ts, type, text, quoted_id, link_url, link_title, link_desc)
      VALUES (@chat, @id, @sender, @fromMe, @ts, @type, @text, @quoted, @linkUrl, @linkTitle, @linkDesc)
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
      db.prepare(`INSERT OR IGNORE INTO media (msg_rowid, dl_type, mimetype, size, width, height, seconds, file_name, direct_path, url, media_key, file_sha256, file_enc_sha256, thumb)
      VALUES (@rowid, @dlType, @mimetype, @size, @width, @height, @seconds, @fileName, @directPath, @url, @mediaKey, @sha256, @encSha256, @thumb)`),
    edit: db.prepare(`UPDATE messages SET text = @text, edited = 1,
      link_url = COALESCE(@linkUrl, link_url), link_title = COALESCE(@linkTitle, link_title), link_desc = COALESCE(@linkDesc, link_desc)
      WHERE chat_ref = @chat AND id = @id`),
    del: db.prepare('UPDATE messages SET deleted = 1 WHERE chat_ref = ? AND id = ?'),
    // Taking something out altogether (a source forgetting what it no longer keeps).
    remove: db.prepare('DELETE FROM messages WHERE chat_ref = ? AND id = ?'),
    removeLike: db.prepare('DELETE FROM messages WHERE chat_ref = ? AND id LIKE ?'),
    removeBefore: db.prepare('DELETE FROM messages WHERE chat_ref = ? AND ts < ?'),
    removeChat: db.prepare('DELETE FROM chats WHERE ref = ?'),
    removeChatMessages: db.prepare('DELETE FROM messages WHERE chat_ref = ?'),
    text: db.prepare('SELECT text FROM messages WHERE chat_ref = ? AND id = ?').pluck(),
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
  directPath: null,
  url: null,
  mediaKey: null,
  sha256: null,
  encSha256: null,
  thumb: null,
  ...m,
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
