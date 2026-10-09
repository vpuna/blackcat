// One faulty plugin costs itself, never blackcat: a misspelt key is said, a hook that
// throws is passed over, and the command that switches a plugin off always works.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { home } from './helpers.js';

const dir = home();
const root = new URL('..', import.meta.url).pathname;
const { FORCE_COLOR: _f, ...env } = process.env;
const bc = (...a) => spawnSync(process.execPath, [`${root}bin/bc.js`, ...a], { encoding: 'utf8', env, timeout: 60_000 });
const plugin = (name, body) => {
  fs.mkdirSync(path.join(dir, 'user-plugins', name), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'user-plugins', name, 'plugin.js'),
    `export default { api: 1, name: '${name}', title: '${name}', description: 'a test plugin', commands: { hello: { summary: 'says hello', access: 'allow', run: () => 'hello from ${name}' } }, ${body} };\n`,
  );
};
const { save, load } = await import('../src/config.js');
const { problems, loadPlugins, findLoaded } = await import('../src/plugins/registry.js');
const base = { api: 1, name: 'demo', title: 'Demo', description: 'x', commands: { go: { summary: 'x', access: 'allow', run: () => 'x' } } };

test('a key a manifest does not have is said, with the one that was probably meant', () => {
  assert.deepEqual(problems(base, 'demo'), []);
  assert.deepEqual(problems({ ...base, breifing: () => ({}) }, 'demo'), [
    'breifing is not something a manifest has (did you mean "briefing"?)',
  ]);
  assert.deepEqual(problems({ ...base, commands: { go: { ...base.commands.go, acess: 'allow', untrused: false } } }, 'demo'), [
    'commands.go.acess is not something a command has (did you mean "access"?)',
    'commands.go.untrused is not something a command has (did you mean "untrusted"?)',
  ]);
  assert.match(
    problems({ ...base, jobs: [{ id: 'work', every: '1h', run() {}, whenn: () => true }] }, 'demo').join('; '),
    /jobs\.work\.whenn is not something a job has \(did you mean "when"\?\)/,
  );
  assert.match(
    problems({ ...base, agent: { readDir: () => [] } }, 'demo').join('; '),
    /agent\.readDir is not something the agent part has \(did you mean "readDirs"\?\)/,
  );
  assert.match(
    problems({ ...base, somethingElseEntirely: 1 }, 'demo').join('; '),
    /^somethingElseEntirely is not something a manifest has$/,
  );
});

test('a key of the wrong kind is said, and so is a hook that may not be async', () => {
  const said = (m) => problems({ ...base, ...m }, 'demo').join('; ');
  assert.match(said({ help: 7 }), /help must be text/);
  assert.match(
    said({ commands: { go: { ...base.commands.go, hidden: 'yes', usage: ['a'] } } }),
    /commands\.go\.usage must be text; commands\.go\.hidden must be true or false|commands\.go\.hidden must be true or false; commands\.go\.usage must be text/,
  );
  assert.match(said({ jobs: 'hourly' }), /jobs must be a list/);
  assert.match(said({ agent: 'notes' }), /agent must be an object/);
  assert.match(said({ names: async () => 'x' }), /names must be a function that answers at once \(not async\)/);
  assert.match(said({ agent: { fill: async () => ({}) } }), /agent\.fill must be a function that answers at once/);
  assert.match(said({ agent: { readDirs: async () => [] } }), /agent\.readDirs must be a function that answers at once/);
  assert.match(
    said({ jobs: [{ id: 'work', every: '1h', run() {}, when: async () => true }] }),
    /jobs\.work\.when must be a function that answers at once/,
  );
  assert.match(
    said({ channel: { paired: async () => true, open: async () => {}, start: async () => {} } }),
    /channel\.paired must be a function that answers at once/,
  );
  assert.match(said({ source: { id: 'sms', label: 'Texts', textLimit: 'long' } }), /source\.textLimit must be a number/);
  // (async is fine wherever the answer is waited for)
  assert.deepEqual(
    problems(
      {
        ...base,
        status: async () => 'x',
        agenda: async () => [],
        briefing: async () => ({}),
        jobs: [{ id: 'work', every: '1h', run: async () => {} }],
      },
      'demo',
    ),
    [],
  );
});

