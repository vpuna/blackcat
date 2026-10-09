// The agent's commands are handed to a process that is already loaded (src/agent/warm.js).
// That must change nothing but the wait: the same output, the same errors, the same exit
// code, run once and only once, and always as the agent.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { home, setUp } from './helpers.js';

const dir = home();
const root = new URL('..', import.meta.url).pathname;
const { load } = await import('../src/config.js');
await setUp({
  bot: { allow: [{ id: 42, name: 'me' }] },
  plugins: {
    enabled: ['host'],
    settings: { shortcut: { shortcuts: { hello: { description: 'says hello', run: ['echo hello from a shortcut'] } } } },
  },
});
const { startWarm, SOCKET } = await import('../src/agent/warm.js');
const warm = startWarm();
after(() => warm.stop());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ready(ms = 20_000) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (warm.ready()) return true;
    await sleep(25);
  }
  return false;
}
// (Not spawnSync: the waiting process is served from this test's own event loop.)
const run = (args, env = {}) =>
  new Promise((resolve) => {
    const c = spawn(process.execPath, [`${root}bin/bc.js`, ...args], {
      env: { ...process.env, BLACKCAT_CALLER: 'agent', ...env },
      cwd: dir,
    });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    c.on('close', (code) => resolve({ code, out, err }));
  });
const slow = (args) => run(args, { BLACKCAT_SLOW: '1' });
// Run it through the waiting process, making sure that is really what happened.
async function fast(args, env) {
  assert.ok(await ready(), 'a process is waiting');
  const before = warm.stats.handed;
  const r = await run(args, env);
  assert.equal(warm.stats.handed, before + 1, `"${args.join(' ')}" was handed over`);
  return r;
}

test('the same output, errors and exit code as starting the ordinary way', async () => {
  const cases = [
    ['--version'],
    ['--help'],
    ['remind', 'list', '--json'],
    ['remind', 'list'],
    ['watch', 'list', '--json'],
    ['watch', 'briefing', '--show'],
    ['shortcut', 'list'],
    ['hello'],
    ['host', '--help'],
    ['plugin', 'list'],
    ['plugin', 'info', 'watch'],
    ['permissions', '--json'],
    // things that go wrong
    ['no-such-command'],
    ['remind', 'add'],
    ['remind', 'add', 'x', '--at', 'gibberish'],
    ['watch', 'show', '999'],
    ['remind', '--nope'],
    ['watch', 'briefing', '--cron', 'bad'],
  ];
  for (const args of cases) {
    const a = await slow(args);
    const b = await fast(args);
    assert.deepEqual(b, a, `bc ${args.join(' ')}`);
  }
  assert.equal((await slow(['no-such-command'])).code, 1);
  assert.match((await slow(['hello'])).out, /hello from a shortcut/);
});

test('a command that changes something runs once, and only once', async () => {
  const count = async () => JSON.parse((await slow(['remind', 'list', '--json'])).out).length;
  const n = await count();
  const r = await fast(['remind', 'add', 'Only once', '--in', '2h', '--json']);
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).text, 'Only once');
  assert.equal(await count(), n + 1);
});

test('a lot of output arrives whole and in order', async () => {
  // (Put there directly: sixty commands would only be sixty waits.)
  const { openRemindersDb, addReminder } = await import('../src/reminders/db.js');
  const { withDb } = await import('../src/db.js');
  withDb(openRemindersDb, (db) => {
    for (let i = 0; i < 60; i++)
      addReminder(db, {
        chatId: 42,
        text: `Reminder number ${i} ${'x'.repeat(400)}`,
        dueTs: Math.floor(Date.now() / 1000) + (i + 2) * 3600,
      });
  });
  const a = await slow(['remind', 'list', '--json']);
  const b = await fast(['remind', 'list', '--json']);
  assert.ok(a.out.length > 30_000);
  assert.equal(b.out, a.out);
});

test('it is always the agent asking, whatever the request says', async () => {
  // `host mode` is for the owner only. Run by the agent it is refused, and a request that
  // claims otherwise is still the agent's.
  const a = await slow(['host', 'mode', 'full']);
  assert.notEqual(a.code, 0);
  const net = await import('node:net');
  assert.ok(await ready());
  const got = await new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    const s = net.createConnection(SOCKET, () =>
      s.write(`${JSON.stringify({ argv: ['host', 'mode', 'full'], cwd: dir, env: { ...process.env, BLACKCAT_CALLER: 'owner' } })}\n`),
    );
    s.on('data', (d) => {
      if (!buf.length && d[0] === 0x41) s.write('G');
      buf = Buffer.concat([buf, d]);
    });
    s.on('close', () => resolve(buf.toString('latin1')));
  });
  assert.match(got, /X\0\0\0\x011$/, 'it ended with a failure');
  assert.notEqual(load().plugins?.settings?.host?.mode, 'full', 'and nothing was changed');
});

test('when settings change, the next command still sees them', async () => {
  assert.ok(await ready());
  // a new shortcut is a new command: the process that was waiting has never heard of it
  const add = await slow(['shortcut', 'add', 'fresh', '--description', 'just added', '--run', 'echo brand new', '--json']);
  assert.equal(add.code, 0, add.err);
  const first = await run(['fresh']);
  assert.deepEqual([first.code, first.out.trim()], [0, 'brand new'], 'straight away, the ordinary way');
  const again = await fast(['fresh']);
  assert.deepEqual([again.code, again.out.trim()], [0, 'brand new'], 'and from then on through a process that knows it');
});

test('if the caller goes away mid-command, the command and what it started stop', async () => {
  const marker = path.join(dir, 'should-never-exist');
  await slow(['shortcut', 'add', 'slowly', '--description', 'takes a while', '--run', `sleep 3 && touch ${marker}`, '--json']);
  fs.rmSync(marker, { force: true }); // (a new shortcut is tried once when it is added)
  await run(['slowly', '--help']); // let the waiting process be replaced by one that knows it
  assert.ok(await ready());
  const before = warm.stats.handed;
  const c = spawn(process.execPath, [`${root}bin/bc.js`, 'slowly'], { env: { ...process.env, BLACKCAT_CALLER: 'agent' }, cwd: dir });
  for (const end = Date.now() + 10_000; warm.stats.handed === before && Date.now() < end;) await sleep(20);
  assert.equal(warm.stats.handed, before + 1);
  await sleep(700); // it is now in the middle of "sleep 3"
  c.kill('SIGKILL');
  await sleep(4000);
  assert.equal(fs.existsSync(marker), false, 'the step did not carry on by itself');
});

test('your own commands, and long-running ones, never go through it', async () => {
  assert.ok(await ready());
  const before = warm.stats.handed + warm.stats.declined;
  await run(['remind', 'list'], { BLACKCAT_CALLER: '' });
  await run(['logs', '--help']);
  await run(['chat', '--help']);
  await run(['service', '--help']);
  assert.equal(warm.stats.handed + warm.stats.declined, before);
});

test('with nothing waiting, a command starts the ordinary way at once', async () => {
  assert.ok(await ready());
  // two at the same moment: one is handed over, the other must not wait for the next spare
  const both = await Promise.all([0, 1].map(() => run(['remind', 'list', '--json'])));
  assert.deepEqual(
    both.map((b) => b.code),
    [0, 0],
  );
  assert.equal(both[0].out, both[1].out);
  // and with the service gone entirely
  warm.stop();
  await sleep(100);
  assert.equal(fs.existsSync(SOCKET), false);
  const r = await run(['remind', 'list', '--json']);
  assert.equal(r.code, 0);
  assert.equal(r.out, both[0].out);
});
