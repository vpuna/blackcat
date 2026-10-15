// The mail the owner sent is collected beside what arrives: into the same chat, as theirs,
// from the day this is first run, read-only, and once.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { home } from './helpers.js';

const dir = home();
const { save } = await import('../src/config.js');
save({
  plugins: {
    enabled: ['mail'],
    settings: { mail: { accounts: { home: { address: 'me@example.org', host: 'imap.example.org', days: 30 } } } },
  },
});
const { loadPlugins, findLoaded, makeCtx } = await import('../src/plugins/registry.js');
await loadPlugins();
const ctx = makeCtx(findLoaded('mail'));
const { openStore, stateOf, forget } = await import('../plugins/mail/store.js');
const { syncSent } = await import('../plugins/mail/sent.js');
const imap = await import('../plugins/mail/imap.js');
const { openRead } = await import('../src/archive/db.js');

// A stand-in for the mail server: two folders, each with its own numbering. Everything
// asked of it is noted, so that "it only looked" can be checked.
const asked = [];
function server({ sent, validity = 7, sentFolder = '[Mail]/Sent' }) {
  const boxes = { INBOX: { uidValidity: 1, mails: [] }, ...(sentFolder ? { [sentFolder]: { uidValidity: validity, mails: sent } } : {}) };
  const client = {
    mailbox: null,
    list: async () => [{ path: 'INBOX' }, ...(sentFolder ? [{ path: sentFolder, specialUse: '\\Sent' }] : [])],
    getMailboxLock: async (box, opts) => {
      asked.push(['open', box, opts?.readOnly === true]);
      const b = boxes[box];
      client.mailbox = { uidValidity: b.uidValidity, uidNext: b.mails.length + 1, exists: b.mails.length, path: box };
      client.open = b;
      return { release: () => {} };
    },
    search: async ({ since }) => {
      asked.push(['search']);
      const day = new Date(since).setHours(0, 0, 0, 0); // by whole days, as a server answers
      return client.open.mails.filter((m) => m.ts * 1000 >= day).map((m) => m.uid);
    },
    fetch: async function* (range) {
      asked.push(['fetch', range]);
      for (const uid of String(range).split(',').map(Number)) {
        const m = client.open.mails.find((x) => x.uid === uid);
        if (m) yield { uid, internalDate: new Date(m.ts * 1000), envelope: { subject: m.subject, to: m.to, cc: m.cc ?? [] } };
      }
    },
    fetchOne: async (uid) => {
      asked.push(['text', Number(uid)]);
      const m = client.open.mails.find((x) => x.uid === Number(uid));
      return m ? { source: Buffer.from(`Subject: ${m.subject}\r\nContent-Type: text/plain\r\n\r\n${m.body}\r\n`) } : null;
    },
  };
  return client;
}
const now = Math.floor(Date.now() / 1000);
const DAY = 86400;
const since = (now - 30 * DAY) * 1000;
const inArchive = () => {
  const a = openRead();
  if (!a) return [];
  const rows = a.prepare("SELECT id, from_me, ts, text, chat_ref FROM messages WHERE chat_ref = 'mail:home' ORDER BY rowid").all();
  a.close();
  return rows;
};
const run = (db, client, extra = {}) => syncSent(db, client, 'home', 'me@example.org', { since, room: 150, imap, ...extra });

test('the first time nothing old is brought in: sent mail is collected from then on', async () => {
  const db = openStore(ctx);
  const old = [
    {
      uid: 1,
      ts: now - 5 * DAY,
      subject: 'Re: quote',
      to: [{ address: 'Builder@Example.org', name: 'The Builder' }],
      body: 'I will pay on Friday.',
    },
    {
      uid: 2,
      ts: now - 3600,
      subject: 'Earlier today',
      to: [{ address: 'a@example.org' }],
      body: 'Sent an hour before this was switched on.',
    },
  ];
  const r = await run(db, server({ sent: old }));
  assert.deepEqual(r, { fresh: 0, stored: 0, more: 0 });
  assert.ok(Math.abs(stateOf(db, 'home').sent_since - now) <= 5);
  assert.deepEqual(inArchive(), []);
  db.close();
});

