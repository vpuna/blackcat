// The mail the owner sent. It is collected beside what arrives, into the same chat, so that
// a reply, a promise or a plan they wrote is there for search, for watches and for "Things
// I need to do", and so that a conversation by mail can be read from both sides.
//
// Read-only, like the Inbox: the Sent folder is opened to look, never to change.
import { archiveSent, forgetSent, setState, stateOf } from './store.js';

// Bring one account's sent mail up to date, on a connection that is already open.
//   since   the start of the days the account keeps (ms)
//   room    how many mails' text may still be fetched in this run
//   imap    { sentHeaders, texts } (plugins/mail/imap.js)
//   label   the name the account goes by now
// → { fresh, stored, more }
// As far back as the account's days, as what arrives. What was sent before it was first
// collected is history, not news: "Things I need to do" reads mail only from the day it began
// to, and a watch that follows people by name never reads the owner's own.
export async function syncSent(db, client, name, me, { since, room, imap, label = name, nowS = Math.floor(Date.now() / 1000) }) {
  const st = stateOf(db, name);
  if (!st.sent_since) setState(db, name, { sent_since: nowS });
  const have = () => new Set(db.prepare('SELECT uid FROM sent WHERE account = ?').pluck().all(name));
  let h = await imap.sentHeaders(client, { sinceMs: since, have: have() });
  if (!h) return { fresh: 0, stored: 0, more: 0 }; // this server names no Sent folder
  // The server renumbered the folder (rare): what was stored no longer lines up.
  if (st.sent_validity && st.sent_validity !== h.uidValidity) {
    forgetSent(db, name);
    h = await imap.sentHeaders(client, { sinceMs: since, have: new Set() });
  }
  // (The server answers "since" by whole days: what was sent earlier that day is left out here.)
  const fresh = h.fresh.filter((m) => m.ts * 1000 >= since);
  const ins = db.prepare(
    'INSERT OR IGNORE INTO sent (account, uid, ts, to_addr, to_name, others, subject, files) VALUES (@account, @uid, @ts, @to, @toName, @others, @subject, @files)',
  );
  db.transaction(() => fresh.forEach((m) => ins.run({ account: name, ...m, files: JSON.stringify(m.files ?? []) })))();
  setState(db, name, { sent_validity: h.uidValidity });

  const waiting = db.prepare('SELECT * FROM sent WHERE account = ? AND stored = 0 ORDER BY ts DESC').all(name);
  const batch = waiting.slice(0, Math.max(0, room));
  const got = await imap.texts(
    client,
    batch.map((m) => m.uid),
    h.box,
  );
  // Oldest first, so the archive is in the order things were written.
  archiveSent(name, me, batch.filter((m) => got.has(m.uid)).reverse(), (m) => got.get(m.uid), label);
  const mark = db.prepare('UPDATE sent SET stored = 1 WHERE account = ? AND uid = ?');
  db.transaction(() => batch.forEach((m) => got.has(m.uid) && mark.run(name, m.uid)))();
  return { fresh: fresh.length, stored: batch.filter((m) => got.has(m.uid)).length, more: waiting.length - batch.length };
}
