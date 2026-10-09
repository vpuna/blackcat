// Watches, reminders and checks are three parts, each with tables of its own. They reach
// each other through small interfaces, the core reaches them through hooks any part may
// declare, and none of them is named anywhere else. Any one can be switched off.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { home } from './helpers.js';

const dir = home();
const root = new URL('..', import.meta.url).pathname;
const src = (...where) =>
  spawnSync('git', ['ls-files', ...where], { cwd: root, encoding: 'utf8' })
    .stdout.split('\n')
    .filter((f) => f.endsWith('.js'));
const code = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/^\s*\/\/.*$/gm, '');
const { save, load } = await import('../src/config.js');
save({ plugins: { settings: { 'tg-bot': { owner: { chat: 42, name: 'Ana' }, allow: [42] } } } });
const { loadPlugins } = await import('../src/plugins/registry.js');
await loadPlugins();
const { withDb } = await import('../src/db.js');
const W = await import('../src/watch/db.js');
const R = await import('../src/reminders/db.js');
const N = await import('../src/reminders/nudges.js');
const now = () => Math.floor(Date.now() / 1000);

test("each part's tables are written only by that part", () => {
  const TABLES = {
    reminders: ['src/reminders/'],
    watch_items: ['src/watch/'],
    watches: ['src/watch/'],
    watch_seen: ['src/watch/'],
    checks: ['src/checks/'],
    check_incidents: ['src/checks/'],
  };
  // Written down, because each is a move of data from an older layout or onto another machine, not everyday use:
  const ALLOWED = {
    'src/checks/db.js': 'a check was once a kind of watch: the one move of those rows',
    'src/backup/manifest.js': 'a restore onto another machine corrects stored file paths',
  };
  const wrong = [];
  for (const f of src('src', 'plugins')) {
    if (ALLOWED[f]) continue;
    for (const [table, owners] of Object.entries(TABLES)) {
      if (owners.some((o) => f.startsWith(o))) continue;
      if (new RegExp(`(INSERT( OR \\w+)? INTO|UPDATE|DELETE FROM|FROM|JOIN)\\s+${table}\\b`).test(code(f)))
        wrong.push(`${f} reads or writes ${table}`);
    }
  }
  assert.deepEqual(wrong, []);
});

