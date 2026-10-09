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

test('an archive from an earlier blackcat is refused, not upgraded; a new one is made whole and marked', async () => {
  const { openWrite } = await import('../src/archive/db.js');
  const { ARCHIVE_DB } = await import('../src/archive/files.js');
  const a = openWrite();
  assert.equal(a.pragma('user_version', { simple: true }), 6);
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
