// The mail the owner sent is collected beside what arrives: into the same chat, as theirs,
// as far back as the account's days, with its attachments, read-only, and once. (A real
// case: an ID sent to an insurer in September was not there to be found.)
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
        if (m)
          yield {
            uid,
            internalDate: new Date(m.ts * 1000),
            envelope: { subject: m.subject, to: m.to, cc: m.cc ?? [] },
            bodyStructure: {
              type: 'multipart/mixed',
              childNodes: [
                { part: '1', type: 'text/plain' },
                ...(m.files ?? []).map((f, n) => ({
                  part: String(n + 2),
                  type: f.type,
                  disposition: 'attachment',
                  dispositionParameters: { filename: f.name },
                  size: 1000,
                })),
              ],
            },
          };
      }
    },
    download: async (uid, part) => {
      asked.push(['download', client.mailbox.path, Number(uid), part]);
      const { Readable } = await import('node:stream');
      return { content: Readable.from([Buffer.from(`file ${part} of ${uid}`)]) };
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
  const rows = a
    .prepare(
      "SELECT m.id, m.from_me, m.ts, m.type, m.text, m.chat_ref, d.mimetype, d.file_name AS fileName, d.direct_path AS part FROM messages m LEFT JOIN media d ON d.msg_rowid = m.rowid WHERE m.chat_ref = 'mail:home' ORDER BY m.rowid",
    )
    .all();
  a.close();
  return rows;
};
const run = (db, client, extra = {}) => syncSent(db, client, 'home', 'me@example.org', { since, room: 150, imap, ...extra });

test("the first time, what was sent in the account's days is brought in, each attachment beside its mail", async () => {
  const db = openStore(ctx);
  const old = [
    {
      uid: 1,
      ts: now - 5 * DAY,
      subject: 'Re: claim documents',
      to: [{ address: 'Claims@Insurer.Example', name: 'Claims' }],
      body: 'Attached are the documents you asked for.',
      // (A mail program that calls every attachment "a file": its name says what it is.)
      files: [
        { name: 'ID card.pdf', type: 'application/octet-stream' },
        { name: 'Photo.JPG', type: 'application/octet-stream' },
      ],
    },
    { uid: 2, ts: now - 40 * DAY, subject: 'Too old', to: [{ address: 'a@example.org' }], body: 'Before the days this account keeps.' },
  ];
  const r = await run(db, server({ sent: old }));
  assert.deepEqual(r, { fresh: 1, stored: 1, more: 0 });
  assert.ok(Math.abs(stateOf(db, 'home').sent_since - now) <= 5, 'when it was first collected is still noted');
  assert.deepEqual(
    inArchive().map((m) => [m.id, m.from_me, m.type, m.mimetype, m.fileName, m.part]),
    [
      ['mail:home:s1', 1, 'text', null, null, null],
      ['mail:home:s1:1', 1, 'document', 'application/pdf', 'ID card.pdf', '2'],
      ['mail:home:s1:2', 1, 'image', 'image/jpeg', 'Photo.JPG', '3'],
    ],
  );
  assert.match(inArchive()[0].text, /\n\n\[attached: ID card\.pdf, Photo\.JPG\]$/);
  db.close();
});

test('an attachment of a sent mail is fetched from the Sent folder, and `mail show` lists them', async () => {
  const client = server({ sent: [] });
  const fs = await import('node:fs');
  const dest = path.join(dir, 'got.pdf');
  asked.length = 0;
  await imap.download(client, 1, '2', dest, { sent: true });
  assert.deepEqual(
    asked.find((a) => a[0] === 'download'),
    ['download', '[Mail]/Sent', 1, '2'],
  );
  assert.equal(fs.readFileSync(dest, 'utf8'), 'file 2 of 1');
  await imap.download(client, 7, '2', dest);
  assert.deepEqual(asked.filter((a) => a[0] === 'download').at(-1), ['download', 'INBOX', 7, '2'], 'one that arrived, from the Inbox');
  const shown = await findLoaded('mail').manifest.commands.show.run(ctx, { id: 'mail:home:s1' });
  assert.deepEqual(
    shown.data.attachments.map((f) => [f.id, f.name, f.type]),
    [
      ['mail:home:s1:1', 'ID card.pdf', 'application/pdf'],
      ['mail:home:s1:2', 'Photo.JPG', 'image/jpeg'],
    ],
  );
  assert.match(shown.text, /^From: you, to Claims <claims@insurer\.example>\n/);
  assert.match(shown.text, /ID card\.pdf: bc msg media mail:home:s1:1/);
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
  const m = inArchive().find((x) => x.id === 'mail:home:s3');
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
  assert.equal(inArchive().length, 4, 'the three from before, and this one');
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
      .filter((id) => /:s[3-6]$/.test(id))
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

test('removing the account takes its sent mail too', async () => {
  const db = openStore(ctx);
  assert.ok(inArchive().length > 0);
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
  assert.equal(db.prepare("SELECT step FROM shapes WHERE part = 'mail'").pluck().get(), 4);
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

test('a store whose sent mail was kept without attachments goes through it again; what arrived is untouched', async () => {
  const fs = await import('node:fs');
  const at3 = path.join(dir, 'at3');
  fs.mkdirSync(at3);
  const first = openStore({ dataDir: at3 });
  first.exec(`INSERT INTO mail (account, uid, ts, subject, kept, stored) VALUES ('home', 41, 1700000000, 'kept before', 1, 1);
    INSERT INTO sent (account, uid, ts, subject, stored) VALUES ('home', 9, 1700000000, 'sent before', 1);
    UPDATE shapes SET step = 3 WHERE part = 'mail';`);
  first.exec('ALTER TABLE sent DROP COLUMN files');
  first.close();
  const db = openStore({ dataDir: at3 });
  assert.equal(db.prepare("SELECT step FROM shapes WHERE part = 'mail'").pluck().get(), 4);
  assert.equal(db.prepare('SELECT COUNT(*) FROM sent').pluck().get(), 0, 'its header lines go, to be fetched again with their files');
  assert.deepEqual(db.prepare('SELECT uid, subject, stored FROM mail').all(), [{ uid: 41, subject: 'kept before', stored: 1 }]);
  db.prepare("INSERT INTO sent (account, uid, ts, files) VALUES ('home', 9, 1700000000, '[]')").run();
  db.close();
});