test('a service may not be called agent, and a plugin whose service has a taken id is not loaded', async () => {
  assert.match(
    problems({ ...base, services: [{ id: 'agent', summary: 'x', command: 'go' }] }, 'demo').join('; '),
    /"agent" is blackcat's own service/,
  );
  plugin('first', "services: [{ id: 'feed', summary: 'the first feed', command: 'hello' }]");
  plugin(
    'second',
    "services: [{ id: 'feed', summary: 'an impostor', command: 'hello' }, { id: 'other', summary: 'its own', command: 'hello' }]",
  );
  save({ plugins: { enabled: ['first', 'second'] } });
  await loadPlugins();
  const { services } = await import('../src/service/units.js');
  const { refused, findLoaded: found } = await import('../src/plugins/registry.js');
  const all = await services();
  assert.equal(all.feed.summary, 'the first feed');
  assert.deepEqual(all.feed.args, ['first', 'hello']);
  // the second is not loaded at all, and it is said why: nothing of it runs under a borrowed name
  assert.equal(all.other, undefined);
  assert.equal(found('second'), undefined);
  assert.deepEqual(
    refused().map((r) => [r.name, r.why]),
    [['second', 'its service "feed" has the name of one the first plugin has']],
  );
  assert.match(all.agent.summary ?? 'the agent', /./);
});

test('a setup form that cannot be built costs that one command: every other command still runs, and the plugin can be switched off', () => {
  plugin('brittle', "status: () => 'fine'");
  const file = path.join(dir, 'user-plugins/brittle/plugin.js');
  fs.writeFileSync(
    file,
    fs
      .readFileSync(file, 'utf8')
      .replace(
        'commands: {',
        "commands: { setup: { summary: 'set it up', access: 'owner', form: () => { throw new Error('the list of rooms is not there'); }, run: () => 'saved' }, ",
      ),
  );
  save({ plugins: { enabled: ['brittle'] } });
  const hello = bc('brittle', 'hello');
  assert.equal(hello.status, 0, hello.stderr);
  assert.match(hello.stdout, /hello from brittle/);
  assert.match(hello.stderr, /plugin "brittle": setup\.form could not be built: the list of rooms is not there/);
  const setup = bc('brittle', 'setup');
  assert.notEqual(setup.status, 0);
  assert.match(setup.stderr + setup.stdout, /"setup" cannot be used: its form could not be built \(the list of rooms is not there\)/);
  assert.equal(bc('memory', 'list', '--json').status, 0, 'the rest of blackcat is untouched');
  const off = bc('plugin', 'disable', 'brittle');
  assert.equal(off.status, 0, off.stderr + off.stdout);
  assert.ok(!(load().plugins.enabled ?? []).includes('brittle'));
});