test('none of the three is named by the core or by a plugin: no import of their files, no asking after them by name', () => {
  const wrong = [];
  for (const f of src('src', 'plugins')) {
    if (/^src\/(watch|reminders|checks)\//.test(f) || f === 'src/internal.js' || f === 'src/plugins/registry.js') continue; // (the registry lists the parts there are; internal.js is what they share)
    const text = code(f);
    if (/['"](\.\.\/|\.\/)+(watch|reminders|checks)\/[\w.-]+['"]/.test(text)) wrong.push(`${f} imports one of them`);
    if (/p\.name === '(watch|remind|check)'|findLoaded\('(watch|remind|check)'\)/.test(text)) wrong.push(`${f} asks after one by name`);
  }
  // of the three, a watch uses the reminder queue through its nudge interface and nothing else of it
  for (const f of src('src/watch'))
    for (const m of code(f).matchAll(/['"]\.\.\/reminders\/([\w.-]+)['"]/g))
      if (m[1] !== 'nudges.js') wrong.push(`${f} imports reminders/${m[1]}`);
  for (const f of src('src/reminders')) if (/['"]\.\.\/(watch|checks)\//.test(code(f))) wrong.push(`${f} imports a watch or a check`);
  for (const f of src('src/checks')) if (/['"]\.\.\/(watch|reminders)\//.test(code(f))) wrong.push(`${f} imports a watch or a reminder`);
  assert.deepEqual(wrong, []);
});

let watch;
let item;
test('a nudge is set, moved and cancelled for an entry through the interface alone; one that has gone out is never set again', () => {
  withDb(W.openWatchDb, (db) => {
    watch = W.addWatch(db, { chatId: 42, name: 'Trips', lookFor: 'x', sources: { everywhere: 'all' }, mode: 'digest' });
    item = W.addItem(db, { watchId: watch.id, title: 'Book the ferry' });
    assert.equal(N.pendingNudge(db, item.id), undefined);
    assert.equal(
      N.setNudgeFor(db, item.id, { chatId: 42, text: 'Book the ferry', dueTs: now() + 3600, note: 'from your "Trips" list' }),
      'made',
    );
    const made = N.pendingNudge(db, item.id);
    assert.deepEqual(
      [made.text, R.getReminder(db, made.id).source, R.getReminder(db, made.id).item_id],
      ['Book the ferry', 'auto', item.id],
    );
    assert.equal(N.setNudgeFor(db, item.id, { chatId: 42, text: 'Book the ferry · Fri', dueTs: now() + 7200 }), 'moved');
    assert.deepEqual(
      [N.pendingNudge(db, item.id).id, N.pendingNudge(db, item.id).text],
      [made.id, 'Book the ferry · Fri'],
      'the same one, moved',
    );
    assert.equal(N.cancelNudges(db, [item.id, 99999]), 1);
    assert.equal(N.pendingNudge(db, item.id), undefined);
    assert.equal(N.setNudgeFor(db, item.id, { chatId: 42, text: 'Book the ferry', dueTs: now() + 60 }), 'made');
    R.setStatus(db, N.pendingNudge(db, item.id).id, 'sent');
    assert.equal(N.wasNudged(db, item.id), true);
    assert.equal(N.setNudgeFor(db, item.id, { chatId: 42, text: 'again', dueTs: now() + 60 }), 'already');
    assert.equal(N.cancelNudges(db, []), 0);
  });
});

test('done with a nudge ticks the entry off its list: reminders tell whoever set it, and do not touch its table', () => {
  withDb(W.openWatchDb, (db) => {
    const r = db.prepare('SELECT id FROM reminders WHERE item_id = ?').pluck().get(item.id);
    assert.equal(W.getItem(db, item.id).status, 'new');
    R.setStatus(db, r, 'done');
    assert.equal(W.getItem(db, item.id).status, 'done');
    // the other way: the entry dealt with settles what was sent or waiting about it
    const other = W.addItem(db, { watchId: watch.id, title: 'Renew the pass' });
    N.setNudgeFor(db, other.id, { chatId: 42, text: 'Renew the pass', dueTs: now() + 60 });
    W.setItemStatus(db, other.id, 'dropped');
    assert.equal(db.prepare('SELECT status FROM reminders WHERE item_id = ?').pluck().get(other.id), 'cancelled');
    // a reminder the owner set themselves is nobody's nudge
    const own = R.addReminder(db, { chatId: 42, text: 'Call the bank', dueTs: now() + 60 });
    R.setStatus(db, own.id, 'done');
    assert.equal(R.getReminder(db, own.id).status, 'done');
  });
});

test('a part that fails when told a nudge is done does not stop the reminder being marked', async () => {
  fs.mkdirSync(path.join(dir, 'user-plugins/clumsy'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'user-plugins/clumsy/plugin.js'),
    "export default { api: 1, name: 'clumsy', title: 'Clumsy', description: 'x', commands: { hello: { summary: 'x', access: 'allow', run: () => 'x' } }, nudgeDone: () => { throw new Error('dropped it'); } };\n",
  );
  save({ ...load(), plugins: { ...load().plugins, enabled: ['clumsy'] } });
  await loadPlugins();
  withDb(W.openWatchDb, (db) => {
    const it = W.addItem(db, { watchId: watch.id, title: 'Water the plants' });
    N.setNudgeFor(db, it.id, { chatId: 42, text: 'Water the plants', dueTs: now() + 60 });
    const id = N.pendingNudge(db, it.id).id;
    assert.equal(R.setStatus(db, id, 'done'), 1);
    assert.equal(R.getReminder(db, id).status, 'done');
    assert.equal(W.getItem(db, it.id).status, 'done', 'and the part that could, did its own');
  });
});

test('when the owner is reached somewhere else, all three move with them: checks too', async () => {
  const C = await import('../src/checks/db.js');
  const check = withDb(C.openChecksDb, (db) =>
    C.addCheck(db, { chatId: 42, name: 'Camera', lookFor: '', command: 'true', every: ['*/20 * * * *'] }),
  );
  const { loaded, makeCtx } = await import('../src/plugins/registry.js');
  let moved = 0;
  for (const p of loaded()) if (p.manifest.ownerMoved) moved += await p.manifest.ownerMoved(makeCtx(p), { from: 42, to: 77 });
  withDb(W.openWatchDb, (db) => {
    assert.equal(db.prepare('SELECT chat_id FROM watches WHERE id = ?').pluck().get(watch.id), 77);
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM watches WHERE chat_id = 42').pluck().get() +
        db.prepare('SELECT COUNT(*) FROM reminders WHERE chat_id = 42').pluck().get(),
      0,
      'nothing is left where the owner was',
    );
    assert.ok(db.prepare('SELECT COUNT(*) FROM reminders WHERE chat_id = 77').pluck().get() > 0);
    assert.equal(db.prepare('SELECT chat_id FROM checks WHERE id = ?').pluck().get(check.id), 77);
  });
  assert.ok(moved >= 3);
  assert.deepEqual(
    loaded()
      .filter((p) => p.manifest.ownerMoved)
      .map((p) => p.name)
      .sort(),
    ['check', 'remind', 'watch'],
  );
});

test('a file the owner sent is kept for as long as a reminder or an entry on a list carries it', async () => {
  const { loaded, makeCtx } = await import('../src/plugins/registry.js');
  withDb(W.openWatchDb, (db) => {
    R.addReminder(db, { chatId: 77, text: 'Look at this', dueTs: now() + 60, file: '/inbox/letter.pdf' });
    W.addItem(db, { watchId: watch.id, title: 'A wish', file: '/inbox/perfume.jpg' });
    const gone = W.addItem(db, { watchId: watch.id, title: 'Dealt with', file: '/inbox/old.jpg' });
    W.setItemStatus(db, gone.id, 'done');
  });
  const keep = new Set();
  for (const p of loaded()) if (p.manifest.inboxKeeps) for (const f of await p.manifest.inboxKeeps(makeCtx(p))) keep.add(f);
  assert.deepEqual([...keep].sort(), ['/inbox/letter.pdf', '/inbox/perfume.jpg']);
});

test('what was waiting, with nowhere to send it, is handed over by the part that had it', async () => {
  const { loaded, makeCtx } = await import('../src/plugins/registry.js');
  withDb(R.openRemindersDb, (db) => R.addReminder(db, { chatId: 77, text: 'Take the bins out', dueTs: now() - 120 }));
  const said = [];
  for (const p of loaded()) if (p.manifest.waiting) said.push([p.name, await p.manifest.waiting(makeCtx(p))]);
  assert.deepEqual(
    said.map((s) => s[0]),
    ['remind'],
  );
  assert.match(said[0][1].heading, /A reminder came due|reminders came due/);
  assert.ok(said[0][1].lines.some((l) => l.text === 'Take the bins out' && /bc remind done \d+/.test(l.note)));
  for (const p of loaded()) if (p.manifest.waiting) assert.equal(await p.manifest.waiting(makeCtx(p)), null, 'handed over once');
});

test('any one of the three switched off leaves the other two working', () => {
  const { FORCE_COLOR: _f, ...env } = process.env;
  const bc = (...a) => spawnSync(process.execPath, [`${root}bin/bc.js`, ...a], { encoding: 'utf8', env, timeout: 60_000 });
  const works = { watch: ['watch', 'list', '--json'], remind: ['remind', 'list', '--json'], check: ['check', 'list', '--json'] };
  for (const off of Object.keys(works)) {
    save({ ...load(), plugins: { ...load().plugins, disabled: [off] } });
    for (const [name, cmd] of Object.entries(works)) {
      const r = bc(...cmd);
      if (name === off) assert.notEqual(r.status, 0, `${name} is off`);
      else assert.equal(r.status, 0, `with ${off} off, ${name}: ${r.stderr}`);
    }
    assert.equal(bc('status').status, 0, `status with ${off} off`);
  }
  save({ ...load(), plugins: { ...load().plugins, disabled: [] } });
});

// ---- no plugin is named by the core: what it needs, a plugin declares

test("a plugin's private folder is kept from the agent by name, whether or not the plugin is switched on; nothing of the kind is written into the policy", async () => {
  fs.mkdirSync(path.join(dir, 'user-plugins/sms'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'user-plugins/sms/plugin.js'),
    `export default { api: 1, name: 'sms', title: 'Texts', description: 'x', privateData: ['sms-account', 'sms.db'],
    services: [{ id: 'smsd', summary: 'reads texts', command: 'run' }],
    commands: { run: { summary: 'x', access: 'owner', run: () => 'x' }, pair: { summary: 'x', access: 'owner', interactive: true, run: () => 'x' }, list: { summary: 'x', access: 'allow', run: () => 'x' } } };\n`,
  );
  const r = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    const { save, load } = await import(${JSON.stringify(`${root}src/config.js`)});
    save({ plugins: { enabled: ['sms'], disabled: ['wa'] } });
    await (await import(${JSON.stringify(`${root}src/plugins/registry.js`)})).loadPlugins();
    const { decide } = await import(${JSON.stringify(`${root}src/agent/policy.js`)});
    const act = (command) => decide('Bash', { command }).action;
    console.log(JSON.stringify({
      declared: ['cat ../data/sms-account/session', 'cd ..; cat da*/sms-account/s*', 'X=sms-account; ls $X', 'sqlite3 sms.db .dump', 'cp sms.db-wal /tmp/x', 'systemctl --user stop blackcat-smsd', 'blackcat sms pair', 'echo hi && blackcat sms run'].map(act),
      offStillPrivate: ['cat ../data/wa-auth/creds.json', 'ls wa-auth', 'blackcat wa pair', 'systemctl --user restart blackcat-wa'].map(act),
      fine: ['blackcat sms list', 'echo sms-accounts-are-fun'].map(act),
    }));`,
    ],
    { encoding: 'utf8', env: process.env },
  );
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.deepEqual(got.declared, Array(8).fill('deny'));
  assert.deepEqual(got.offStillPrivate, Array(4).fill('deny'), 'WhatsApp switched off: its login is as private as before');
  assert.deepEqual(got.fine, ['allow', 'ask'], "a command it may run still runs; a word that only resembles the name is nobody's");
  const policy = code('src/agent/policy.js');
  for (const name of ['wa-auth', 'tg-account', 'mail\\.db', 'blackcat-\\(agent\\|wa\\|tg\\)', 'tg\\\\s'])
    assert.doesNotMatch(policy, new RegExp(name), `the policy does not spell out ${name}`);
});

test('the core names no plugin where it could ask instead', () => {
  const wrong = [];
  for (const f of src('src')) {
    if (f === 'src/plugins/registry.js' || f === 'src/owner.js') continue; // (where settings from before these were plugins are carried over)
    // (`wa` and `tg` as the archive's two own kinds of message id are not plugins: a message's kind is compared freely.)
    const text = code(f);
    for (const m of text.matchAll(
      /(?:name === |findLoaded\()'(tg-bot|tg|wa|shortcut|voice|ssh|ha|mail|unifi|allsky|host|calendar|claude-code)'/g,
    ))
      wrong.push(`${f}: ${m[0]}`);
    if (/GrammyError/.test(text)) wrong.push(`${f}: knows a chat library's errors`);
  }
  assert.deepEqual(wrong, []);
});

test('a plugin gives some of its commands a word of their own at the top; a word already taken stays with whoever had it', () => {
  fs.mkdirSync(path.join(dir, 'user-plugins/words'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'user-plugins/words/plugin.js'),
    `export default { api: 1, name: 'words', title: 'Words', description: 'x',
    commands: { say: { summary: 'says it', access: 'allow', usage: '<what>', run: (ctx, i) => 'said ' + i.what } },
    aliases: () => [{ name: 'hello', description: 'says hello', command: 'say', input: { what: 'hello' } }, { name: 'status', command: 'say', input: { what: 'taken' } }, { name: 'Bad Name', command: 'say' }, { name: 'nowhere', command: 'missing' }] };\n`,
  );
  save({ ...load(), plugins: { ...load().plugins, enabled: ['words'], disabled: [] } });
  const { FORCE_COLOR: _f, ...env } = process.env;
  const bc = (...a) => spawnSync(process.execPath, [`${root}bin/bc.js`, ...a], { encoding: 'utf8', env, timeout: 60_000 });
  assert.equal(bc('hello').stdout.trim(), 'said hello');
  assert.doesNotMatch(bc('status').stdout, /said taken/);
  assert.notEqual(bc('nowhere').status, 0);
});

test('an error a plugin knows better is said in its words; anything else as it is', async () => {
  const { errMsg, explainErrors } = await import('../src/api.js');
  assert.equal(errMsg(new Error('plain')), 'plain');
  explainErrors((e) => (e?.name === 'PagerError' ? `The pager said no (${e.code}).` : null));
  explainErrors(() => {
    throw new Error('an explainer that fails is passed over');
  });
  assert.equal(errMsg(Object.assign(new Error('raw'), { name: 'PagerError', code: 7 })), 'The pager said no (7).');
  assert.equal(errMsg(new Error('plain')), 'plain');
  // Telegram's own are the Telegram bot plugin's to explain, once it is loaded
  assert.equal(
    errMsg({ name: 'GrammyError', error_code: 401, description: 'Unauthorized' }),
    'Telegram rejected the token (401 Unauthorized).',
  );
});
