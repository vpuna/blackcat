// Reading a mailbox over IMAP, the standard every mail provider speaks. The mailbox is
// opened read-only: nothing is marked as read, moved, deleted or sent.
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { ImapFlow } from 'imapflow';
import { addrOf, bulk } from './rules.js';

const SOURCE_MAX = 3 * 1024 ** 2; // bytes of one mail read for its text; attachments beyond this are not needed
export const TEXT_MAX = 6000; // characters of a mail's text that are kept

const friendly = (e) => {
  const t = `${e.responseText ?? ''} ${e.message ?? ''} ${e.code ?? ''}`;
  if (e.authenticationFailed || /AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed/i.test(t))
    return 'the address or app password was not accepted. Use an app password (not your normal password), and check that IMAP is allowed for the account';
  if (/Application-specific password required/i.test(t)) return 'this account needs an app password: your normal password is not accepted';
  if (/ENOTFOUND|EAI_AGAIN/.test(t)) return 'the mail server could not be found (check the server name, and the network)';
  if (/ETIMEDOUT|ECONNREFUSED|ECONNRESET|timeout/i.test(t)) return 'the mail server did not answer';
  return (e.responseText || e.message || String(e)).slice(0, 200);
};

// Run `fn(client)` on a connection, and always log out.
export async function withMailbox({ host, port = 993, user, pass }, fn) {
  const client = new ImapFlow({
    host,
    port,
    secure: true,
    auth: { user, pass },
    logger: false,
    socketTimeout: 120_000,
    connectionTimeout: 30_000,
  });
  client.on('error', () => {}); // a dropped connection is reported by the call in progress
  try {
    await client.connect();
  } catch (e) {
    throw new Error(friendly(e));
  }
  try {
    return await fn(client);
  } catch (e) {
    throw new Error(friendly(e));
  } finally {
    await client.logout().catch(() => client.close());
  }
}

// What the server says about the Inbox as a whole, in one line. While this stays the same,
// nothing has arrived, gone, or (where the server counts changes, as Gmail does) been moved
// or relabelled, so there is nothing to fetch.
export async function mailboxMark(client) {
  const lock = await client.getMailboxLock('INBOX', { readOnly: true });
  try {
    const m = client.mailbox;
    return [m.uidValidity, m.uidNext, m.exists, m.highestModseq ?? ''].map(String).join(':');
  } finally {
    lock.release();
  }
}

