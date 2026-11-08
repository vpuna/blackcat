// One way to change a database's shape: an ordered list of steps for each part, each run
// once and noted, in a transaction; and a database from before steps were noted is taken
// from where it is.
import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { home } from './helpers.js';

const dir = home();
const { hasColumn, hasTable, openSqlite, stepOf, upgrade, withDb } = await import('../src/db.js');
const file = (name) => path.join(dir, 'data', name);

test('steps run once, in order, each with its note; a new one at the end is all that runs next time', () => {
  const ran = [];
  const steps = [
    (db) => (ran.push(1), db.exec('CREATE TABLE things (id INTEGER PRIMARY KEY, name TEXT)')),
    (db) => (ran.push(2), db.exec('ALTER TABLE things ADD COLUMN colour TEXT')),
  ];
  let db = openSqlite(file('a.db'));
  assert.equal(stepOf(db, 'things'), 0);
  assert.equal(upgrade(db, 'things', steps), 2);
  assert.deepEqual(ran, [1, 2]);
  assert.equal(stepOf(db, 'things'), 2);
  assert.equal(upgrade(db, 'things', steps), 0, 'nothing to do: nothing is run');
  db.close();
  // later, with one more step
  steps.push((d) => (ran.push(3), d.exec('ALTER TABLE things ADD COLUMN size INTEGER')));
  db = openSqlite(file('a.db'));
  assert.equal(upgrade(db, 'things', steps), 1);
  assert.deepEqual(ran, [1, 2, 3]);
  assert.ok(hasColumn(db, 'things', 'size') && hasColumn(db, 'things', 'colour') && !hasColumn(db, 'things', 'weight'));
  // another part in the same file keeps its own count
  assert.equal(upgrade(db, 'other', [(d) => d.exec('CREATE TABLE other (x)')]), 1);
  assert.deepEqual([stepOf(db, 'things'), stepOf(db, 'other')], [3, 1]);
  assert.ok(hasTable(db, 'other') && !hasTable(db, 'nothing'));
  db.close();
  assert.equal(fs.statSync(file('a.db')).mode & 0o777, 0o600, 'the file is private to this account');
});

test('a step that fails leaves nothing of itself, and is tried again next time', () => {
  const db = openSqlite(file('b.db'));
  let fail = true;
  const steps = [
    (d) => d.exec('CREATE TABLE t (x)'),
    (d) => {
      d.exec('ALTER TABLE t ADD COLUMN y');
      if (fail) throw new Error('halfway');
    },
  ];
  assert.throws(() => upgrade(db, 't', steps), /halfway/);
  assert.equal(stepOf(db, 't'), 1, 'the first step stands');
  assert.ok(!hasColumn(db, 't', 'y'), 'what the second had done is undone');
  fail = false;
  assert.equal(upgrade(db, 't', steps), 1);
  assert.ok(hasColumn(db, 't', 'y'));
  db.close();
});

test('a first step that stands for several earlier ones: a new database starts at its number, and later steps count on from there', () => {
  const db = openSqlite(path.join(dir, 'folded.db'));
  const ran = [];
  const steps = [(d) => (ran.push('all of it'), d.exec('CREATE TABLE things (a, b)'))];
  assert.equal(upgrade(db, 'things', steps, { base: 3, owns: ['things'] }), 1);
  assert.equal(stepOf(db, 'things'), 3);
  assert.equal(upgrade(db, 'things', steps, { base: 3, owns: ['things'] }), 0);
  steps.push((d) => (ran.push('four'), d.exec('ALTER TABLE things ADD COLUMN c')));
  assert.equal(upgrade(db, 'things', steps, { base: 3, owns: ['things'] }), 1);
  assert.deepEqual([stepOf(db, 'things'), ran], [4, ['all of it', 'four']]);
  db.close();
});