test('a plugin that cannot say which folders it opens, or names one it may not, opens none of those; the others still open theirs', async () => {
  const mine = path.join(dir, 'data/polite-media');
  plugin('rude', "agent: { readDirs: () => { throw new Error('no idea'); } }");
  plugin(
    'grabby',
    `agent: { readDirs: () => [${JSON.stringify(path.join(dir, 'data'))}, ${JSON.stringify(path.join(dir, 'data/plugins/mail'))}, 'relative/folder', 42, ${JSON.stringify(path.dirname(dir))}, ${JSON.stringify(path.join(dir, 'data/grabby-media'))}] }`,
  );
  plugin('polite', `agent: { readDirs: () => [${JSON.stringify(mine)}] }`);
  const r = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    const { save } = await import(${JSON.stringify(`${root}src/config.js`)});
    save({ plugins: { enabled: ['rude', 'grabby', 'polite'] } });
    await (await import(${JSON.stringify(`${root}src/plugins/registry.js`)})).loadPlugins();
    const { pluginReadDirs, readDirs } = await import(${JSON.stringify(`${root}src/channels/files.js`)});
    const a = pluginReadDirs(); pluginReadDirs();
    console.log(JSON.stringify({ dirs: a, all: readDirs().length }));`,
    ],
    { encoding: 'utf8', env },
  );
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout.trim().split('\n').pop());
  const fromHere = got.dirs
    .filter((d) => d.startsWith(dir))
    .map((d) => path.relative(path.join(dir, 'data'), d))
    .sort();
  assert.deepEqual(
    fromHere.filter((d) => /polite|grabby|^$|plugins/.test(d)),
    ['grabby-media', 'polite-media'],
  );
  assert.match(r.stderr, /plugin "rude": opens no folder to the agent: no idea/);
  assert.match(r.stderr, /plugin "grabby": agent\.readDirs: .*data takes in blackcat's own code or private data, and is not opened/);
  assert.match(r.stderr, /plugins\/mail is inside blackcat's own code or private data/);
  assert.match(r.stderr, /relative\/folder is not a full path/);
  assert.equal(r.stderr.match(/no idea/g).length, 1, 'said once, not at every turn');
});

test('an access function that answers with something that is not a level allows nothing', async () => {
  plugin('vague', '');
  const file = path.join(dir, 'user-plugins/vague/plugin.js');
  fs.writeFileSync(
    file,
    fs
      .readFileSync(file, 'utf8')
      .replace(
        "access: 'allow'",
        "access: (ctx, t) => (t[0] === 'a' ? 'alow' : t[0] === 'b' ? undefined : t[0] === 'c' ? { level: 'sure' } : 'allow')",
      ),
  );
  save({ plugins: { enabled: ['vague'] } });
  const { levelOf } = await import('../src/plugins/access.js');
  await loadPlugins();
  const p = findLoaded('vague');
  for (const first of ['a', 'b', 'c']) assert.equal(levelOf(p, 'hello', [first]).level, 'never', first);
  assert.match(levelOf(p, 'hello', ['a']).reason, /did not say who may run it/);
  assert.equal(levelOf(p, 'hello', ['z']).level, 'allow');
});

test('a calendar that cannot be read does not cost the others theirs, and nothing is taken off the list on its account', async () => {
  const day = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString('sv');
  const ev = (id, n) =>
    `{ id: '${id}', source: 'work', title: 'Meeting ${id}', start: ${Math.floor(Date.now() / 1000) + n * 86400}, end: ${Math.floor(Date.now() / 1000) + n * 86400 + 3600}, allDay: false, day: '${day(n)}', lastDay: '${day(n)}' }`;
  plugin('cal-good', `agenda: () => [${ev('one', 1)}, null, { title: 'half an entry' }]`);
  plugin(
    'cal-bad',
    "agenda: () => { if (globalThis.__calBroken) throw new Error('cannot reach the calendar'); return [" +
      ev('two', 2).replace("'work'", "'home'") +
      ']; }',
  );
  plugin('cal-odd', "agenda: () => 'tomorrow, probably'");
  save({ plugins: { enabled: ['cal-good', 'cal-bad'] } });
  await loadPlugins();
  const { openWatchDb, findWatch, listItems, addWatch } = await import('../src/watch/db.js');
  const { syncAgenda } = await import('../src/watch/agenda.js');
  const { withDb } = await import('../src/db.js');
  const { adopt } = await import('../src/watch/db.js');
  await withDb(openWatchDb, async (db) => {
    if (!findWatch(db, 'todo')) adopt?.(db, 42);
    const w =
      findWatch(db, 'todo') ??
      addWatch(db, { chatId: 42, name: 'Things I need to do', lookFor: 'x', sources: { everywhere: 'all' }, mode: 'digest' });
    const titles = () =>
      listItems(db, w.id, { status: 'new,kept' })
        .filter((i) => i.category === 'calendar')
        .map((i) => i.title)
        .sort();
    assert.deepEqual(await syncAgenda(db), { added: 2, removed: 0 });
    assert.deepEqual(titles(), ['Meeting one', 'Meeting two']);
    globalThis.__calBroken = true;
    assert.deepEqual(await syncAgenda(db), { added: 0, removed: 0 });
    assert.deepEqual(titles(), ['Meeting one', 'Meeting two'], 'the entry from the calendar that cannot be read just now stays');
    globalThis.__calBroken = false;
  });
});

test("a job whose schedule check throws is passed over; the same plugin's other job and its tick go on", async () => {
  const ticked = path.join(dir, 'ticked');
  globalThis.__sturdy = { fs, ticked, due: [] };
  plugin(
    'mixed',
    `jobs: [{ id: 'broken', every: '1m', when: () => { throw new Error('bad check'); }, run: () => {} }, { id: 'sound', every: '1m', when: () => { globalThis.__sturdy.due.push('sound'); return false; }, run: () => {} }],
    chat: { tick: () => { globalThis.__sturdy.fs.writeFileSync(globalThis.__sturdy.ticked, 'yes'); } }`,
  );
  const bundled = [...fs.readdirSync(`${root}plugins`), 'watch', 'remind', 'check'];
  save({ plugins: { enabled: ['mixed'], disabled: bundled } });
  await loadPlugins();
  const { startScheduler } = await import('../src/agent/scheduler.js');
  const s = startScheduler({ api: {} });
  await new Promise((r) => setTimeout(r, 600));
  s.stop();
  assert.ok(globalThis.__sturdy.due.includes('sound'), 'the job after the broken one was still looked at');
  assert.equal(fs.existsSync(ticked), true, 'and the plugin still had its turn');
});
