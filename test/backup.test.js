// What a backup holds. It must carry everything that can't be recreated, wherever a plugin
// keeps it, and nothing in it may be readable by other accounts.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { home, setUp } from './helpers.js';

const dir = home();
// (The user's home folder too is the scratch one: nothing here can reach the real one.)
process.env.HOME = dir;
const data = path.join(dir, 'data');
await setUp({ bot: { token: 'T' }, plugins: { enabled: ['backup'], settings: { backup: { host: 'nas', dir: '/b' } } } });
const put = (rel, text = 'x') => {
  fs.mkdirSync(path.dirname(path.join(data, rel)), { recursive: true });
  fs.writeFileSync(path.join(data, rel), text);
};
for (const f of [
  'wa-auth/creds.json',
  'tg-account/session',
  'readers/watch/list.md',
  'inbox/a.pdf',
  'archive-media/2026-10/pic.jpg',
  'plugins/mail/secrets.json',
  'plugins/ssh/keys/nas',
  'plugins/someone-elses/anything/deep.bin',
  'models/big.onnx',
  'archive-index.db',
  'unifi-media/snap.jpg',
])
  put(f);
for (const f of ['archive.db', 'agent.db', 'plugins/mail/mail.db']) {
  const db = new Database(path.join(data, f));
  db.pragma('journal_mode = WAL');
  db.exec("CREATE TABLE t (x); INSERT INTO t VALUES ('kept')");
  if (f === 'agent.db')
    db.exec(
      "CREATE TABLE watch_items (file TEXT); CREATE TABLE reminders (file TEXT); CREATE TABLE memories (name TEXT PRIMARY KEY, kind TEXT, summary TEXT, body TEXT, created_ts INTEGER, updated_ts INTEGER, saved_by TEXT); INSERT INTO memories VALUES ('likes-tea', 'user', 'tea', 'The owner likes tea.', 1, 1, 'agent')",
    );
  db.close();
}

test('a backup carries everything that cannot be recreated, and keeps it private', async () => {
  const { makeArchive } = await import('../src/backup/manifest.js');
  const { loadPlugins, makeCtx } = await import('../src/plugins/registry.js');
  const p = (await loadPlugins()).find((x) => x.name === 'backup');
  const file = await makeArchive(makeCtx(p));
  assert.equal(fs.statSync(file).mode & 0o077, 0, 'the archive itself is private');
  const out = path.join(dir, 'unpacked');
  fs.mkdirSync(out);
  assert.equal(spawnSync('tar', ['--zstd', '-xpf', file, '-C', out]).status, 0);
  const root = path.join(out, 'blackcat');
  const has = (rel) => fs.existsSync(path.join(root, 'data', rel));
  for (const f of [
    'config.json',
    'wa-auth/creds.json',
    'tg-account/session',
    'readers/watch/list.md',
    'inbox/a.pdf',
    'archive-media/2026-10/pic.jpg',
    'plugins/mail/secrets.json',
    'plugins/ssh/keys/nas',
    'plugins/someone-elses/anything/deep.bin',
    'archive.db',
    'agent.db',
    'plugins/mail/mail.db',
  ])
    assert.ok(has(f), `${f} is in the backup`);
  // left out on purpose: downloaded or rebuilt
  for (const f of ['models/big.onnx', 'archive-index.db', 'unifi-media/snap.jpg']) assert.ok(!has(f), `${f} is left out`);
  // databases arrive whole, with what was still in their write-ahead log
  for (const f of ['archive.db', 'agent.db', 'plugins/mail/mail.db']) {
    const db = new Database(path.join(root, 'data', f), { readonly: true });
    assert.equal(db.prepare('SELECT x FROM t').pluck().get(), 'kept');
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    db.close();
    assert.equal(fs.statSync(path.join(root, 'data', f)).mode & 0o077, 0, `${f} is private`);
  }
  assert.equal(fs.statSync(path.join(root, 'data')).mode & 0o077, 0);
  assert.ok(fs.existsSync(path.join(root, 'manifest.json')));
});

