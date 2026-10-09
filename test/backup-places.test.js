// A backup makes a file; where the file is kept is a place: a folder on this machine, or
// whatever a plugin offers. The SSH plugin offers its machines. This runs the real thing
// end to end, with a stand-in for the `ssh` program that runs the command on this machine.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { home } from './helpers.js';

const dir = home();
process.env.HOME = dir;
const data = path.join(dir, 'data');
const root = new URL('..', import.meta.url).pathname;
// `ssh … -- '<command>'` runs the command here; anything else (asking after a shared connection) does nothing.
fs.writeFileSync(
  path.join(dir, 'fake-bin/ssh'),
  '#!/bin/sh\nwhile [ $# -gt 0 ] && [ "$1" != "--" ]; do shift; done\n[ $# -gt 1 ] || exit 0\nshift\nexec sh -c "$1"\n',
  { mode: 0o755 },
);
const far = path.join(dir, 'far-machine/backups');
const usb = path.join(dir, 'usb disk/blackcat');
fs.mkdirSync(path.dirname(far), { recursive: true });
fs.mkdirSync(path.dirname(usb), { recursive: true });
const { save, load } = await import('../src/config.js');
save({
  plugins: { enabled: ['ssh'], settings: { ssh: { hosts: { nas: { host: '10.0.0.5', user: 'me', mode: 'look' } }, keepOpenMinutes: 0 } } },
});
const db = new Database(path.join(data, 'archive.db'));
db.exec("CREATE TABLE t (x); INSERT INTO t VALUES ('kept')");
db.close();
const { FORCE_COLOR: _f, BLACKCAT_CALLER: _c, ...env } = process.env;
const bc = (...a) => spawnSync(process.execPath, [`${root}bin/bc.js`, ...a], { encoding: 'utf8', env, timeout: 120_000 });
const json = (...a) => JSON.parse(bc(...a, '--json').stdout);
const NAME = /^blackcat-.+-\d{8}-\d{6}\.tar\.zst$/;
const backupsIn = (d) =>
  fs
    .readdirSync(d)
    .filter((n) => NAME.test(n))
    .sort();

test('the places there are: this machine, and every machine the SSH plugin reaches', async () => {
  const { loadPlugins } = await import('../src/plugins/registry.js');
  await loadPlugins();
  const { places, placeOf, StorageError } = await import('../src/storage.js');
  assert.deepEqual(places(), [
    { id: 'here', label: 'this machine (a folder, a USB disk, a mounted share)' },
    { id: 'ssh:nas', label: 'nas (me@10.0.0.5)' },
  ]);
  await assert.rejects(placeOf('ssh:elsewhere').list('/'), /No host called "elsewhere"/);
  assert.throws(() => placeOf('cloud:x'), StorageError);
  assert.throws(() => placeOf(undefined), /No place has been chosen/);
  await assert.rejects(placeOf('here').list('relative/path'), /not a full path/);
});

for (const [id, where] of [
  ['here', usb],
  ['ssh:nas', far],
]) {
  test(`a place (${id}): folders are made and listed, a file put arrives whole and private, is fetched back the same, and is removed`, async () => {
    const { placeOf } = await import('../src/storage.js');
    const place = placeOf(id);
    const top = path.dirname(where);
    await place.mkdir(path.join(top, 'made here/deeper'));
    fs.writeFileSync(path.join(top, 'a file with spaces.txt'), 'x'.repeat(1234));
    fs.writeFileSync(path.join(top, '.hidden'), 'x');
    const seen = (await place.list(top)).filter((e) => !e.name.startsWith('.'));
    assert.deepEqual(
      seen.sort((a, b) => a.name.localeCompare(b.name)),
      [
        { name: 'a file with spaces.txt', folder: false, bytes: 1234 },
        { name: 'made here', folder: true, bytes: seen.find((e) => e.folder).bytes },
      ],
    );
    const local = path.join(dir, 'to-send.bin');
    fs.writeFileSync(local, Buffer.from(Array.from({ length: 70_000 }, (_, i) => i % 251)));
    await place.put(local, path.join(top, 'made here/sent.bin'));
    assert.equal(fs.statSync(path.join(top, 'made here/sent.bin')).mode & 0o077, 0, 'only its own account may read it');
    assert.deepEqual(fs.readdirSync(path.join(top, 'made here')).sort(), ['deeper', 'sent.bin'], 'no half file left');
    const back = path.join(dir, `back-${id.replace(':', '-')}.bin`);
    await place.get(path.join(top, 'made here/sent.bin'), back);
    assert.ok(fs.readFileSync(back).equals(fs.readFileSync(local)));
    await place.remove([path.join(top, 'made here/sent.bin'), path.join(top, 'a file with spaces.txt'), path.join(top, 'never was')]);
    assert.deepEqual(fs.readdirSync(path.join(top, 'made here')), ['deeper']);
    assert.match(String(await place.free(top)), /^\d+(\.\d+)?[KMGT]/);
    await assert.rejects(place.list(path.join(top, 'no such folder')), /./);
    await assert.rejects(place.get(path.join(top, 'no such file'), path.join(dir, 'nothing')), /./);
    fs.rmSync(path.join(top, 'made here'), { recursive: true });
    fs.rmSync(path.join(top, '.hidden'));
  });
}

