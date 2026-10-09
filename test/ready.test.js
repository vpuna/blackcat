// The conversation's `claude` process is started before it is needed and kept, so a message
// never waits for Claude Code to start. It is renewed when the instructions change, replaced
// after a long quiet spell, and brought back if it dies.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { SIGNED_IN, home } from './helpers.js';

const dir = home();
process.env.HOME = dir;
const { save, load } = await import('../src/config.js');
save({});
fs.mkdirSync(path.join(dir, 'agent'), { recursive: true });
fs.writeFileSync(path.join(dir, 'agent/AGENT.md'), 'Rules, first version.\n');

// A stand-in for `claude`: notes when it starts (and how), and answers with its process id.
const startsLog = path.join(dir, 'starts.log');
const fake = path.join(dir, 'fake-claude.mjs');
fs.writeFileSync(
  fake,
  `
import fs from 'node:fs'; import readline from 'node:readline';
const args = process.argv.slice(2);
const resumed = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null;
const session = resumed ?? 'sess-' + process.pid;
fs.appendFileSync(${JSON.stringify(startsLog)}, JSON.stringify({ pid: process.pid, resumed }) + '\\n');
let n = 0;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.type !== 'user') return;
  if (++n === 1) console.log(JSON.stringify({ type: 'system', subtype: 'init' }));
  console.log(JSON.stringify({ type: 'result', is_error: false, result: 'pid ' + process.pid + (resumed ? ' resumed' : ' new') + ' | ' + m.message.content.split('\\n').at(-1), session_id: session, total_cost_usd: 0.01 * n, usage: {} }));
});`,
);
fs.writeFileSync(path.join(dir, 'fake-bin/claude'), `#!/bin/sh\n${SIGNED_IN}exec ${process.execPath} ${fake} "$@"\n`, { mode: 0o755 });
// Claude Code keeps each conversation in a file of its own: pretend it has, for any session.
const engineDir = path.join(dir, '.claude/projects', path.join(dir, 'agent').replace(/[^A-Za-z0-9]/g, '-'));
fs.mkdirSync(engineDir, { recursive: true });

const brain = await import('../src/agent/brain.js');
const CHAT = 42;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const starts = () =>
  fs.existsSync(startsLog)
    ? fs
        .readFileSync(startsLog, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const until = async (fn, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (fn()) return true;
    await sleep(25);
  }
  return false;
};
const pidOf = (answer) => Number(/pid (\d+)/.exec(answer)[1]);
after(() => brain.stopAll());

test('it is started before anything is said, and that same process answers', async () => {
  assert.equal(await brain.prepare(CHAT), true);
  assert.ok(await until(() => starts().length === 1), 'a process is running before the first message');
  const a = await brain.reply(CHAT, 'hello');
  assert.equal(pidOf(a), starts()[0].pid);
  assert.match(a, / new \| hello$/);
  assert.equal(pidOf(await brain.reply(CHAT, 'again')), starts()[0].pid);
  assert.equal(starts().length, 1, 'no other was started');
});

test('it is not stopped for being quiet', async () => {
  brain.setTimings({ idleMs: 150, refreshMs: 60_000 });
  const pid = starts().at(-1).pid;
  await brain.reply(CHAT, 'one');
  await sleep(700); // well past what "idle" used to mean
  assert.equal(pidOf(await brain.reply(CHAT, 'two')), pid);
  assert.equal(starts().length, 1);
});

test('after a long quiet spell it is replaced by a fresh one, by itself, on the same conversation', async () => {
  const before = starts().at(-1).pid;
  const session = `sess-${before}`;
  fs.writeFileSync(path.join(engineDir, `${session}.jsonl`), '');
  brain.setTimings({ refreshMs: 300 });
  await brain.reply(CHAT, 'last thing before a long quiet');
  // The old one goes first, and its replacement is started a second later. The quiet spell is
  // made long again in between: left short, the replacement would itself be replaced while
  // this test was still looking at it (which it was, now and then, on a busy machine).
  const gone = () => {
    try {
      process.kill(before, 0);
      return false;
    } catch {
      return true;
    }
  };
  assert.ok(await until(gone, 6000), 'the old one was stopped');
  brain.setTimings({ refreshMs: 60_000 });
  assert.ok(await until(() => starts().length === 2, 6000), 'a new one was started without being asked');
  assert.deepEqual(starts()[1].resumed, session, 'it picks the same conversation up');
  const a = await brain.reply(CHAT, 'good morning');
  assert.equal(pidOf(a), starts()[1].pid, 'and it is the one that answers');
  assert.match(a, / resumed \| good morning$/);
  assert.equal(starts().length, 2);
});

test('when the instructions change, the next message gets a process that has them', async () => {
  const pid = starts().at(-1).pid;
  assert.equal(pidOf(await brain.reply(CHAT, 'same instructions')), pid, 'unchanged: the same process');
  fs.writeFileSync(path.join(dir, 'agent/AGENT.md'), 'Rules, second version.\n');
  const a = await brain.reply(CHAT, 'after the change');
  assert.notEqual(pidOf(a), pid);
  assert.match(a, /^\(My setup has changed since we last spoke/, 'and the owner is told it is a fresh conversation');
  assert.match(a, / new \| after the change$/);
  const now = pidOf(a);
  assert.equal(pidOf(await brain.reply(CHAT, 'and then')), now, 'which is then kept');
});

test('if it dies by itself, another is made ready', async () => {
  brain.setTimings({ minLifeMs: 0, respawnMs: 100 });
  const n = starts().length;
  const pid = starts().at(-1).pid;
  process.kill(pid, 'SIGKILL');
  assert.ok(await until(() => starts().length === n + 1, 6000), 'one was started again without a message');
  assert.equal(pidOf(await brain.reply(CHAT, 'still there?')), starts().at(-1).pid);
  // one that cannot stay up is not started over and over
  brain.setTimings({ minLifeMs: 60_000 });
  const m = starts().length;
  process.kill(starts().at(-1).pid, 'SIGKILL');
  await sleep(600);
  assert.equal(starts().length, m);
  assert.match(await brain.reply(CHAT, 'and now?'), /and now\?$/, 'the next message still starts one');
});

test('it can be switched off: then it stops after a quiet spell, as it used to', async () => {
  save({ ...load(), agent: { stayReady: false } });
  brain.setTimings({ idleMs: 200 });
  assert.equal(await brain.prepare(CHAT), false);
  const a = await brain.reply(CHAT, 'with it off');
  const n = starts().length;
  await sleep(900);
  let alive = true;
  try {
    process.kill(pidOf(a), 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false, 'stopped after being quiet');
  assert.equal(starts().length, n, 'and nothing was started in its place');
  assert.notEqual(pidOf(await brain.reply(CHAT, 'later')), pidOf(a));
});