test("a mail sent after that is stored once, as the owner's, in the chat of that account, with who it was to", async () => {
  const db = openStore(ctx);
  const sent = [
    { uid: 1, ts: now - 5 * DAY, subject: 'Re: quote', to: [{ address: 'builder@example.org' }], body: 'old' },
    {
      uid: 3,
      ts: now + 60,
      subject: 'Re: When is the schedule?',
      to: [{ address: 'Priya@Work.Example', name: 'Priya Nair' }],
      cc: [{ address: 'sam@work.example' }],
      body: 'I will send the schedule by Thursday.\n\nOn Tuesday Priya wrote:\n> When is the schedule?',
    },
  ];
  asked.length = 0;
  const client = server({ sent });
  assert.deepEqual(await run(db, client, { nowS: now + 120 }), { fresh: 1, stored: 1, more: 0 });
  const [m] = inArchive();
  assert.deepEqual([m.id, m.from_me, m.ts, m.chat_ref], ['mail:home:s3', 1, now + 60, 'mail:home']);
  assert.equal(
    m.text,
    'Subject: Re: When is the schedule?\nTo: Priya Nair <priya@work.example> and 1 more\n\nI will send the schedule by Thursday.\n\nOn Tuesday Priya wrote:\n> When is the schedule?',
  );
  // only ever looked: every folder was opened read-only, and nothing but searching and fetching was asked
  assert.ok(
    asked.filter((a) => a[0] === 'open').every((a) => a[2] === true),
    JSON.stringify(asked),
  );
  assert.deepEqual([...new Set(asked.map((a) => a[0]))].sort(), ['fetch', 'open', 'search', 'text']);
  // again: nothing is fetched or stored twice
  asked.length = 0;
  assert.deepEqual(await run(db, client, { nowS: now + 180 }), { fresh: 0, stored: 0, more: 0 });
  assert.equal(asked.filter((a) => a[0] === 'text' || a[0] === 'fetch').length, 0);
  assert.equal(inArchive().length, 1);
  // it is found like any other message, and as from the owner
  const { search } = await import('../src/archive/query.js');
  const a = openRead();
  const hit = search(a, 'schedule Thursday', { limit: 5 });
  a.close();
  const top = (hit.results ?? hit)[0];
  assert.ok(top.fromMe ?? top.from_me, 'found, and as from the owner');
  assert.match(top.text ?? top.snippet ?? '', /schedule/i);
  db.close();
});

test('more than fits in one run waits for the next; the folder renumbered starts it afresh; a server with no Sent folder is left alone', async () => {
  const db = openStore(ctx);
  const many = [3, 4, 5, 6].map((uid) => ({
    uid,
    ts: now + 60 * uid,
    subject: `Note ${uid}`,
    to: [{ address: 'x@example.org' }],
    body: `body ${uid}`,
  }));
  assert.deepEqual(await run(db, server({ sent: many }), { room: 2, nowS: now + 900 }), { fresh: 3, stored: 2, more: 1 });
  assert.deepEqual(await run(db, server({ sent: many }), { room: 2, nowS: now + 960 }), { fresh: 0, stored: 1, more: 0 });
  assert.deepEqual(
    inArchive()
      .map((m) => m.id)
      .sort(),
    ['mail:home:s3', 'mail:home:s4', 'mail:home:s5', 'mail:home:s6'],
  );
  // the server gives the folder a new numbering: uid 3 is now another mail
  const renumbered = [{ uid: 3, ts: now + 2000, subject: 'After the move', to: [{ address: 'y@example.org' }], body: 'new numbering' }];
  assert.deepEqual(await run(db, server({ sent: renumbered, validity: 8 }), { nowS: now + 2100 }), { fresh: 1, stored: 1, more: 0 });
  assert.deepEqual(
    inArchive().map((m) => [m.id, m.text.split('\n')[0]]),
    [['mail:home:s3', 'Subject: After the move']],
  );
  assert.equal(stateOf(db, 'home').sent_validity, '8');
  // no Sent folder named by the server: nothing happens, nothing is lost
  assert.deepEqual(await run(db, server({ sent: [], sentFolder: null }), { nowS: now + 2200 }), { fresh: 0, stored: 0, more: 0 });
  assert.equal(inArchive().length, 1);
  db.close();
});

