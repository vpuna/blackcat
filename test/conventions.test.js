// The same thing is called the same thing in every plugin (docs/plugins.md, "Naming"), and
// a setup shows what is set now and keeps a saved secret. These tests hold that for
// everything bundled, so the next plugin cannot quietly do it differently.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { home } from './helpers.js';

const dir = home();
process.env.HOME = dir;
const root = new URL('..', import.meta.url).pathname;
fs.mkdirSync(path.join(dir, 'user-plugins/keeper'), { recursive: true });
fs.writeFileSync(
  path.join(dir, 'user-plugins/keeper/plugin.js'),
  `
export default {
  api: 1, name: 'keeper', title: 'Keeper', description: 'a test plugin',
  commands: {
    setup: {
      summary: 'connect it', access: 'owner',
      form: [
        { id: 'url', type: 'text', message: 'Address', default: (a, ctx) => ctx.config.get().url },
        { id: 'token', type: 'secret', message: 'Token', keep: true },
      ],
      run: (ctx, a) => { ctx.config.set({ url: a.url }); if (a.token) ctx.secrets.set('token', a.token); return 'Saved ' + a.url + ' with a token of ' + ctx.secrets.get('token').length + ' characters.'; },
    },
    list: { summary: 'the things', access: 'allow', run: () => 'three things' },
  },
};`,
);
const { save, load } = await import('../src/config.js');
const bundled = [...fs.readdirSync(`${root}plugins`), 'watch', 'remind', 'check']; // (and the parts of blackcat itself that can be switched off)
save({ plugins: { enabled: [...bundled, 'keeper'], settings: { host: { alerts: true, tempLimit: 68, diskLimit: 80 } } } });
const reg = await import('../src/plugins/registry.js');
const plugins = await reg.loadPlugins();
const forms = await import('../src/plugins/forms.js');
const bc = (args, env = {}) =>
  spawnSync(process.execPath, [`${root}bin/bc.js`, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
const ctxOf = (name) => reg.makeCtx(reg.findLoaded(name), { caller: 'owner' });
const own = (p) => Object.entries(p.manifest.commands);

// ---- naming ----

// One word for one purpose. A plugin that uses another word for it is told which to use.
const INSTEAD = {
  remove: ['delete', 'del', 'rm', 'erase', 'drop'],
  list: ['ls', 'all', 'show-all', 'index'],
  setup: ['configure', 'config', 'init', 'install', 'connect', 'login', 'set'],
  'unpair, or `bc plugin disable <name> --data`': ['disconnect', 'logout', 'unlink', 'reset'],
  sync: ['refresh', 'update', 'fetch', 'pull', 'reload'],
  show: ['info', 'details', 'describe', 'view', 'get-one'],
  find: ['lookup', 'query', 'grep'],
  test: ['ping', 'verify', 'validate'],
};
// Where a word is the right one for something else. (msg has two kinds of search; `ha set`
// sets a light's brightness or a thermostat's temperature, which is not setting the plugin up.)
const ALLOWED = { engine: ['check'], msg: ['search', 'index'], ha: ['set'] };

test('one word for one purpose: no plugin has its own name for a standard command', () => {
  const bad = [];
  for (const p of plugins) {
    for (const [name] of own(p)) {
      if (ALLOWED[p.name]?.includes(name)) continue;
      for (const [use, others] of Object.entries(INSTEAD)) if (others.includes(name)) bad.push(`${p.name} ${name}: call it ${use}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('what can be added can be listed and removed; what is paired can be unpaired', () => {
  const bad = [];
  for (const p of plugins) {
    const names = own(p).map(([n]) => n);
    if (names.includes('add')) {
      if (!names.includes('list')) bad.push(`${p.name}: has add but no list`);
      if (!names.includes('remove') && !names.includes('cancel')) bad.push(`${p.name}: has add but no remove`);
    }
    if (names.includes('pair') && !names.includes('unpair')) bad.push(`${p.name}: has pair but no unpair`);
    const remove = p.manifest.commands.remove;
    if (remove && !/[<[]/.test(remove.usage ?? ''))
      bad.push(`${p.name} remove: takes what to remove as an argument (bc ${p.name} remove <name>)`);
  }
  assert.deepEqual(bad, []);
});

test('`check` is a test for a check to run, and the long-running service command is not shown', () => {
  const bad = [];
  for (const p of plugins) {
    const c = p.manifest.commands.check;
    if (c && !ALLOWED[p.name]?.includes('check') && !/made for checks/.test(c.summary)) bad.push(`${p.name} check: "${c.summary}"`);
    const run = p.manifest.commands.run;
    if (run && /foreground|the .* service runs this/.test(run.summary) && !run.hidden)
      bad.push(`${p.name} run: the service's own command should be hidden`);
  }
  assert.deepEqual(bad, []);
});

test('a period is given the same way everywhere: --since', () => {
  const bad = [];
  // (Only options that say how far BACK to look: --days is also the days of the week a
  // schedule runs on, and how far ahead a calendar is read.)
  for (const p of plugins) {
    for (const [name, c] of own(p)) {
      const flags = (c.options ?? []).map((o) => o[0]);
      const back = (c.options ?? []).some((o) => /--hours|--days/.test(o[0]) && /\b(back|last|same, in)\b/.test(o[1] ?? ''));
      if (back && !flags.some((f) => /--since/.test(f))) bad.push(`${p.name} ${name}: takes --hours or --days but not --since`);
    }
  }
  assert.deepEqual(bad, []);
  assert.match(bc(['activity', 'usage', '--since', '30d']).stdout, /last 30 days/);
  assert.match(bc(['activity', 'usage', '--since', '36h']).stdout, /last 2 days/, 'part of a day counts as one');
  assert.match(bc(['activity', 'usage', '--days', '3']).stdout, /last 3 days/, 'the older way still works');
});

// ---- setup ----

// Questions whose answer is not itself a setting (which of the two the rest is about).
const NOT_KEPT = ['engine for'];

test('every setup shows what is set now, not a fixed value, and keeps a secret that is saved', () => {
  const bad = [];
  for (const p of plugins) {
    const c = p.manifest.commands.setup;
    if (!Array.isArray(c?.form)) continue;
    for (const s of c.form) {
      if (!s.id) continue;
      if (s.type === 'secret') {
        if (!s.keep) bad.push(`${p.name} setup: the secret "${s.id}" must be asked for again every time (add keep: true)`);
      } else if (s.default !== undefined && typeof s.default !== 'function' && !NOT_KEPT.includes(`${p.name} ${s.id}`))
        bad.push(
          `${p.name} setup: "${s.id}" always offers ${JSON.stringify(s.default)}, whatever is set (make default a function of what is saved)`,
        );
    }
  }
  assert.deepEqual(bad, []);
});

test("a preference may be changed by the agent with the owner's say; a connection, a login or a permission never", async () => {
  const { decide } = await import('../src/agent/policy.js');
  const act = (command) => decide('Bash', { command }).action;
  // preferences: how blackcat behaves
  for (const c of [
    'remind setup --quiet 22:00-07:00',
    'voice setup --model small --language english',
    'host setup --alerts --temp-limit 70 --disk-limit 85',
    'activity setup --on --days 30 --commands auto --cost',
    'conversations setup --on --days 90',
    'engine setup --for chat --model opus --effort high',
  ])
    assert.equal(act(`blackcat ${c}`), 'ask', c);
  // connections and logins: where blackcat reaches, and with what
  for (const c of [
    'ha setup --url http://x --free',
    'unifi setup --host 10.0.0.1',
    'backup setup --place ssh:nas',
    'allsky setup --url http://x',
    'claude setup --endpoint http://x',
    'mail add --name x',
    'calendar add --name x',
    'ssh add --name x',
    'tg bot pair',
    'wa pair',
  ])
    assert.equal(act(`blackcat ${c}`), 'deny', c);
  // permissions: what the agent itself may do
  for (const c of ['host mode full', 'ssh mode nas full', 'ha kind light free', 'engine use parrot'])
    assert.equal(act(`blackcat ${c}`), 'deny', c);
  // and every setup that asks for a secret is the owner's alone
  for (const p of plugins) {
    const c = p.manifest.commands.setup;
    if (Array.isArray(c?.form) && c.form.some((s) => s.type === 'secret'))
      assert.equal(c.access, 'owner', `${p.name} setup asks for a secret`);
  }
});

test("this machine's alert limits: setup offers the ones that are set, and switching alerts off does not lose them", () => {
  const host = reg.findLoaded('host');
  const steps = host.manifest.commands.setup.form;
  const ctx = ctxOf('host');
  assert.deepEqual(
    steps.map((s) => forms.defaultOf(s, {}, ctx)),
    [true, 68, 80],
  );
  assert.match(bc(['host', 'setup', '--no-alerts']).stdout, /Alerts off/);
  assert.deepEqual(load().plugins.settings.host, { alerts: false, tempLimit: 68, diskLimit: 80 });
});

test('a saved secret: the question says so, empty keeps it, and anything typed replaces it', () => {
  const ctx = ctxOf('keeper');
  const step = reg.findLoaded('keeper').manifest.commands.setup.form[1];
  // nothing saved yet: it is needed
  assert.equal(forms.savedOf(step, {}, ctx), false);
  assert.deepEqual(forms.check(step, '', {}, ctx), { error: 'This is needed.' });
  let r = bc(['keeper', 'setup', '--url', 'http://a']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Missing: token \(secret: run this in a terminal, or use \/setup in the bot\)/);
  ctx.secrets.set('token', 'first-token');
  // saved: empty keeps it
  assert.equal(forms.savedOf(step, {}, ctx), true);
  assert.deepEqual(forms.check(step, '', {}, ctx), { value: '' });
  assert.deepEqual(forms.check(step, '  new  ', {}, ctx), { value: 'new' });
  // so the address can be changed, away from a terminal too, without the secret in hand
  r = bc(['keeper', 'setup', '--url', 'http://b']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'Saved http://b with a token of 11 characters.');
  assert.equal(ctx.secrets.get('token'), 'first-token');
  // and with nothing to change, nothing is asked at all: what is set is what is offered
  assert.equal(forms.defaultOf(reg.findLoaded('keeper').manifest.commands.setup.form[0], {}, ctxOf('keeper')), 'http://b');
  // a secret is never accepted as an option (it would be in the shell's history)
  assert.match(bc(['keeper', 'setup', '--url', 'http://c', '--token', 'x']).stderr, /unknown option '--token'/);
  // a question that says for itself whether one is saved
  const own2 = { id: 'pw', type: 'secret', message: 'x', keep: (a) => a.name === 'known' };
  assert.equal(forms.savedOf(own2, { name: 'known' }, ctx), true);
  assert.equal(forms.savedOf(own2, { name: 'new' }, ctx), false);
  assert.equal(forms.savedOf({ id: 'token', type: 'secret', message: 'x' }, {}, ctx), false, 'only a question that asks for it');
});

test('the bundled connections keep their secret when setup is run again', () => {
  for (const [name, id] of [
    ['ha', 'token'],
    ['unifi', 'key'],
    ['backup', 'passphrase'],
    ['claude-code', 'key'],
  ]) {
    const step = reg.findLoaded(name).manifest.commands.setup.form.find((s) => s.id === id);
    const ctx = ctxOf(name);
    assert.equal(forms.savedOf(step, { encrypt: true, endpoint: 'http://x' }, ctx), false, name);
    ctx.secrets.set(id, 'a-saved-secret');
    assert.equal(forms.savedOf(step, { encrypt: true, endpoint: 'http://x' }, ctx), true, name);
    assert.deepEqual(forms.check(step, '', { encrypt: true }, ctx), { value: '' }, name);
    ctx.secrets.delete(id);
  }
});

test('switching a plugin off keeps what it knows, unless told to delete it', () => {
  const ctx = ctxOf('keeper');
  assert.match(bc(['plugin', 'disable', 'keeper']).stdout, /its settings and secrets are kept; add --data to delete them too/);
  assert.equal(load().plugins.settings.keeper.url, 'http://b');
  assert.equal(ctx.secrets.get('token'), 'first-token');
  bc(['plugin', 'enable', 'keeper']);
  assert.match(bc(['plugin', 'disable', 'keeper', '--data']).stdout, /and its settings, secrets and data deleted/);
  assert.equal(load().plugins.settings.keeper, undefined);
  assert.ok(!fs.existsSync(path.join(dir, 'data/plugins/keeper')));
  bc(['plugin', 'enable', 'keeper']);
});

// ---- the names that were changed ----

test('the renamed commands go by their new names only', async () => {
  for (const [group, was, now] of [
    ['ssh', 'hosts', 'list'],
    ['ssh', 'check', 'judge'],
    ['engine', 'show', 'status'],
    ['engine', 'set', 'setup'],
    ['tg bot', 'check', 'test'],
  ]) {
    const g = group.split(' ');
    const help = bc([...g, '--help']).stdout;
    assert.match(help, new RegExp(`^  ${now}\\b`, 'm'), `${group} ${now}`);
    const old = bc([...g, was]);
    assert.notEqual(old.status, 0, `${group} ${was} is gone`);
    assert.match(old.stderr, /unknown command/);
  }
  assert.doesNotMatch(bc(['wa', '--help']).stdout, /^ {2}run\b/m, "the service's own service command is not shown");
  assert.match(bc(['ssh', 'judge', 'docker', 'restart', 'plex']).stdout, /^change: docker restart plex/);
  const { decide } = await import('../src/agent/policy.js');
  assert.equal(decide('Bash', { command: 'blackcat ssh list --json' }).action, 'allow');
  assert.equal(decide('Bash', { command: 'blackcat engine status --json' }).action, 'allow');
  assert.equal(decide('Bash', { command: 'blackcat engine setup --for chat --model opus --effort low' }).action, 'ask');
  const { runtimePrompt } = await import('../src/channels/commands.js');
  const told = runtimePrompt({ surface: 'chat' });
  assert.doesNotMatch(told, /engine show|engine set\b(?!up)|ssh hosts|ssh check/);
  assert.match(told, /blackcat engine status --json/);
});

test('removing a machine: by name, and still not without being sure', () => {
  bc(['ssh', 'add', '--name', 'nas', '--host', '10.0.0.5', '--user', 'me', '--port', '22', '--mode', 'ask']);
  assert.ok(load().plugins.settings.ssh.hosts.nas);
  let r = bc(['ssh', 'remove', 'nas']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Missing: --sure/);
  assert.equal(bc(['ssh', 'remove', 'nas', '--no-sure']).stdout.trim(), 'Nothing changed.');
  assert.ok(load().plugins.settings.ssh.hosts.nas);
  r = bc(['ssh', 'remove', 'nas', '--sure']);
  assert.match(r.stdout, /^Removed "nas"/);
  assert.equal(load().plugins.settings.ssh.hosts.nas, undefined);
});

// ---- what the agent is told about a plugin: a file beside it, filled in by the plugin

test('notes for the agent: placeholders, lists, and text for one state or another', async () => {
  const { fillNotes } = await import('../src/plugins/notes.js');
  const t = [
    'Always.',
    '<!-- when: not ready -->',
    'Not set up.',
    '<!-- when: ready -->',
    'Hosts: {{hosts}}.',
    '{{lines}}',
    '<!-- when: extra -->',
    'Extra: {{extra}}',
    '<!-- always -->',
    'The end.',
    '',
  ].join('\n');
  assert.equal(fillNotes(t, { ready: false }), 'Always.\nNot set up.\nThe end.');
  assert.equal(
    fillNotes(t, { ready: true, hosts: 'a; b', lines: ['- one', '- two'], extra: 3 }),
    'Always.\nHosts: a; b.\n- one\n- two\nExtra: 3\nThe end.',
  );
  // a line that is only a placeholder goes when there is nothing to put; elsewhere it is empty
  assert.equal(fillNotes(t, { ready: true, hosts: '', lines: [] }), 'Always.\nHosts: .\nThe end.');
  // nothing set counts as not set: '', false, null, an empty list. A number does count, 0 too.
  for (const v of ['', false, null, undefined, []])
    assert.equal(fillNotes('<!-- when: x -->\nyes\n<!-- when: not x -->\nno', { x: v }), 'no');
  for (const v of [true, 'a', 0, 2, ['a']]) assert.equal(fillNotes('<!-- when: x -->\nyes\n<!-- when: not x -->\nno', { x: v }), 'yes');
  // a placeholder nothing was supplied for is a mistake, said plainly; in text that is left out it is not looked at
  assert.throws(() => fillNotes('Hello {{who}}.', {}), /\{\{who\}\} is in agent\.md, and nothing was supplied for it/);
  assert.equal(fillNotes('<!-- when: ready -->\nHello {{who}}.\n<!-- always -->\nBye.', {}), 'Bye.');
  // braces that are not a placeholder (a command's own) are left alone
  assert.equal(fillNotes('docker inspect -f {{.State.Running}} x'), 'docker inspect -f {{.State.Running}} x');
  // a file with nothing to fill in is used as it is
  assert.equal(fillNotes('Plain text.\n\nTwo paragraphs.\n'), 'Plain text.\n\nTwo paragraphs.');
});

test('every plugin the agent can use says what it is for in an agent.md of its own, and fills in all of it', async () => {
  const { available, loadOne, makeCtx } = await import('../src/plugins/registry.js');
  const { notesOf, notesFile } = await import('../src/plugins/notes.js');
  // The two the agent may not use at all have nothing to tell it.
  const NONE = ['claude-code', 'tg-bot'];
  for (const entry of available()) {
    const p = await loadOne(entry);
    if (entry.bundled) assert.ok(!p.error, `${entry.name}: ${p.error}`);
    // (Those that come with blackcat: a plugin of the owner's own may do without.)
    if (NONE.includes(p.name) || !entry.bundled) continue;
    assert.ok(fs.existsSync(notesFile(p)), `${p.name} has no agent.md`);
    // on an installation where nothing is set up, it still has something to say, and nothing is left unfilled
    const notes = notesOf(p, makeCtx(p, { caller: 'agent' }));
    assert.ok(notes && notes.length > 40, `${p.name}: its notes came to nothing`);
    assert.ok(
      !/\{\{[\w-]+\}\}|<!--/.test(notes),
      `${p.name}: something was left unfilled: ${notes.match(/.*(\{\{[\w-]+\}\}|<!--).*/)?.[0]}`,
    );
    // and every name its agent.md uses is one the plugin can supply (the names it fills in when set up are in its source)
    const src = fs.readFileSync(path.join(p.dir, p.file ?? 'plugin.js'), 'utf8');
    const used = [...fs.readFileSync(notesFile(p), 'utf8').matchAll(/\{\{([\w-]+)\}\}|<!--\s*when:\s*(?:not\s+)?([\w-]+)\s*-->/g)].map(
      (m) => m[1] ?? m[2],
    );
    for (const name of new Set(used))
      assert.ok(
        new RegExp(`['"]?${name}['"]?\\s*[:,]|\\b${name}\\b\\s*[,}]`).test(src.slice(src.indexOf('fill:'))),
        `${p.name}: agent.md uses "${name}", which its fill does not supply`,
      );
  }
});

const plainEnv = () => {
  const { FORCE_COLOR: _f, ...env } = process.env;
  return { ...env, NO_COLOR: '1' };
};
const bcPlain = (...args) => spawnSync(process.execPath, [`${root}bin/bc.js`, ...args], { encoding: 'utf8', env: plainEnv() });

// ---- what blackcat is made of: a core, parts of which can be switched off, and plugins at the edges

test('watches, reminders and checks are part of blackcat, not plugins; they can be switched off, and the rest carries on', async () => {
  const { available, isEnabled } = await import('../src/plugins/registry.js');
  const own = Object.fromEntries(
    available()
      .filter((e) => e.framework)
      .map((e) => [e.name, e]),
  );
  assert.deepEqual(Object.keys(own).sort(), ['activity', 'backup', 'check', 'conversations', 'engine', 'memory', 'msg', 'remind', 'watch']);
  assert.deepEqual(
    Object.keys(own)
      .filter((n) => own[n].optional)
      .sort(),
    ['backup', 'check', 'remind', 'watch'],
  );
  for (const n of ['watch', 'remind', 'backup']) assert.ok(!fs.existsSync(path.join(root, 'plugins', n)), `plugins/${n} is gone`);
  // nothing of the owner's can take their place
  fs.mkdirSync(path.join(dir, 'user-plugins/watch'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'user-plugins/watch/plugin.js'),
    "export default { api: 1, name: 'watch', title: 'Mine', description: 'x', commands: { hello: { summary: 'x', access: 'allow', run: () => 'hi' } } };\n",
  );
  assert.equal(available().find((e) => e.name === 'watch').dir, path.join(root, 'src/watch'));
  fs.rmSync(path.join(dir, 'user-plugins/watch'), { recursive: true });

  assert.match(
    bcPlain('plugin', 'list').stdout,
    /Part of blackcat itself: .*bc backup \(Backups\), bc check \(Checks\), .*bc remind \(Reminders\), bc watch \(Watches\)\nOf those, you can switch off: backup, check, remind, watch/,
  );
  assert.match(bcPlain('watch', 'list').stdout, /Things I need to do/);
  // switched off: its commands are gone, the agent is told nothing of it, and what was kept stays
  assert.match(bcPlain('plugin', 'disable', 'watch').stdout, /watch disabled/);
  assert.match(bcPlain('plugin', 'disable', 'remind').stdout, /remind disabled/);
  assert.equal(isEnabled('watch'), false);
  assert.match(bcPlain('watch', 'list').stderr, /unknown command 'watch'/);
  assert.match(bcPlain('remind', 'list').stderr, /unknown command 'remind'/);
  assert.match(
    bcPlain('plugin', 'list').stdout,
    /bc remind \(Reminders, switched off: bc plugin enable remind\), bc watch \(Watches, switched off: bc plugin enable watch\)/,
  );
  const told = spawnSync(
    process.execPath,
    [
      '-e',
      `
    const { loadPlugins } = await import('${root}src/plugins/registry.js'); await loadPlugins();
    const { runtimePrompt, helpText } = await import('${root}src/channels/commands.js');
    process.stdout.write(runtimePrompt({ surface: 'terminal' }) + '\\n=====\\n' + helpText());`,
    ],
    { encoding: 'utf8', env: plainEnv() },
  ).stdout;
  assert.ok(told.includes('## Memory') && told.includes('## Engine'), 'the rest is still there');
  for (const gone of ['## Watches', '## Reminders', 'watch briefing', 'blackcat remind', 'attach one to a reminder'])
    assert.ok(!told.includes(gone), gone);
  // the other parts cannot be switched off
  assert.match(bcPlain('plugin', 'disable', 'memory').stdout, /part of blackcat itself, not a plugin, so it can't be switched off/);
  // and back on: everything is as it was
  assert.match(bcPlain('plugin', 'enable', 'watch').stdout, /Watches enabled/);
  assert.match(bcPlain('plugin', 'enable', 'remind').stdout, /Reminders enabled/);
  assert.match(bcPlain('watch', 'list').stdout, /Things I need to do/);
});

// ---- databases: one way to open one, and it is always closed

// A database is opened in one place (src/db.js) and used through withDb, which closes it
// whatever happens. The two exceptions are written down here: a function whose job is to
// open one (it hands it back), and a service that keeps one for as long as it runs.
const KEPT_OPEN = {
  'src/agent/scheduler.js': 'the scheduler, for as long as the agent runs',
  'plugins/wa/service.js': 'the WhatsApp source, for as long as it runs',
  'plugins/tg/service.js': 'the Telegram source, for as long as it runs (the archive, and its requests)',
};
const sourceFiles = () =>
  spawnSync('git', ['ls-files', 'src', 'plugins'], { cwd: root, encoding: 'utf8' })
    .stdout.split('\n')
    .filter((f) => f.endsWith('.js'));

test('a database is opened through withDb, so that it is always closed', () => {
  const wrong = [];
  for (const f of sourceFiles()) {
    if (f === 'src/db.js') continue;
    const lines = fs.readFileSync(path.join(root, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const m = /^(\s*)(?:const|let|var) (\w+) = (?:await )?(open[A-Z]\w*)\(.*\);\s*$/.exec(line);
      if (!m || /withDb\(/.test(line) || !/(Db|Sqlite|Store|Archive|Index|Read|Write|ForWriting)$|^open(Write|Read|Base)$/.test(m[3]))
        return;
      // a function that opens one and hands it back
      const rest = lines.slice(i + 1, i + 14);
      const end = rest.findIndex((l) => l.trim() && !l.startsWith(m[1]));
      if ((end < 0 ? rest : rest.slice(0, end)).some((l) => l.startsWith(m[1]) && l.trimEnd().endsWith(`return ${m[2]};`))) return;
      if (KEPT_OPEN[f]) return;
      wrong.push(`${f}:${i + 1}  ${line.trim()}`);
    });
  }
  assert.deepEqual(wrong, [], 'use withDb(open, (db) => …) from src/db.js (plugins: from src/api.js); see docs/plugins.md, "Storing data"');
});

test('only src/db.js opens a database file itself, and nothing closes one by hand outside the exceptions', () => {
  const direct = [];
  const closes = [];
  for (const f of sourceFiles()) {
    if (f === 'src/db.js') continue;
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    if (/new Database\(|from 'better-sqlite3'/.test(text)) direct.push(f);
    if (!KEPT_OPEN[f])
      text
        .split('\n')
        .forEach((l, i) => /\b(db|adb|wdb|mdb|ix|archive|kept)\.close\(\)/.test(l) && closes.push(`${f}:${i + 1}  ${l.trim()}`));
  }
  assert.deepEqual(direct, [], 'open with openSqlite from src/db.js');
  assert.deepEqual(closes, [], 'withDb closes it');
});

// (The linter and the formatter are run by `npm test` itself, beside the test files: scripts/test.js.)

test('small helpers are written once: waiting, and a path with ~ in it', () => {
  const again = [];
  for (const f of sourceFiles()) {
    if (f.startsWith('src/util/')) continue;
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    if (/new Promise\(\((r|resolve)\) => setTimeout\(\1, /.test(text)) again.push(`${f}: use sleep() from the API`);
    if (/Atomics\.wait\(/.test(text)) again.push(`${f}: use pause() from src/util/wait.js`);
    if (/replace\(\/\^~/.test(text)) again.push(`${f}: use expandHome() or resolveHome() from the API`);
  }
  assert.deepEqual(again, []);
});

// ---- one style of command: it returns what it has to say, and does not print it

test('a command returns its result; none prints for itself or ends the process', () => {
  // Written down: what is interactive in a terminal (it asks as it goes, and may leave), and what serves a process of its own.
  const TALKS = ['src/watch/setup.js', 'src/engines/commands.js'];
  const wrong = [];
  for (const f of sourceFiles()) {
    if (
      !/^src\/(watch|reminders|checks|memory|conversations|activity|backup|archive\/commands|engines)\//.test(f) ||
      TALKS.includes(f) ||
      /\/(check|embed)\//.test(f)
    )
      continue;
    const text = fs.readFileSync(path.join(root, f), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    // (A word on the way, while it works, goes to stderr and is not its result: "indexing first…".)
    if (/console\.log\(/.test(text)) wrong.push(`${f} prints`);
    if (/process\.exit\(/.test(text)) wrong.push(`${f} ends the process`);
  }
  assert.deepEqual(
    wrong,
    [],
    'return { text, data } (or build the text with saying() from src/util/saying.js); src/plugins/cli.js prints it',
  );
});

test('how a result is printed: text for a person, data for --json; a list as the list it is; raw as it is', () => {
  fs.mkdirSync(path.join(dir, 'user-plugins/shapes'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'user-plugins/shapes/plugin.js'),
    `export default { api: 1, name: 'shapes', title: 'Shapes', description: 'x', commands: {
    both: { summary: 'x', access: 'allow', run: () => ({ text: 'two things', data: { n: 2 } }) },
    list: { summary: 'x', access: 'allow', run: () => ({ text: 'a, b', data: [{ id: 'a' }, { id: 'b' }] }) },
    raw: { summary: 'x', access: 'allow', run: () => ({ raw: true, text: 'as it is', data: { notice: 'its own notice', n: 1 } }) },
    quiet: { summary: 'x', access: 'allow', run: () => ({ text: '' }) },
    word: { summary: 'x', access: 'allow', run: () => 'just a sentence' },
  } };\n`,
  );
  const { save: put, load: get } = {
    save: (c) => fs.writeFileSync(path.join(dir, 'data/config.json'), JSON.stringify(c)),
    load: () => JSON.parse(fs.readFileSync(path.join(dir, 'data/config.json'), 'utf8')),
  };
  const was = get();
  put({ ...was, plugins: { ...was.plugins, enabled: [...(was.plugins?.enabled ?? []), 'shapes'] } });
  const out = (...a) => bcPlain('shapes', ...a).stdout;
  assert.equal(out('both'), 'two things\n');
  assert.deepEqual(JSON.parse(out('both', '--json')), { notice: JSON.parse(out('both', '--json')).notice, n: 2 });
  assert.match(JSON.parse(out('both', '--json')).notice, /UNTRUSTED/);
  assert.equal(out('list'), 'a, b\n');
  assert.deepEqual(JSON.parse(out('list', '--json')), [{ id: 'a' }, { id: 'b' }]);
  assert.deepEqual(JSON.parse(out('raw', '--json')), { notice: 'its own notice', n: 1 });
  assert.equal(out('quiet'), '', 'nothing to say prints nothing, not an empty line');
  assert.deepEqual(JSON.parse(out('word', '--json')), { text: 'just a sentence' });
  put(was);
});

test('a time or a date is written the same on every machine: never in the language the machine happens to be set to', () => {
  const loose = [];
  for (const f of sourceFiles()) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    text.split('\n').forEach((l, i) => {
      if (/toLocale(Time|Date)?String\(\s*(\[\]|undefined)?\s*[,)]/.test(l)) loose.push(`${f}:${i + 1}  ${l.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(loose, [], "name the locale ('en-GB'): the machine's own gives 4:36 PM on one and 16:36 on the next");
});
