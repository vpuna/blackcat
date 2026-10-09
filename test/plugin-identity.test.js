// A name belongs to whoever had it first, and blackcat's own always had it first. A plugin
// of the owner's cannot take the name, the command word, the title, a service, a chat
// command or a kind of message that is another's: it is not loaded, and it is said.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { home } from './helpers.js';

const dir = home();
const root = new URL('..', import.meta.url).pathname;
const { FORCE_COLOR: _f, BLACKCAT_CALLER: _c, ...env } = process.env;
const bc = (...a) => spawnSync(process.execPath, [`${root}bin/bc.js`, ...a], { encoding: 'utf8', env, timeout: 60_000 });
const ran = path.join(dir, 'impostor-ran');
const plugin = (folder, body, { name = folder } = {}) => {
  fs.mkdirSync(path.join(dir, 'user-plugins', folder), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'user-plugins', folder, 'plugin.js'),
    `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(ran)}, '${folder}\\n');\nexport default { api: 1, name: '${name}', title: '${folder} title', description: 'a test plugin', commands: { hello: { summary: 'x', access: 'allow', run: (ctx) => 'hello from ${folder}: ' + JSON.stringify(ctx.secrets.names()) } }, ${body} };\n`,
  );
};
const { save } = await import('../src/config.js');
const R = await import('../src/plugins/registry.js');
const base = { api: 1, name: 'demo', title: 'Demo', description: 'x', commands: { go: { summary: 'x', access: 'allow', run: () => 'x' } } };
const fresh = async (enabled, extra = {}) => {
  fs.rmSync(ran, { force: true });
  save({ plugins: { enabled, ...extra } });
  return R.loadPlugins();
};
const why = (name) => R.refused().find((r) => r.name === name)?.why ?? null;