test('data from part-way through those earlier steps, or from before steps were noted, is refused and left exactly as it was', () => {
  const db = openSqlite(path.join(dir, 'older.db'));
  // noted at step 1 of what is now folded into 3
  db.exec(
    "CREATE TABLE shapes (part TEXT PRIMARY KEY, step INTEGER NOT NULL); INSERT INTO shapes VALUES ('things', 1); CREATE TABLE things (a); INSERT INTO things VALUES ('kept')",
  );
  let ran = 0;
  const steps = [() => ran++, () => ran++];
  assert.throws(
    () => upgrade(db, 'things', steps, { base: 3, owns: ['things'] }),
    /written by an earlier blackcat than this one can read \(things: at step 1, and this version starts from 3\)/,
  );
  // its table is there and nothing was ever noted
  db.exec("CREATE TABLE notes (x); INSERT INTO notes VALUES ('old')");
  assert.throws(() => upgrade(db, 'notes', steps, { base: 2, owns: ['notes'] }), /notes: at step 0, and this version starts from 2/);
  assert.equal(ran, 0, 'no step was run');
  // and a command that meets such data says so in a sentence
  const old = path.join(dir, 'old-home');
  fs.mkdirSync(path.join(old, 'data'), { recursive: true, mode: 0o700 });
  const o = openSqlite(path.join(old, 'data/agent.db'));
  o.exec(
    "CREATE TABLE shapes (part TEXT PRIMARY KEY, step INTEGER NOT NULL); INSERT INTO shapes VALUES ('core', 1); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)",
  );
  o.close();
  const { FORCE_COLOR: _f, ...env } = process.env;
  const r = spawnSync(process.execPath, [new URL('../bin/bc.js', import.meta.url).pathname, 'remind', 'list'], {
    encoding: 'utf8',
    env: { ...env, BLACKCAT_HOME: old },
  });
  assert.equal(r.status, 1);
  assert.match(
    r.stderr,
    /^This data was written by an earlier blackcat than this one can read \(core: at step 1, and this version starts from 2\)\. Open it once with the version it was written by, or restore a backup made by a newer one\.\n$/,
  );
  assert.deepEqual([stepOf(db, 'things'), stepOf(db, 'notes')], [1, 0], 'and nothing new was noted');
  assert.deepEqual(db.prepare('SELECT a FROM things').pluck().all(), ['kept']);
  assert.deepEqual(db.prepare('SELECT x FROM notes').pluck().all(), ['old']);
  db.close();
});

test('two processes opening at the same moment: each step is still run once', async () => {
  const script = path.join(dir, 'racer.mjs');
  fs.writeFileSync(
    script,
    `
    const { openSqlite, upgrade } = await import(${JSON.stringify(new URL('../src/db.js', import.meta.url).href)});
    const db = openSqlite(${JSON.stringify(file('race.db'))});
    upgrade(db, 'race', [
      (d) => d.exec('CREATE TABLE runs (n INTEGER)'),
      (d) => d.exec('INSERT INTO runs VALUES (1)'),
      (d) => d.exec('INSERT INTO runs VALUES (2)'),
    ]);
    db.close();
  `,
  );
  const codes = await Promise.all(Array.from({ length: 6 }, () => new Promise((r) => fork(script, [], { stdio: 'ignore' }).on('exit', r))));
  assert.deepEqual(codes, [0, 0, 0, 0, 0, 0]);
  const db = openSqlite(file('race.db'), { readonly: true });
  assert.deepEqual(db.prepare('SELECT n FROM runs ORDER BY n').pluck().all(), [1, 2]);
  db.close();
});

test('opened for looking only, nothing can be changed; and a database is closed whatever happens', async () => {
  const ro = openSqlite(file('a.db'), { readonly: true });
  assert.throws(() => ro.exec('DELETE FROM things'), /readonly/);
  ro.close();
  assert.throws(() => openSqlite(file('missing.db'), { readonly: true }));
  let seen;
  assert.equal(
    withDb(
      () => openSqlite(file('a.db')),
      (db) => ((seen = db), 7),
    ),
    7,
  );
  assert.equal(seen.open, false);
  assert.throws(
    () =>
      withDb(
        () => openSqlite(file('a.db')),
        (db) => {
          seen = db;
          throw new Error('boom');
        },
      ),
    /boom/,
  );
  assert.equal(seen.open, false, 'closed though it threw');
  assert.equal(
    await withDb(
      () => openSqlite(file('a.db')),
      async (db) => {
        seen = db;
        await new Promise((r) => setTimeout(r, 5));
        return db.open;
      },
    ),
    true,
    'open while the work goes on',
  );
  assert.equal(seen.open, false, 'and closed when it is done');
  await assert.rejects(
    withDb(
      () => openSqlite(file('a.db')),
      async (db) => {
        seen = db;
        throw new Error('later');
      },
    ),
    /later/,
  );
  assert.equal(seen.open, false);
});