test('a backup file that is already here can be restored with no backup setup, onto a different folder', async () => {
  const { makeArchive } = await import('../src/backup/manifest.js');
  const { loadPlugins, makeCtx } = await import('../src/plugins/registry.js');
  const p = (await loadPlugins()).find((x) => x.name === 'backup');
  const db = new Database(path.join(data, 'agent.db'));
  db.prepare('INSERT INTO watch_items VALUES (?)').run(path.join(data, 'inbox/a.pdf'));
  db.close();
  const made = await makeArchive(makeCtx(p));
  const file = path.join(dir, path.basename(made));
  fs.renameSync(made, file);

  // a second, empty installation: never set up, only the backup plugin switched on
  const other = fs.mkdtempSync(path.join(dir, 'other-'));
  fs.mkdirSync(path.join(other, 'data'), { mode: 0o700 });
  fs.writeFileSync(path.join(other, 'data/config.json'), JSON.stringify({ plugins: { enabled: ['backup'] } }));
  const root = new URL('..', import.meta.url).pathname;
  const bc = (...args) =>
    spawnSync(process.execPath, [`${root}bin/bc.js`, ...args], {
      encoding: 'utf8',
      env: { ...process.env, BLACKCAT_HOME: other },
      timeout: 60_000,
    });

  assert.notEqual(bc('backup', 'restore', '--apply', '--yes').status, 0, 'with no file and no setup there is nothing to restore from');
  assert.notEqual(bc('backup', 'restore', '--file', path.join(dir, 'nothing.tar.zst'), '--apply', '--yes').status, 0);
  // a backup that does not say what made it (no manifest) is from an earlier blackcat: it is not put in place
  const bare = path.join(dir, 'bare');
  fs.mkdirSync(bare);
  spawnSync('tar', ['--zstd', '-xf', file, '-C', bare]);
  fs.rmSync(path.join(bare, 'blackcat/manifest.json'));
  const older = path.join(dir, 'blackcat-elsewhere-20200101-000000.tar.zst');
  spawnSync('tar', ['--zstd', '-cf', older, '-C', bare, 'blackcat']);
  const before = fs.readFileSync(path.join(other, 'data/config.json'), 'utf8');
  const no = bc('backup', 'restore', '--file', older, '--apply', '--yes');
  assert.notEqual(no.status, 0);
  assert.match(no.stdout + no.stderr, /made by an earlier blackcat than this one can restore\. Nothing was changed/);
  assert.equal(fs.readFileSync(path.join(other, 'data/config.json'), 'utf8'), before, 'and nothing was');
  assert.equal(fs.readdirSync(other).filter((n) => n.includes('before-restore')).length, 0);
  // (it is left unpacked for a look, as the message says; cleared here)
  for (const n of fs.readdirSync(other).filter((x) => x.startsWith('restore-tmp'))) fs.rmSync(path.join(other, n), { recursive: true });
  const r = bc('backup', 'restore', '--file', file, '--apply', '--yes');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.doesNotMatch(r.stdout, /time zone/, 'same time zone: nothing to say');
  assert.match(r.stdout, /Restored the backup/);
  assert.ok(fs.existsSync(file), 'the backup file itself is left where it was');
  for (const f of ['config.json', 'archive.db', 'plugins/mail/secrets.json', 'wa-auth/creds.json', 'inbox/a.pdf'])
    assert.ok(fs.existsSync(path.join(other, 'data', f)), f);
  // settings and secrets both came across (the bot's token is one of its plugin's secrets)
  const restored = JSON.parse(fs.readFileSync(path.join(other, 'data/config.json')));
  assert.equal(restored.plugins.settings.backup.host, 'nas');
  assert.equal(JSON.parse(fs.readFileSync(path.join(other, 'data/plugins/tg-bot/secrets.json'))).token, 'T');
  // a path stored in the database now points into the new installation
  const moved = new Database(path.join(other, 'data/agent.db'), { readonly: true });
  assert.equal(moved.prepare('SELECT file FROM watch_items').pluck().get(), path.join(other, 'data/inbox/a.pdf'));
  moved.close();
  // what the agent remembers is in agent.db, so it came with it
  const mem = new Database(path.join(other, 'data/agent.db'), { readonly: true });
  assert.deepEqual(mem.prepare('SELECT name, body FROM memories').all(), [{ name: 'likes-tea', body: 'The owner likes tea.' }]);
  mem.close();
  assert.equal(fs.readdirSync(other).filter((n) => n.startsWith('restore-tmp')).length, 0, 'nothing is left lying around');

  // In a container the data folder is a place of its own and nothing may be written beside
  // it: the backup is unpacked inside it, and what it replaces is kept inside it too. And
  // --paused leaves every service switched off, so that a copy tried beside the original
  // logs in to nothing and runs nothing by itself.
  const vol = fs.mkdtempSync(path.join(dir, 'vol-'));
  fs.mkdirSync(path.join(vol, 'data'), { mode: 0o700 });
  fs.writeFileSync(path.join(vol, 'data/config.json'), JSON.stringify({ plugins: { enabled: ['backup'] }, was: 'here before' }));
  fs.chmodSync(vol, 0o555);
  try {
    const v = spawnSync(process.execPath, [`${root}bin/bc.js`, 'backup', 'restore', '--file', file, '--apply', '--yes', '--paused'], {
      encoding: 'utf8',
      env: { ...process.env, BLACKCAT_HOME: vol },
      timeout: 60_000,
    });
    assert.equal(v.status, 0, v.stderr + v.stdout);
    assert.match(v.stdout, /Everything is switched off \(agent, .*tg.*wa.*\): nothing logs in, sends or runs by itself/);
    const inside = fs.readdirSync(path.join(vol, 'data'));
    const kept = inside.find((n) => n.startsWith('before-restore-'));
    assert.ok(kept, inside.join(' '));
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(vol, 'data', kept, 'config.json'))).was,
      'here before',
      'what was there is kept, inside the folder',
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(vol, 'data/config.json'))).plugins.settings.backup.host,
      'nas',
      'and the backup is in its place',
    );
    assert.ok(fs.existsSync(path.join(vol, 'data/archive.db')));
    assert.equal(inside.filter((n) => n.startsWith('restore-tmp')).length, 0);
    const off = JSON.parse(fs.readFileSync(path.join(vol, 'data/services-off.json')));
    for (const id of ['agent', 'tg', 'wa']) assert.ok(off.includes(id), `${id} is switched off`);
    assert.match(v.stdout, new RegExp(`When you are happy, delete ${path.join(vol, 'data', kept).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  } finally {
    fs.chmodSync(vol, 0o755);
  }
});

test('restoring on a machine set to another time zone says so', async () => {
  const { makeArchive } = await import('../src/backup/manifest.js');
  const { loadPlugins, makeCtx } = await import('../src/plugins/registry.js');
  const p = (await loadPlugins()).find((x) => x.name === 'backup');
  const made = await makeArchive(makeCtx(p));
  const other = fs.mkdtempSync(path.join(dir, 'zone-'));
  fs.mkdirSync(path.join(other, 'data'), { mode: 0o700 });
  fs.writeFileSync(path.join(other, 'data/config.json'), JSON.stringify({ plugins: { enabled: ['backup'] } }));
  const root = new URL('..', import.meta.url).pathname;
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const there = here === 'Pacific/Auckland' ? 'America/Lima' : 'Pacific/Auckland';
  const r = spawnSync(process.execPath, [`${root}bin/bc.js`, 'backup', 'restore', '--file', made, '--apply', '--yes'], {
    encoding: 'utf8',
    env: { ...process.env, BLACKCAT_HOME: other, TZ: there },
    timeout: 60_000,
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, new RegExp(`time zone is ${there}; the backup was made in ${here}`));
  assert.match(r.stdout, new RegExp(`timedatectl set-timezone ${here}`));
});