test('set up to keep backups on another machine: made, sent whole, listed, and only the newest kept', () => {
  const r = bc('backup', 'setup', '--place', 'ssh:nas', '--dir', far, '--time', '03:30', '--keep', '2', '--no-encrypt');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(
    r.stdout,
    new RegExp(
      `Backups will go to nas:${far.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} every day at 03:30, keeping the last 2, NOT encrypted`,
    ),
  );
  assert.match(r.stdout, /Free space there: \S+/);
  assert.deepEqual(fs.readdirSync(far), [], 'the folder was made, and the trial file is gone');
  assert.deepEqual(
    [load().plugins.settings.backup.place, load().plugins.settings.backup.dir, 'host' in load().plugins.settings.backup],
    ['ssh:nas', far, false],
  );

  // one from another machine sits in the same folder, and is never pruned by this one
  fs.writeFileSync(path.join(far, 'blackcat-othermachine-20200101-000000.tar.zst'), 'theirs');
  fs.writeFileSync(path.join(far, 'notes.txt'), 'not a backup');
  const made = [];
  for (let n = 0; n < 3; n++) {
    const now = json('backup', 'now');
    assert.match(now.name, NAME);
    assert.equal(fs.statSync(path.join(far, now.name)).size, now.bytes);
    assert.equal(fs.statSync(path.join(far, now.name)).mode & 0o077, 0);
    made.push(now);
    if (n < 2) spawnSync('sleep', ['1.1']); // (a backup's name is to the second)
  }
  assert.deepEqual([made[0].removed, made[1].removed, made[2].removed], [0, 0, 1]);
  assert.deepEqual(backupsIn(far), ['blackcat-othermachine-20200101-000000.tar.zst', made[1].name, made[2].name].sort());
  assert.ok(fs.existsSync(path.join(far, 'notes.txt')), 'what is not a backup is left alone');
  const list = json('backup', 'list');
  assert.deepEqual(
    [list.place, list.dir, list.backups.map((b) => [b.name, b.mine])],
    [
      'ssh:nas',
      far,
      [
        [made[2].name, true],
        [made[1].name, true],
        ['blackcat-othermachine-20200101-000000.tar.zst', false],
      ],
    ],
  );
  assert.equal(fs.existsSync(path.join(data, 'backup-tmp')), false, 'nothing is left on this machine');
  assert.match(bc('backup', 'status').stdout, /last backup .* · next at 03:30/);
  assert.equal(load().plugins.settings.backup.last, undefined, 'what came of the last one is not among the settings');
});

test('a backup kept there is fetched and unpacked for a restore', () => {
  const to = path.join(dir, 'unpacked');
  const r = bc('backup', 'restore', '--to', to);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const got = new Database(path.join(to, 'blackcat/data/archive.db'), { readonly: true });
  assert.equal(got.prepare('SELECT x FROM t').pluck().get(), 'kept');
  got.close();
});

test('a folder on this machine is a place too, with no plugin at all', () => {
  save({ plugins: { disabled: ['ssh'], settings: load().plugins.settings } });
  assert.match(bc('backup', 'now').stderr, /"ssh:nas" is not a place files can be kept just now \(is the ssh plugin switched on\?\)/);
  assert.match(bc('backup', 'status').stdout, /THE LAST ONE FAILED/);
  const r = bc('backup', 'setup', '--place', 'here', '--dir', usb, '--time', '04:00', '--keep', '5', '--no-encrypt');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /Backups will go to .*usb disk\/blackcat every day at 04:00/);
  const now = json('backup', 'now');
  assert.deepEqual(backupsIn(usb), [now.name]);
  assert.doesNotMatch(bc('backup', 'status').stdout, /FAILED/);
  assert.match(
    bc('backup', 'setup', '--place', 'cloud:x', '--dir', '/x', '--time', '04:00', '--keep', '5', '--no-encrypt').stderr,
    /place: Choose one of: here/,
  );
});

test('an installation set up before there were places keeps going where it went: host nas is the place ssh:nas', () => {
  save({
    plugins: {
      enabled: ['ssh'],
      settings: {
        ...load().plugins.settings,
        backup: {
          host: 'nas',
          dir: far,
          time: '03:30',
          keep: 14,
          encrypt: false,
          last: { at: 1700000000, name: 'blackcat-x-20231114-000000.tar.zst', bytes: 5 },
          lastError: null,
        },
      },
    },
  });
  assert.deepEqual(json('backup', 'settings').settings, {
    'kept on': `nas:${far}`,
    'every day at': '03:30',
    keep: 'the last 14',
    encrypted: 'no',
  });
  assert.match(bc('backup', 'status').stdout, /last backup .*\(5 B\)|last backup/);
  const s = load().plugins.settings.backup;
  assert.deepEqual(
    ['last' in s, 'lastError' in s, s.host],
    [false, false, 'nas'],
    'what came of the last one moved out of the settings; where it goes is untouched',
  );
  const now = json('backup', 'now');
  assert.ok(fs.existsSync(path.join(far, now.name)));
});