// What part 10 changed, put back: a fresh archive made to look as one did before it.
const BEFORE_10 = `ALTER TABLE aliases RENAME COLUMN ref TO lid; ALTER TABLE aliases RENAME COLUMN same_as TO pn; ALTER TABLE aliases RENAME TO lid_map;
    ALTER TABLE media ADD COLUMN direct_path TEXT; ALTER TABLE media ADD COLUMN url TEXT; ALTER TABLE media ADD COLUMN media_key BLOB;
    ALTER TABLE media ADD COLUMN file_enc_sha256 BLOB; ALTER TABLE media DROP COLUMN fetch;`;
// An archive as the first published version left it: marked 6, without what step 7 adds.
const AT_6 = `${BEFORE_10} DROP TRIGGER messages_ai; DROP TRIGGER messages_ad; DROP TRIGGER messages_au; DROP TABLE messages_fts;
    CREATE VIRTUAL TABLE messages_fts USING fts5(text, link_title, link_desc, content='messages', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
    CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN INSERT INTO messages_fts (rowid, text, link_title, link_desc) VALUES (new.rowid, new.text, new.link_title, new.link_desc); END;
    CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN INSERT INTO messages_fts (messages_fts, rowid, text, link_title, link_desc) VALUES ('delete', old.rowid, old.text, old.link_title, old.link_desc); END;
    CREATE TRIGGER messages_au AFTER UPDATE OF text, link_url, link_title, link_desc ON messages BEGIN SELECT 1; END;
    ALTER TABLE messages DROP COLUMN heard;
    INSERT INTO chats (ref, name, is_group) VALUES ('1@s.whatsapp.net', 'Maya', 0);
    INSERT INTO messages (chat_ref, id, sender_ref, from_me, ts, type, text) VALUES ('1@s.whatsapp.net', 'OLD1', '1@s.whatsapp.net', 0, 1700000000, 'text', 'the old message about dinner');
    INSERT INTO messages (chat_ref, id, sender_ref, from_me, ts, type, text) VALUES ('mail:x', 'F1', 'mail:a@b', 0, 1700000001, 'document', 'scan.pdf');
    INSERT INTO media (msg_rowid, dl_type, mimetype, file_name) VALUES (last_insert_rowid(), 'mail', 'application/octet-stream', 'scan.pdf');
    INSERT INTO messages (chat_ref, id, sender_ref, from_me, ts, type, text) VALUES ('mail:x', 'F2', 'mail:a@b', 0, 1700000002, 'document', 'Photo.JPG');
    INSERT INTO media (msg_rowid, dl_type, mimetype, file_name) VALUES (last_insert_rowid(), 'mail', 'application/octet-stream', 'Photo.JPG');
    INSERT INTO messages (chat_ref, id, sender_ref, from_me, ts, type, text) VALUES ('mail:x', 'F3', 'mail:a@b', 0, 1700000003, 'document', 'sheet.xlsx');
    INSERT INTO media (msg_rowid, dl_type, mimetype, file_name) VALUES (last_insert_rowid(), 'mail', 'application/octet-stream', 'sheet.xlsx');
    PRAGMA user_version = 6;`;