const pick = (list) => list?.[0] ?? {};
function headerMap(buf) {
  const out = {};
  for (const line of String(buf ?? '')
    .replace(/\r?\n[ \t]+/g, ' ')
    .split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

// The header line of every Inbox mail since `sinceMs` that is not in `have` (a Set of UIDs).
// → { uidValidity, gmail, uids (all in the window), fresh: [{ uid, ts, from, fromName, subject, bulk, primary, files }] }
export async function newHeaders(client, { sinceMs, have, me }) {
  const lock = await client.getMailboxLock('INBOX', { readOnly: true });
  try {
    const gmail = client.capabilities.has('X-GM-EXT-1');
    const since = new Date(sinceMs);
    const uids = (await client.search({ since }, { uid: true })) || [];
    const days = Math.max(1, Math.ceil((Date.now() - sinceMs) / 86400000) + 1);
    // Gmail sorts the inbox into tabs; Primary is where mail from people lands.
    let primary = null;
    if (gmail) {
      // Asked for as "in none of the other tabs": over IMAP, Gmail answers "category:primary" with nothing.
      const found = await client
        .search({ gmraw: `-category:promotions -category:updates -category:social -category:forums newer_than:${days}d` }, { uid: true })
        .catch(() => null);
      // If the tabs can't be asked for, fall back to the rules every provider gets.
      if (found) primary = new Set(found);
    }
    const want = uids.filter((u) => !have.has(u));
    const fresh = [];
    for (let i = 0; i < want.length; i += 200) {
      const range = want.slice(i, i + 200).join(',');
      for await (const m of client.fetch(
        range,
        {
          uid: true,
          envelope: true,
          internalDate: true,
          bodyStructure: true,
          headers: ['list-unsubscribe', 'list-id', 'precedence', 'auto-submitted'],
        },
        { uid: true },
      )) {
        const f = pick(m.envelope?.from);
        const from = addrOf(f.address);
        const files = [];
        const walk = (n) => {
          if (!n) return;
          const name = n.dispositionParameters?.filename ?? n.parameters?.name;
          // A named part that is a real attachment (not the mail's own text, not a picture shown inside it).
          if (name && n.part && (n.disposition === 'attachment' || (!/^text\//.test(n.type ?? '') && n.disposition !== 'inline')))
            files.push({
              name: String(name).slice(0, 120),
              part: n.part,
              type: String(n.type ?? 'application/octet-stream').toLowerCase(),
              size: n.size ?? null,
            });
          (n.childNodes ?? []).forEach(walk);
        };
        walk(m.bodyStructure);
        fresh.push({
          uid: m.uid,
          ts: Math.floor(new Date(m.internalDate ?? m.envelope?.date ?? Date.now()) / 1000),
          from,
          fromName: (f.name || '').replace(/\s+/g, ' ').trim().slice(0, 80) || null,
          subject: (m.envelope?.subject ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
          bulk: bulk(headerMap(m.headers)),
          primary: primary ? primary.has(m.uid) : null,
          fromMe: from === addrOf(me),
          files,
        });
      }
    }
    return { uidValidity: String(client.mailbox.uidValidity), gmail: !!primary, primary, uids, fresh };
  } finally {
    lock.release();
  }
}

// The readable text of mails, by UID, in the Inbox or the folder named. → Map(uid → text)
export async function texts(client, uids, box = 'INBOX') {
  const out = new Map();
  if (!uids.length) return out;
  // The parsers are large, and most fetches bring no new mail to read: load them only now.
  const [{ simpleParser }, { convert }] = await Promise.all([import('mailparser'), import('html-to-text')]);
  const lock = await client.getMailboxLock(box, { readOnly: true });
  try {
    for (const uid of uids) {
      const m = await client.fetchOne(String(uid), { uid: true, source: { maxLength: SOURCE_MAX } }, { uid: true });
      if (!m?.source) continue;
      const p = await simpleParser(m.source, { skipTextToHtml: true });
      // Many mails are HTML only. Links keep their address; pictures and layout are dropped.
      const plain = p.text?.trim()
        ? p.text
        : p.html
          ? convert(p.html, {
              wordwrap: false,
              selectors: [
                { selector: 'img', format: 'skip' },
                { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
              ],
            })
          : '';
      const text = plain
        .replace(/\r/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/\u200B|\u200C|\u200D|\uFEFF|\u00AD|\u034F/g, '')
        .trim();
      out.set(uid, text.slice(0, TEXT_MAX) + (text.length > TEXT_MAX ? '\n[… the rest of this mail is not kept]' : ''));
    }
    return out;
  } finally {
    lock.release();
  }
}

// Save one attachment of a mail to `dest`. `part` is its position in the mail, noted when the mail arrived.
export async function download(client, uid, part, dest) {
  const lock = await client.getMailboxLock('INBOX', { readOnly: true });
  try {
    const d = await client.download(String(uid), part, { uid: true });
    if (!d?.content) throw new Error('the mail is no longer in the Inbox');
    await pipeline(d.content, fs.createWriteStream(dest, { mode: 0o600 }));
  } finally {
    lock.release();
  }
}

// ---------- the Sent folder: what the owner wrote ----------

// Where the server keeps sent mail, or null when it does not say. (Asked once for a connection.)
const sentPaths = new WeakMap();
export async function sentBox(client) {
  if (!sentPaths.has(client)) sentPaths.set(client, (await client.list()).find((b) => b.specialUse === '\\Sent')?.path ?? null);
  return sentPaths.get(client);
}

// What the server says about the Sent folder as a whole (as mailboxMark does of the Inbox), or '' with none.
export async function sentMark(client) {
  const box = await sentBox(client);
  if (!box) return '';
  const lock = await client.getMailboxLock(box, { readOnly: true });
  try {
    const m = client.mailbox;
    return [m.uidValidity, m.uidNext, m.exists].map(String).join(':');
  } finally {
    lock.release();
  }
}

// The header line of every sent mail since `sinceMs` that is not in `have` (a Set of UIDs).
// → null with no Sent folder, or { box, uidValidity, uids, fresh: [{ uid, ts, to, toName, others, subject }] }
export async function sentHeaders(client, { sinceMs, have }) {
  const box = await sentBox(client);
  if (!box) return null;
  const lock = await client.getMailboxLock(box, { readOnly: true });
  try {
    const uids = (await client.search({ since: new Date(sinceMs) }, { uid: true })) || [];
    const want = uids.filter((u) => !have.has(u));
    const fresh = [];
    for (let i = 0; i < want.length; i += 200) {
      for await (const m of client.fetch(
        want.slice(i, i + 200).join(','),
        { uid: true, envelope: true, internalDate: true },
        { uid: true },
      )) {
        const all = [...(m.envelope?.to ?? []), ...(m.envelope?.cc ?? [])].filter((a) => a?.address);
        const first = all[0] ?? {};
        fresh.push({
          uid: m.uid,
          ts: Math.floor(new Date(m.internalDate ?? m.envelope?.date ?? Date.now()) / 1000),
          to: first.address ? addrOf(first.address) : null,
          toName: (first.name || '').replace(/\s+/g, ' ').trim().slice(0, 80) || null,
          others: Math.max(0, all.length - 1),
          subject: (m.envelope?.subject ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
        });
      }
    }
    return { box, uidValidity: String(client.mailbox.uidValidity), uids, fresh };
  } finally {
    lock.release();
  }
}

// Addresses the owner has written to, from the Sent folder: mail from them is from someone known.
export async function writtenTo(client, sinceMs) {
  const box = await sentBox(client);
  if (!box) return [];
  const lock = await client.getMailboxLock(box, { readOnly: true });
  try {
    const uids = (await client.search({ since: new Date(sinceMs) }, { uid: true })) || [];
    const out = new Set();
    for (let i = 0; i < uids.length; i += 500) {
      for await (const m of client.fetch(uids.slice(i, i + 500).join(','), { uid: true, envelope: true }, { uid: true })) {
        for (const a of [...(m.envelope?.to ?? []), ...(m.envelope?.cc ?? [])]) if (a.address) out.add(addrOf(a.address));
      }
    }
    return [...out];
  } finally {
    lock.release();
  }
}
