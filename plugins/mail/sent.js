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
// → { fresh, stored, more }
export async function syncSent(db, client, name, me, { since, room, imap, nowS = Math.floor(Date.now() / 1000) }) {
  let st = stateOf(db, name);
  // The first time: from now on. What was sent before is not brought in as if it were new.
  if (!st.sent_since) {
    setState(db, name, { sent_since: nowS });
    st = stateOf(db, name);
  }
  const from = Math.max(since, st.sent_since * 1000);
  const have = () => new Set(db.prepare('SELECT uid FROM sent WHERE account = ?').pluck().all(name));
  let h = await imap.sentHeaders(client, { sinceMs: from, have: have() });
  if (!h) return { fresh: 0, stored: 0, more: 0 }; // this server names no Sent folder
  // The server renumbered the folder (rare): what was stored no longer lines up.
  if (st.sent_validity && st.sent_validity !== h.uidValidity) {
    forgetSent(db, name);
    h = await imap.sentHeaders(client, { sinceMs: from, have: new Set() });
  }
  // (The server answers "since" by whole days: what was sent earlier that day is left out here.)
  const fresh = h.fresh.filter((m) => m.ts >= st.sent_since);
  const ins = db.prepare(
    'INSERT OR IGNORE INTO sent (account, uid, ts, to_addr, to_name, others, subject) VALUES (@account, @uid, @ts, @to, @toName, @others, @subject)',
  );
  db.transaction(() => fresh.forEach((m) => ins.run({ account: name, ...m })))();
  setState(db, name, { sent_validity: h.uidValidity });

  const waiting = db.prepare('SELECT * FROM sent WHERE account = ? AND stored = 0 ORDER BY ts DESC').all(name);
  const batch = waiting.slice(0, Math.max(0, room));
  const got = await imap.texts(
    client,
    batch.map((m) => m.uid),
    h.box,
  );
  // Oldest first, so the archive is in the order things were written.
  archiveSent(name, me, batch.filter((m) => got.has(m.uid)).reverse(), (m) => got.get(m.uid));
  const mark = db.prepare('UPDATE sent SET stored = 1 WHERE account = ? AND uid = ?');
  db.transaction(() => batch.forEach((m) => got.has(m.uid) && mark.run(name, m.uid)))();
  return { fresh: fresh.length, stored: batch.filter((m) => got.has(m.uid)).length, more: waiting.length - batch.length };
}