test('an archive from an earlier blackcat is refused, not upgraded; a new one is made whole and marked', async () => {
  const { openWrite } = await import('../src/archive/db.js');
  const { ARCHIVE_DB } = await import('../src/archive/files.js');
  let a = openWrite();
  assert.equal(a.pragma('user_version', { simple: true }), 10);
  // and one from the first published version (marked 6) is given what has been added since, by whoever opens it
  a.exec(AT_6);
  a.close();
  const { openRead } = await import('../src/archive/db.js');
  const r = openRead();
  assert.equal(r.pragma('user_version', { simple: true }), 10, 'a reader brings it up to date before reading');
  assert.equal(
    r.prepare("SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH 'dinner'").get().n,
    1,
    'and what was there is still found',
  );
  assert.equal(r.prepare("SELECT heard FROM messages WHERE id = 'OLD1'").get().heard, null);
  assert.deepEqual(
    r.prepare("SELECT chat_ref, sender_ref, account FROM messages WHERE id = 'OLD1'").get(),
    { chat_ref: 'wa:1@s.whatsapp.net', sender_ref: 'wa:1@s.whatsapp.net', account: null },
    "WhatsApp's ids are marked as WhatsApp's; the account is the collector's to claim",
  );
  assert.equal(r.prepare('SELECT ref FROM chats').pluck().get(), 'wa:1@s.whatsapp.net');
  assert.deepEqual(
    r
      .prepare(
        "SELECT m.id, m.type, d.mimetype FROM messages m JOIN media d ON d.msg_rowid = m.rowid WHERE m.chat_ref = 'mail:x' ORDER BY m.id",
      )
      .all(),
    [
      { id: 'F1', type: 'document', mimetype: 'application/pdf' },
      { id: 'F2', type: 'image', mimetype: 'image/jpeg' },
      { id: 'F3', type: 'document', mimetype: 'application/octet-stream' },
    ],
    'a file that said only "a file" is the kind its name says (and one of no kind that is read stays as it was)',
  );
  r.close();
  a = openWrite();
  assert.ok(hasTable(a, 'messages') && hasTable(a, 'chat_info') && hasColumn(a, 'messages', 'link_url'));
  a.close();
  openWrite().close(); // again: nothing to do
  for (const [name, sql] of [
    ['marked lower', 'PRAGMA user_version = 3'],
    ['with messages and no mark', 'PRAGMA user_version = 0'],
  ]) {
    const db = openSqlite(ARCHIVE_DB);
    db.exec(sql);
    db.close();
    assert.throws(
      () => openWrite(),
      /written by an earlier blackcat than this one can read \(archive: at step [03], and this version starts from 6\)/,
      name,
    );
  }
  const db = openSqlite(ARCHIVE_DB);
  assert.ok(hasTable(db, 'messages'), 'and it is left as it was');
  db.close();
});

test('an archive from the first published version, opened by several processes at the same moment, is brought up to date once', async () => {
  const { ARCHIVE_DB } = await import('../src/archive/files.js');
  for (const f of [ARCHIVE_DB, `${ARCHIVE_DB}-wal`, `${ARCHIVE_DB}-shm`]) fs.rmSync(f, { force: true });
  const { openWrite } = await import('../src/archive/db.js');
  const a = openWrite();
  a.exec(AT_6);
  a.close();
  // (The agent and a job, started together after an update: each opens the archive to write.)
  const script = path.join(dir, 'archive-racer.mjs');
  fs.writeFileSync(
    script,
    `const { openWrite } = await import(${JSON.stringify(new URL('../src/archive/db.js', import.meta.url).href)});
    openWrite().close();`,
  );
  const codes = await Promise.all(
    Array.from({ length: 12 }, () => new Promise((r) => fork(script, [], { stdio: 'ignore', env: process.env }).on('exit', r))),
  );
  assert.deepEqual(codes, Array(12).fill(0), 'none of them failed');
  const db = openSqlite(ARCHIVE_DB, { readonly: true });
  assert.equal(db.pragma('user_version', { simple: true }), 10);
  assert.ok(hasColumn(db, 'messages', 'heard') && hasColumn(db, 'messages', 'account'));
  assert.equal(
    db.prepare("SELECT chat_ref FROM messages WHERE id = 'OLD1'").pluck().get(),
    'wa:1@s.whatsapp.net',
    'marked once, not twice',
  );
  db.close();
});