test('what the account keeps is the same for sent mail: older than its days goes, and removing the account takes all of it', async () => {
  const db = openStore(ctx);
  forget(db, 'home', now + 2050); // everything before this moment
  assert.deepEqual(
    inArchive().map((m) => m.id),
    [],
  );
  assert.equal(db.prepare('SELECT COUNT(*) FROM sent').pluck().get(), 0);
  await run(
    db,
    server({ sent: [{ uid: 9, ts: now + 3000, subject: 'Last', to: [{ address: 'z@example.org' }], body: 'x' }], validity: 8 }),
    { nowS: now + 3100 },
  );
  assert.equal(inArchive().length, 1);
  forget(db, 'home');
  assert.deepEqual(
    [inArchive().length, db.prepare('SELECT COUNT(*) FROM sent').pluck().get(), stateOf(db, 'home').sent_since],
    [0, 0, undefined],
  );
  db.close();
});

test('a store from before sent mail was collected gains the table, and keeps every mail it had', async () => {
  const { openSqlite } = await import('../src/db.js');
  const fs = await import('node:fs');
  const older = path.join(dir, 'older');
  fs.mkdirSync(older);
  const raw = openSqlite(path.join(older, 'mail.db'));
  raw.exec(`CREATE TABLE shapes (part TEXT PRIMARY KEY, step INTEGER NOT NULL); INSERT INTO shapes VALUES ('mail', 2);
    CREATE TABLE mail (account TEXT NOT NULL, uid INTEGER NOT NULL, ts INTEGER NOT NULL, from_addr TEXT, from_name TEXT, subject TEXT, files TEXT, bulk TEXT, is_primary INTEGER,
      from_me INTEGER NOT NULL DEFAULT 0, kept INTEGER NOT NULL DEFAULT 0, reason TEXT, stored INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (account, uid));
    CREATE TABLE known (account TEXT NOT NULL, addr TEXT NOT NULL, PRIMARY KEY (account, addr));
    CREATE TABLE state (account TEXT PRIMARY KEY, uid_validity TEXT, known_at INTEGER, synced_at INTEGER, error TEXT, error_since INTEGER, told INTEGER NOT NULL DEFAULT 0, gmail INTEGER, mark TEXT, full_at INTEGER);
    INSERT INTO mail (account, uid, ts, subject, kept, stored) VALUES ('home', 41, 1700000000, 'kept before', 1, 1);
    INSERT INTO state (account, uid_validity, mark) VALUES ('home', '1', 'm');`);
  raw.close();
  const db = openStore({ dataDir: older });
  assert.equal(db.prepare("SELECT step FROM shapes WHERE part = 'mail'").pluck().get(), 3);
  assert.deepEqual(db.prepare('SELECT account, uid, subject, kept, stored FROM mail').all(), [
    { account: 'home', uid: 41, subject: 'kept before', kept: 1, stored: 1 },
  ]);
  assert.deepEqual(db.prepare('SELECT uid_validity, mark, sent_validity, sent_since FROM state').get(), {
    uid_validity: '1',
    mark: 'm',
    sent_validity: null,
    sent_since: null,
  });
  assert.equal(db.prepare('SELECT COUNT(*) FROM sent').pluck().get(), 0);
  db.close();
});
