// Where mail is kept. Two places:
//   the plugin's own small database: one header line per Inbox mail (who, when, subject,
//     and whether it was kept), for every mail, including the ones that were skipped;
//   the message archive (the one WhatsApp and Telegram write to): the text of the mail
//     that was kept, and of the mail the owner sent, so search, watches and the agent see
//     it like any other message.
//     One account is one chat there ("Mail: personal"), and each sender is a person in it.
import path from 'node:path';
import { archiveStatements, mediaRow, messageRow, openArchiveForWriting as openWrite, openSqlite, upgrade, withDb } from '../../src/api.js';

export const chatRef = (account) => `mail:${account}`;
export const msgId = (account, uid) => `mail:${account}:${uid}`;
// (A sent mail is numbered by its own folder: "s" keeps it apart from the Inbox mail with the same number.)
export const sentId = (account, uid) => `mail:${account}:s${uid}`;
export const chatName = (account) => `Mail: ${account}`;

// state.mark: what the server last said about the mailbox as a whole (see mailboxMark).
// state.full_at: when everything was last gone through in full.
const STEPS = [
  (db) =>
    db.exec(`
      CREATE TABLE IF NOT EXISTS mail (
        account TEXT NOT NULL, uid INTEGER NOT NULL, ts INTEGER NOT NULL,
        from_addr TEXT, from_name TEXT, subject TEXT, files TEXT,
        bulk TEXT,            -- why it counts as bulk mail, or null
        is_primary INTEGER,   -- Gmail: in the Primary tab (null for other providers)
        from_me INTEGER NOT NULL DEFAULT 0,
        kept INTEGER NOT NULL DEFAULT 0, reason TEXT,
        stored INTEGER NOT NULL DEFAULT 0,  -- its text is in the archive
        PRIMARY KEY (account, uid));
      CREATE INDEX IF NOT EXISTS mail_ts ON mail (account, ts);
      CREATE TABLE IF NOT EXISTS known (account TEXT NOT NULL, addr TEXT NOT NULL, PRIMARY KEY (account, addr));
      CREATE TABLE IF NOT EXISTS state (account TEXT PRIMARY KEY, uid_validity TEXT, known_at INTEGER, synced_at INTEGER, error TEXT, error_since INTEGER, told INTEGER NOT NULL DEFAULT 0, gmail INTEGER, mark TEXT, full_at INTEGER);
    `),
  // 3: the mail the owner sent, one header line each. It is collected from the day this
  //    came in (state.sent_since), so that a month of old replies does not arrive at once
  //    as if it were new.
  (db) =>
    db.exec(`
      CREATE TABLE sent (
        account TEXT NOT NULL, uid INTEGER NOT NULL, ts INTEGER NOT NULL,
        to_addr TEXT, to_name TEXT, others INTEGER NOT NULL DEFAULT 0, subject TEXT,
        stored INTEGER NOT NULL DEFAULT 0,  -- its text is in the archive
        PRIMARY KEY (account, uid));
      ALTER TABLE state ADD COLUMN sent_validity TEXT;
      ALTER TABLE state ADD COLUMN sent_since INTEGER;
    `),
];

export function openStore(ctx) {
  const db = openSqlite(path.join(ctx.dataDir, 'mail.db'));
  upgrade(db, 'mail', STEPS, { base: 2, owns: ['mail'] });
  return db;
}

export const stateOf = (db, account) => db.prepare('SELECT * FROM state WHERE account = ?').get(account) ?? { account };
export function setState(db, account, patch) {
  db.prepare('INSERT OR IGNORE INTO state (account) VALUES (?)').run(account);
  for (const [k, v] of Object.entries(patch)) db.prepare(`UPDATE state SET ${k} = ? WHERE account = ?`).run(v, account);
}

// ---------- the archive ----------
const sender = (m) => `mail:${m.from_addr || 'unknown'}`;
export const filesOf = (m) => JSON.parse(m.files || '[]').filter((f) => f && typeof f === 'object');

// Run `fn` with the archive open for writing and the shared statements, and close it after.
function withArchive(fn) {
  return withDb(openWrite, (wa) => {
    return fn(archiveStatements(wa), wa);
  });
}