test("part 10: the archive's words are no source's own: other ids are aliases, and what fetches a file is the source's, every value kept", async () => {
  const { ARCHIVE_DB } = await import('../src/archive/files.js');
  for (const f of [ARCHIVE_DB, `${ARCHIVE_DB}-wal`, `${ARCHIVE_DB}-shm`]) fs.rmSync(f, { force: true });
  const { openWrite, openRead, SENDER_LABEL } = await import('../src/archive/db.js');
  const a = openWrite();
  a.exec(BEFORE_10);
  const key = Buffer.from('00ff10ab'.repeat(8), 'hex');
  const enc = Buffer.from('c0ffee', 'hex');
  const sha = Buffer.from('abcd', 'hex');
  const msg = a.prepare("INSERT INTO messages (chat_ref, id, sender_ref, from_me, ts, type, text) VALUES (?, ?, ?, 0, 1700000000, ?, 'x')");
  const media = a.prepare(
    'INSERT INTO media (msg_rowid, dl_type, mimetype, file_name, direct_path, url, media_key, file_sha256, file_enc_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const wa = msg.run('wa:1@s.whatsapp.net', 'WA1', 'wa:99@lid', 'image').lastInsertRowid;
  media.run(wa, 'image', 'image/jpeg', null, '/v/t62/x', 'https://mmg.example/x', key, sha, enc);
  const old = msg.run('wa:1@s.whatsapp.net', 'WA2', null, 'image').lastInsertRowid;
  media.run(old, 'image', 'image/jpeg', null, null, null, null, sha, null);
  const mail = msg.run('mail:home', 'mail:home:7:1', 'mail:a@b.example', 'document').lastInsertRowid;
  media.run(mail, 'mail', 'application/pdf', 'letter.pdf', '2', null, null, null, null);
  const tg = msg.run('tg:5', 'tg5_9', 'tg:5', 'image').lastInsertRowid;
  media.run(tg, 'tg', 'image/jpeg', null, null, null, null, null, null);
  a.prepare("INSERT INTO lid_map (lid, pn) VALUES ('wa:99@lid', 'wa:15550001234@s.whatsapp.net')").run();
  a.pragma('user_version = 9');
  a.close();

  const r = openRead();
  assert.equal(r.pragma('user_version', { simple: true }), 10);
  assert.ok(!hasTable(r, 'lid_map'));
  assert.deepEqual(r.prepare('SELECT ref, same_as FROM aliases').all(), [{ ref: 'wa:99@lid', same_as: 'wa:15550001234@s.whatsapp.net' }]);
  for (const c of ['direct_path', 'url', 'media_key', 'file_enc_sha256']) assert.ok(!hasColumn(r, 'media', c), `${c} is gone`);
  const fetch = (rowid) => JSON.parse(r.prepare('SELECT fetch FROM media WHERE msg_rowid = ?').pluck().get(rowid) ?? 'null');
  assert.deepEqual(fetch(wa), {
    directPath: '/v/t62/x',
    url: 'https://mmg.example/x',
    mediaKey: key.toString('hex').toUpperCase(),
    encSha256: 'C0FFEE',
  });
  assert.ok(Buffer.from(fetch(wa).mediaKey, 'hex').equals(key), 'the key is the same bytes');
  assert.equal(fetch(old), null, 'one with nothing to fetch it by still has nothing');
  assert.deepEqual(fetch(mail), { directPath: '2', url: null, mediaKey: null, encSha256: null });
  assert.deepEqual(fetch(tg), {}, 'a Telegram file is fetched by its message');
  assert.ok(
    r.prepare('SELECT file_sha256 FROM media WHERE msg_rowid = ?').pluck().get(wa).equals(sha),
    "the file's own hash stays where it was",
  );
  assert.equal(
    r.prepare(`SELECT ${SENDER_LABEL} FROM messages m WHERE m.id = 'WA1'`).pluck().get(),
    '+15550001234',
    'a hidden id is still shown as the number it is an alias of',
  );
  r.close();
});
