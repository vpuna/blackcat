// What a plugin may use is src/api.js and nothing else, and what would let one plugin
// reach another's settings and secrets, change what the agent is allowed, or get at
// blackcat's own files is not in it. The core's own parts use src/internal.js.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { home } from './helpers.js';

const dir = home();
const root = new URL('..', import.meta.url).pathname;
const files = (...where) =>
  spawnSync('git', ['ls-files', ...where], { cwd: root, encoding: 'utf8' })
    .stdout.split('\n')
    .filter((f) => /\.m?js$/.test(f));
const { save } = await import('../src/config.js');
save({ plugins: { settings: { wa: { days: 30 }, tg: { days: 7 }, voice: { model: 'small' }, mail: { accounts: { home: {} } } } } });
const api = await import('../src/api.js');
const internal = await import('../src/internal.js');

// Each of these is a way into something that is not the asking plugin's own.
const NOT_FOR_PLUGINS = {
  makeCtx: "another plugin's context: its settings, secrets and store",
  loaded: 'every loaded plugin, manifest and all',
  findLoaded: 'any loaded plugin',
  pluginSettings: "any plugin's settings, by name",
  setPluginSettings: "changing any plugin's settings, by name",
  load: 'the whole settings file',
  save: 'writing the whole settings file',
  update: 'changing the whole settings file',
  CONFIG_FILE: 'where the settings file is',
  DATA: 'the data folder as such, every private file in it',
  HOME: "blackcat's own folder",
  CODE_DIR: "blackcat's own code",
  openAgentDb: "blackcat's own database: standing permissions, reminders, what is remembered",
  addRule: 'allowing the agent a command for good',
  removeRule: 'taking back what the owner decided',
  ruleFor: "reading the owner's standing answers",
  listRules: "reading the owner's standing answers",
  storeFor: "any part's kept values",
  services: 'every service, the agent among them',
  ui: 'the chat itself',
  owner: 'who the owner is and where they are reached',
  ownerChat: 'where the owner is reached',
  tellChat: 'sending to any chat',
  askReader: "the core's own readers",
};

test('nothing in the plugin API reaches past the asking plugin', () => {
  const there = Object.keys(NOT_FOR_PLUGINS).filter((n) => n in api);
  assert.deepEqual(there, [], there.map((n) => `${n}: ${NOT_FOR_PLUGINS[n]}`).join('; '));
});

test('what a plugin is handed as ctx.api is that same file, and no more', async () => {
  const { loadPlugins, makeCtx, findLoaded } = await import('../src/plugins/registry.js');
  await loadPlugins();
  const given = makeCtx(findLoaded('host') ?? (await loadPlugins())[0]).api;
  assert.deepEqual(Object.keys(given).sort(), Object.keys(api).sort());
  for (const n of Object.keys(NOT_FOR_PLUGINS)) assert.equal(given[n], undefined, n);
});

test("the core's own parts have all of it, from src/internal.js, and only they import it", () => {
  for (const n of Object.keys(api)) assert.ok(n in internal, `${n} is in internal.js too`);
  for (const n of ['makeCtx', 'loaded', 'load', 'update', 'DATA', 'openAgentDb', 'addRule', 'ruleFor', 'pluginSettings'])
    assert.ok(n in internal, n);
  const wrong = [];
  for (const f of files('plugins', 'user-plugins')) if (/internal\.js/.test(fs.readFileSync(path.join(root, f), 'utf8'))) wrong.push(f);
  assert.deepEqual(wrong, [], 'a plugin imports src/api.js, never src/internal.js');
  // and the core does not lean on the plugin file for its own needs (what ctx.api is, aside)
  const leaning = [];
  for (const f of files('src')) {
    if (f === 'src/api.js' || f === 'src/internal.js') continue;
    const text = fs
      .readFileSync(path.join(root, f), 'utf8')
      .split('\n')
      .filter((l) => !/apiNamespace/.test(l) && !/^\s*\/\//.test(l))
      .join('\n');
    if (/from '(\.\.\/|\.\/)+api\.js'|import\('(\.\.\/|\.\/)+api\.js'\)/.test(text)) leaning.push(f);
  }
  assert.deepEqual(leaning, []);
});

test('no bundled plugin reads the settings file, or names another plugin to get at its settings', () => {
  const wrong = [];
  for (const f of files('plugins')) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    if (/config\.json|plugins\?\.settings|plugins\.settings/.test(text.replace(/^\s*\/\/.*$/gm, ''))) wrong.push(f);
  }
  assert.deepEqual(wrong, []);
});