export function archive(account, rows, textOf) {
  withArchive((q, wa) =>
    wa.transaction(() => {
      for (const m of rows) {
        const files = filesOf(m);
        const base = { chat: chatRef(account), sender: sender(m), fromMe: m.from_me ? 1 : 0, ts: m.ts };
        q.chat.run({ ref: chatRef(account), name: chatName(account), isGroup: 1, ts: m.ts });
        q.contact.run({
          ref: sender(m),
          name: m.from_name ? `${m.from_name} <${m.from_addr}>` : m.from_addr || 'Unknown sender',
          notify: null,
          phone: null,
        });
        q.msg.run(
          messageRow({
            ...base,
            id: msgId(account, m.uid),
            text: `Subject: ${m.subject || '(no subject)'}\n\n${textOf(m) || '(this mail has no readable text)'}${files.length ? `\n\n[attached: ${files.map((f) => f.name).join(', ')}]` : ''}`,
          }),
        );
        // Each attachment follows as a message of its own, the way a file arrives in a chat,
        // so it can be fetched and read like any other (bc msg media, watches with attachments on).
        files.forEach((f, n) => {
          const r = q.msg.run(
            messageRow({
              ...base,
              id: `${msgId(account, m.uid)}:${n + 1}`,
              type: f.type.startsWith('image/') ? 'image' : 'document',
              text: `${f.name} (attached to "${m.subject || 'a mail with no subject'}")`,
            }),
          );
          // dlType "mail": fetched from the mail server when asked for; directPath is the part of the mail it is.
          if (r.changes)
            q.media.run(
              mediaRow({ rowid: r.lastInsertRowid, dlType: 'mail', mimetype: f.type, size: f.size, fileName: f.name, directPath: f.part }),
            );
        });
      }
    })(),
  );
}

// What the owner sent, in the same chat as what the account received, as theirs ("Me").
export function archiveSent(account, me, rows, textOf) {
  const ref = `mail:${me || 'me'}`;
  withArchive((q, wa) =>
    wa.transaction(() => {
      for (const m of rows) {
        q.chat.run({ ref: chatRef(account), name: chatName(account), isGroup: 1, ts: m.ts });
        q.contact.run({ ref, name: me || 'Me', notify: null, phone: null });
        const to = m.to_addr
          ? `${m.to_name ? `${m.to_name} <${m.to_addr}>` : m.to_addr}${m.others ? ` and ${m.others} more` : ''}`
          : 'nobody named';
        q.msg.run(
          messageRow({
            chat: chatRef(account),
            sender: ref,
            fromMe: 1,
            ts: m.ts,
            id: sentId(account, m.uid),
            text: `Subject: ${m.subject || '(no subject)'}\nTo: ${to}\n\n${textOf(m) || '(this mail has no readable text)'}`,
          }),
        );
      }
    })(),
  );
}

// Forget what was collected of an account's sent mail (the server renumbered the folder).
export function forgetSent(db, account) {
  withArchive((q) => q.removeLike.run(chatRef(account), `${sentId(account, '')}%`));
  db.prepare('DELETE FROM sent WHERE account = ?').run(account);
}

export function unarchive(account, uids) {
  if (!uids.length) return;
  withArchive((q, wa) =>
    wa.transaction(() =>
      uids.forEach((u) => {
        q.remove.run(chatRef(account), msgId(account, u));
        q.removeLike.run(chatRef(account), `${msgId(account, u)}:%`);
      }),
    )(),
  );
}

// Forget an account's mail entirely (or, with a cutoff, what is older than it).
export function forget(db, account, beforeTs = null) {
  withArchive((q) => {
    if (beforeTs == null) {
      q.removeChatMessages.run(chatRef(account));
      q.removeChat.run(chatRef(account));
      for (const t of ['mail', 'sent', 'known', 'state']) db.prepare(`DELETE FROM ${t} WHERE account = ?`).run(account);
    } else {
      q.removeBefore.run(chatRef(account), beforeTs);
      for (const t of ['mail', 'sent']) db.prepare(`DELETE FROM ${t} WHERE account = ? AND ts < ?`).run(account, beforeTs);
    }
  });
}

export const storedText = (account, uid) => withArchive((q) => q.text.get(chatRef(account), msgId(account, uid)) ?? null);
