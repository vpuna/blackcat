// The rules that make blackcat a framework rather than one program:
//   1. the core runs without any plugin: nothing in src/ or bin/ imports from plugins/
//   2. a plugin stands alone: it imports nothing from another plugin
//   3. a plugin uses the core only through src/api.js, the one thing promised to stay put
//   4. only a channel talks to a chat service: nothing but a channel plugin uses a service's
//      own library, and what the owner is shown is said through the neutral `ui`
// A change that breaks one of these fails here, with the file and the import named.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { home as scratchHome } from './helpers.js';

scratchHome(); // nothing here may look at the real installation

const root = new URL('..', import.meta.url).pathname;
const SPEC = /(?:from\s+|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g;
const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel);
    else if (e.name.endsWith('.js')) files.push(rel);
  }
};
['src', 'bin', 'plugins'].forEach(walk);
const imports = files.flatMap((f) =>
  [...fs.readFileSync(path.join(root, f), 'utf8').matchAll(SPEC)].map((m) => ({
    from: f,
    to: path.normalize(path.join(path.dirname(f), m[1])),
  })),
);
const plugin = (p) => (p.startsWith('plugins/') ? p.split('/')[1] : null);
const show = (list) => list.map((i) => `${i.from} → ${i.to}`);

test('the core imports no plugin', () => {
  assert.deepEqual(show(imports.filter((i) => !plugin(i.from) && plugin(i.to))), []);
});

test('no plugin imports another plugin', () => {
  assert.deepEqual(show(imports.filter((i) => plugin(i.from) && plugin(i.to) && plugin(i.from) !== plugin(i.to))), []);
});

test('plugins use the core only through src/api.js', () => {
  assert.deepEqual(show(imports.filter((i) => plugin(i.from) && i.to.startsWith('src/') && i.to !== 'src/api.js')), []);
});

test("only a channel plugin uses a chat service's own library", () => {
  // (grammY is the Telegram bot library. The `tg` plugin reads the owner's own account
  // with another one, as a source of messages: that is not talking to the owner.)
  const users = files.filter((f) => /(?:from\s+|import\s*\(\s*)['"]grammy['"]/.test(fs.readFileSync(path.join(root, f), 'utf8')));
  assert.deepEqual(
    users.filter((f) => plugin(f) !== 'tg-bot'),
    [],
  );
  assert.ok(users.length > 0, 'the Telegram bot plugin does use it');
});

test('everything a plugin imports from the API exists there', async () => {
  const api = await import('../src/api.js');
  const missing = [];
  for (const f of files.filter(plugin)) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    for (const m of src.matchAll(/import\s+\{([^}]*)\}\s+from\s+'\.\.\/\.\.\/src\/api\.js'/g)) {
      for (const name of m[1]
        .split(',')
        .map((x) => x.trim().split(/\s+as\s+/)[0])
        .filter(Boolean))
        if (!(name in api)) missing.push(`${f}: ${name}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('the core starts and answers with every plugin switched off', async () => {
  const { spawnSync } = await import('node:child_process');
  const os = await import('node:os');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'blackcat-bare-'));
  fs.mkdirSync(path.join(home, 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'data/config.json'),
    JSON.stringify({ plugins: { disabled: fs.readdirSync(path.join(root, 'plugins')) } }),
  );
  const bc = (...a) =>
    spawnSync(process.execPath, [path.join(root, 'bin/bc.js'), ...a], { encoding: 'utf8', env: { ...process.env, BLACKCAT_HOME: home } });
  for (const args of [['--help'], ['plugin', 'list'], ['permissions']]) {
    const r = bc(...args);
    assert.equal(r.status, 0, `bc ${args.join(' ')}: ${r.stderr.slice(0, 300)}`);
  }
  assert.match(bc('plugin', 'list').stdout, /host/);
  // The archive's commands are part of the framework, and absent while there is nothing to search.
  assert.notEqual(bc('msg', 'chats').status, 0);
  assert.match(bc('plugin', 'list').stdout, /Part of blackcat itself: .*bc msg/);
  // The activity record is part of the framework too, and is there whatever is switched off.
  assert.equal(bc('activity', 'recent').status, 0);
  assert.match(bc('plugin', 'list').stdout, /Part of blackcat itself: bc activity \(Activity\)/);
  fs.rmSync(home, { recursive: true, force: true });
});

test("the archive's commands appear once there are messages, without being enabled, and can't be switched off", async () => {
  const { spawnSync } = await import('node:child_process');
  const os = await import('node:os');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'blackcat-msg-'));
  fs.mkdirSync(path.join(home, 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'data/config.json'),
    JSON.stringify({ plugins: { disabled: fs.readdirSync(path.join(root, 'plugins')) } }),
  );
  const env = { ...process.env, BLACKCAT_HOME: home };
  const bc = (...a) => spawnSync(process.execPath, [path.join(root, 'bin/bc.js'), ...a], { encoding: 'utf8', env });
  assert.notEqual(bc('msg', 'chats').status, 0, 'nothing to search yet');
  // Something arrives in the archive.
  const fill = `const { openArchiveForWriting, archiveStatements, messageRow } = await import(${JSON.stringify(path.join(root, 'src/api.js'))});
    const db = openArchiveForWriting(); const q = archiveStatements(db);
    q.chat.run({ ref: '1@s.whatsapp.net', name: 'Maya', isGroup: 0, ts: 1 });
    q.msg.run(messageRow({ chat: '1@s.whatsapp.net', id: 'A1', sender: '1@s.whatsapp.net', ts: Math.floor(Date.now() / 1000), text: 'hello there' })); db.close();`;
  assert.equal(spawnSync(process.execPath, ['--input-type=module', '-e', fill], { env, encoding: 'utf8' }).status, 0);
  assert.match(bc('msg', 'chats').stdout, /Maya/);
  assert.match(bc('msg', 'search', 'hello').stdout, /hello/);
  // read as a person reads it, and as the agent does (the first of these once failed on a name that was never imported: nothing ran it)
  const read = bc('msg', 'thread', 'Maya');
  assert.equal(read.status, 0, read.stderr);
  assert.match(read.stdout, /Maya.*WhatsApp[\s\S]*hello there/);
  assert.equal(JSON.parse(bc('msg', 'thread', 'Maya', '--json').stdout).messages[0].text, 'hello there');
  assert.match(bc('plugin', 'disable', 'msg').stdout, /part of blackcat itself/);
  assert.match(bc('msg', 'chats').stdout, /Maya/);
  fs.rmSync(home, { recursive: true, force: true });
});