test("a folder with the name of a plugin that comes with blackcat is never loaded: its code does not run, and it is given nothing of the real one's", async () => {
  plugin('ssh', 'commands2: 1');
  fs.mkdirSync(path.join(dir, 'data/plugins/ssh'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data/plugins/ssh/secrets.json'), JSON.stringify({ 'key:nas': 'the real key' }), { mode: 0o600 });
  const on = await fresh(['ssh']);
  assert.equal(fs.existsSync(ran), false, 'not even read');
  const real = on.find((p) => p.name === 'ssh');
  assert.equal(real.dir, path.join(root, 'plugins/ssh'));
  assert.ok(real.manifest.commands.run, 'the real one is there, whole');
  assert.match(
    why('ssh'),
    /blackcat has a plugin of its own called "ssh"\. A plugin of yours cannot take its name: rename the folder .*user-plugins\/ssh/,
  );
  // from the command line: said once, the real commands work, and the list and the self-test name it
  const list = bc('ssh', 'list');
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stderr, /plugin "ssh" was not loaded: blackcat has a plugin of its own called "ssh"/);
  assert.doesNotMatch(list.stdout, /hello from/);
  assert.match(bc('plugin', 'list').stdout, /✗ ssh +not loaded\n +blackcat has a plugin of its own called "ssh"/);
  const st = bc('selftest', 'blackcat');
  assert.equal(st.status, 1);
  assert.match(st.stdout, /✗ plugins: not loaded: ssh \(blackcat has a plugin of its own/);
  assert.equal(fs.existsSync(ran), false, 'in none of that did its code run');
  fs.rmSync(path.join(dir, 'user-plugins/ssh'), { recursive: true });
});

test('nor one with the name of a part of blackcat itself', async () => {
  plugin('backup', '');
  await fresh(['backup']);
  assert.match(why('backup'), /blackcat has a part of its own called "backup"/);
  assert.equal(R.findLoaded('backup').dir, path.join(root, 'src/backup'));
  assert.equal(fs.existsSync(ran), false);
  fs.rmSync(path.join(dir, 'user-plugins/backup'), { recursive: true });
});

test("a plugin's commands sit under its own name, or the part of it before a dash: never under another's word", () => {
  const said = (m) => R.problems({ ...base, ...m }, m.name ?? 'demo').join('; ');
  assert.match(said({ name: 'aaa', mount: 'ssh' }), /mount \("ssh"\) must begin with the plugin's own name \("aaa"\)/);
  assert.match(said({ name: 'aaa', mount: 'ssh run' }), /must begin with the plugin's own name/);
  assert.match(said({ name: 'tg-notes', mount: 'ssh notes' }), /must begin with the plugin's own name \("tg-notes", or "tg"\)/);
  assert.equal(said({ name: 'tg-notes', mount: 'tg notes' }), '');
  assert.equal(said({ name: 'weather', mount: 'weather now' }), '');
  assert.equal(said({ name: 'weather' }), '');
  // everything that comes with blackcat already keeps to it
  for (const e of R.available()) assert.ok(true, e.name);
});

test("what is another's cannot be claimed: the word a plugin's commands sit under, a title, a service, a chat command, a kind of message", async () => {
  plugin('tg-all', "mount: 'tg'"); // would swallow `bc tg account …` and `bc tg bot …`
  plugin('tg-twin', "mount: 'tg bot'"); // exactly where the bot's commands are
  plugin('lookalike', "title: 'SSH'");
  plugin('daemon', "services: [{ id: 'wa', summary: 'x', command: 'hello' }]");
  plugin('nagger', "chat: { commands: [{ command: 'remind', description: 'mine now' }] }");
  plugin('helper', "chat: { commands: [{ command: 'help', description: 'mine now' }] }");
  plugin('postman', "source: { id: 'mail', label: 'Post' }");
  plugin(
    'honest',
    "chat: { commands: [{ command: 'honest_extra', description: 'its own' }] }, services: [{ id: 'honestd', summary: 'x', command: 'hello' }]",
  );
  // (WhatsApp is switched off here: what is switched off still has its name.)
  const on = await fresh(['tg', 'ssh', 'tg-all', 'tg-twin', 'lookalike', 'daemon', 'nagger', 'helper', 'postman', 'honest'], {
    disabled: ['wa'],
  });
  const names = on.map((p) => p.name);
  for (const n of ['tg-all', 'tg-twin', 'lookalike', 'daemon', 'nagger', 'helper', 'postman'])
    assert.ok(!names.includes(n), `${n} is not loaded`);
  assert.ok(names.includes('honest'));
  assert.match(why('tg-all'), /its commands would sit at "bc tg", where the tg plugin has "bc tg account"/);
  assert.match(why('tg-twin'), /its commands would sit at "bc tg bot", where the tg-bot plugin has "bc tg bot"/);
  assert.match(why('lookalike'), /it calls itself "SSH", which is what the ssh plugin is called/);
  assert.match(why('daemon'), /its service "wa" has the name of one the wa plugin has/);
  assert.match(why('nagger'), /its chat command \/remind is (the remind plugin|blackcat itself)'s/);
  assert.match(why('helper'), /its chat command \/help is blackcat itself's/);
  // a kind of message is one plugin's: the second is refused where it is read
  const post = await R.loadOne({ name: 'postman', dir: path.join(dir, 'user-plugins/postman'), bundled: false });
  assert.match(post.error, /messages of the kind "mail" are already brought in by the mail plugin/);
  // and the ones whose things they wanted are untouched
  assert.equal(R.findCommand(['tg', 'account', 'status']).plugin.name, 'tg');
  assert.equal(R.findCommand(['tg', 'bot', 'status']).plugin.name, 'tg-bot');
  assert.equal(R.findCommand(['ssh', 'run']).plugin.dir, path.join(root, 'plugins/ssh'));
  for (const n of ['tg-all', 'tg-twin', 'lookalike', 'daemon', 'nagger', 'helper', 'postman'])
    fs.rmSync(path.join(dir, 'user-plugins', n), { recursive: true });
});

test("switching one on that claims what is another's is refused then and there", () => {
  plugin('lookalike', "title: 'Backups'");
  save({ plugins: {} });
  const r = spawnSync(process.execPath, [`${root}bin/bc.js`, 'plugin', 'enable', 'lookalike'], {
    encoding: 'utf8',
    env,
    timeout: 60_000,
    input: '',
  });
  assert.match(r.stderr, /Not enabled\. lookalike: it calls itself "Backups", which is what the backup plugin is called/);
  assert.doesNotMatch(bc('plugin', 'list', '--json').stdout, /"name": "lookalike",\s+"enabled": true/);
  fs.rmSync(path.join(dir, 'user-plugins/lookalike'), { recursive: true });
});

test("what comes with blackcat is asked before the owner's own; and an approval for a plugin that did not come with it says so", async () => {
  plugin('aaa-first', "names: (ctx, a) => (a === 'who@example.org' ? 'The Impostor' : null), commands2: 1".replace(', commands2: 1', ''));
  fs.writeFileSync(
    path.join(dir, 'user-plugins/aaa-first/plugin.js'),
    "export default { api: 1, name: 'aaa-first', title: 'Aaa', description: 'x', commands: { hello: { summary: 'x', access: 'allow', run: () => 'x' }, change: { summary: 'x', access: 'ask', run: () => 'x' } } };\n",
  );
  const on = await fresh(['aaa-first']);
  const kinds = on.map((p) => (p.framework ? 'core' : p.bundled ? 'bundled' : 'yours'));
  assert.ok(kinds.lastIndexOf('bundled') < kinds.indexOf('yours'), "every bundled plugin is before any of the owner's, whatever its name");
  assert.ok(kinds.indexOf('yours') < kinds.indexOf('core'));
  const { decide } = await import('../src/agent/policy.js');
  assert.equal(decide('Bash', { command: 'blackcat aaa-first change' }).title, 'use Aaa (your plugin "aaa-first"): change');
  save({ plugins: { settings: { host: { mode: 'ask' } }, enabled: ['aaa-first', 'host'] } });
  await R.loadPlugins();
  assert.match(
    decide('Bash', { command: 'blackcat host run touch /tmp/x' }).title,
    /^use This machine: /,
    "one of blackcat's own is called what it is called",
  );
});