test("a plugin's own settings and folder, without a ctx: its own and no other's, by where the asking file is", () => {
  const at = (plugin, file = 'x.js') => new URL(`../plugins/${plugin}/${file}`, import.meta.url).href;
  assert.deepEqual(api.settingsFor(at('wa')).get(), { days: 30 });
  assert.deepEqual(api.settingsFor(at('tg', 'deeper/y.js')).get(), { days: 7 });
  api.settingsFor(at('wa')).set({ mode: 'all' });
  assert.deepEqual(api.settingsFor(at('wa')).get(), { days: 30, mode: 'all' });
  assert.deepEqual(api.settingsFor(at('tg')).get(), { days: 7 }, "another's are untouched");
  assert.equal(api.ownDataDir(at('wa')), path.join(dir, 'data/plugins/wa'));
  assert.equal(fs.statSync(path.join(dir, 'data/plugins/wa')).mode & 0o777, 0o700);
  // a plugin of the owner's, outside the repository
  assert.equal(api.ownDataDir(path.join(dir, 'user-plugins/mine/plugin.js')), path.join(dir, 'data/plugins/mine'));
  // anything else is nobody's
  for (const not of [
    new URL('../src/watch/db.js', import.meta.url).href,
    new URL('../plugins/loose.js', import.meta.url).href,
    import.meta.url,
    '/tmp/x.js',
    new URL('../plugins/../src/api.js', import.meta.url).href,
  ]) {
    assert.throws(() => api.settingsFor(not), /is not a plugin's file/, not);
    assert.throws(() => api.ownDataDir(not), /is not a plugin's file/, not);
  }
});

test("dataPath: a folder of a plugin's own at the top of the data folder, never one of blackcat's", () => {
  assert.equal(api.dataPath('unifi-media'), path.join(dir, 'data/unifi-media'));
  assert.equal(api.dataPath('models', 'whisper-small'), path.join(dir, 'data/models/whisper-small'));
  assert.equal(api.dataPath('tg-account'), path.join(dir, 'data/tg-account'));
  for (const no of [
    ['config.json'],
    ['config.json.lock'],
    ['agent.db'],
    ['agent.db-wal'],
    ['archive.db'],
    ['archive-index.db'],
    ['plugins'],
    ['plugins', 'mail', 'secrets.json'],
    ['permissions.json'],
    ['backup-tmp'],
    ['readers'],
    ['inbox'],
  ]) {
    assert.throws(() => api.dataPath(...no), /is blackcat's own/, no.join('/'));
  }
  for (const out of [['..'], ['..', 'src'], ['x', '..', '..', 'y'], ['/etc/passwd'], ['.'], ['x-media', '..', 'plugins', 'mail']]) {
    assert.throws(() => api.dataPath(...out), /not inside blackcat's data folder|is blackcat's own/, out.join('/'));
  }
});

test('when a setting last changed: nothing yet, then a time that moves only with a change', async () => {
  const before = api.settingsChangedAt();
  assert.ok(before > 0);
  await new Promise((r) => setTimeout(r, 15));
  api.settingsFor(new URL('../plugins/wa/x.js', import.meta.url).href).set({ mode: 'all' }); // the same as it is
  assert.equal(api.settingsChangedAt(), before, 'nothing changed, nothing written');
  api.settingsFor(new URL('../plugins/wa/x.js', import.meta.url).href).set({ mode: 'selected' });
  assert.ok(api.settingsChangedAt() > before);
});

test("the Telegram source's requests are in a small database of its own, not in blackcat's", async () => {
  const { openRequestsDb } = await import('../plugins/tg/requests.js');
  const { withDb, hasTable } = await import('../src/db.js');
  withDb(openRequestsDb, (db) => {
    db.prepare('INSERT INTO tg_requests (msg_id, created_ts) VALUES (?, ?)').run('tg:1:2', 1);
    assert.equal(db.name, path.join(dir, 'data/plugins/tg/requests.db'));
  });
  const { openAgentDb } = await import('../src/agentdb.js');
  withDb(openAgentDb, (db) => assert.equal(hasTable(db, 'tg_requests'), false));
});

test('every name a bundled plugin takes from the API is in it, however the name is taken', () => {
  // import { a } · const { a } = await import(api) · const { a } = api · api.a · (await import(api)).a · ctx.api.a
  const have = new Set(Object.keys(api));
  const wrong = [];
  for (const f of files('plugins')) {
    const s = fs.readFileSync(path.join(root, f), 'utf8');
    const used = new Set();
    for (const m of s.matchAll(/import \{([^}]*)\} from '[^']*src\/api\.js'/g))
      for (const p of m[1].split(','))
        used.add(
          p
            .trim()
            .split(/\s+as\s+/)[0]
            .trim(),
        );
    const spaces = [...s.matchAll(/const (\w+) = await import\([^)]*src\/api\.js[^)]*\)/g)].map((m) => m[1]);
    for (const m of s.matchAll(
      new RegExp(
        `const \\{([^}]*)\\} = (?:await import\\([^)]*src\\/api\\.js[^)]*\\)|(?:ctx\\.api${spaces.map((n) => `|${n}`).join('')})(?![\\w.(]))`,
        'g',
      ),
    ))
      for (const p of m[1].split(',')) used.add(p.trim().split(':')[0].trim());
    for (const n of spaces) for (const m of s.matchAll(new RegExp(`(?<![\\w/.'])${n}\\.(\\w+)`, 'g'))) used.add(m[1]); // (not the file's own name, …/api.js)
    for (const m of s.matchAll(/ctx\.api\.(\w+)/g)) used.add(m[1]);
    for (const m of s.matchAll(/\(await import\([^)]*src\/api\.js[^)]*\)\)\.(\w+)/g)) used.add(m[1]);
    for (const n of used) if (n && !have.has(n)) wrong.push(`${f} takes ${n}`);
  }
  assert.deepEqual(wrong, []);
});
