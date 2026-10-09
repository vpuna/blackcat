// The activity record: what blackcat did and what it used. It must capture every call to
// Claude and every command the agent ran (with how it was allowed), cost almost nothing,
// never hold what was said, and never get in the way of the thing it records.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { SIGNED_IN, home, setUp } from './helpers.js';

const dir = home();
const root = new URL('..', import.meta.url).pathname;
const { save, load } = await import('../src/config.js');
await setUp({ bot: { allow: [{ id: 42, name: 'me' }] } });
const set = (activity) => save({ ...load(), activity });
const log = await import('../src/activity/log.js');
const { record, recent, totals, commandText, commandCategory, clear } = log;
// How Claude Code's own report is read is its plugin's business; what is kept is the same for any engine.
const { usageOf: fromClaude } = await import('../plugins/claude-code/usage.js');

// What Claude Code reports at the end of a call (trimmed from a real one).
const RESULT = {
  type: 'result',
  is_error: false,
  result: 'SECRET ANSWER TEXT',
  session_id: 's1',
  duration_ms: 4200,
  duration_api_ms: 3900,
  num_turns: 3,
  stop_reason: 'end_turn',
  total_cost_usd: 0.0421,
  usage: {
    input_tokens: 12,
    cache_creation_input_tokens: 800,
    cache_read_input_tokens: 9000,
    output_tokens: 150,
    output_tokens_details: { thinking_tokens: 40 },
    iterations: [{ input_tokens: 4, cache_read_input_tokens: 9000, cache_creation_input_tokens: 800, output_tokens: 150 }],
  },
  modelUsage: {
    'claude-sonnet-5-5': { costUSD: 0.04, contextWindow: 200000 },
    'claude-haiku-4-5': { costUSD: 0.0021, contextWindow: 200000 },
  },
  permission_denials: [{ tool_name: 'Bash' }],
  terminal_reason: 'completed',
};

test('a call to Claude is read into tokens, model, cost and time', () => {
  const c = fromClaude(RESULT);
  assert.deepEqual(
    [c.ok, c.model, c.tokensIn, c.tokensOut, c.cacheRead, c.cacheWrite, c.cost],
    [true, 'claude-sonnet-5-5', 12, 150, 9000, 800, 0.0421],
  );
  assert.deepEqual(c.data, {
    claudeMs: 4200,
    apiMs: 3900,
    steps: 3,
    thinking: 40,
    refused: 1,
    models: { 'claude-sonnet-5-5': 0.04, 'claude-haiku-4-5': 0.0021 },
    contextUsed: 4.9,
  });
  assert.equal(fromClaude({ ...RESULT, stop_reason: 'max_tokens', is_error: true }).data.stopped, 'max_tokens');
  assert.equal(fromClaude(null).ok, true); // nothing to read is not a crash
  assert.doesNotMatch(JSON.stringify(c), /SECRET ANSWER/, 'the answer itself is not part of it');
});

test('entries are kept, counted per day, and read back newest first', () => {
  record({ kind: 'model', category: 'chat', surface: 'chat', ms: 5000, ...fromClaude(RESULT) });
  record({ kind: 'model', category: 'watch: School', ms: 3000, ...fromClaude(RESULT) });
  record({ kind: 'command', category: 'blackcat msg', ok: false, ms: 120, summary: 'blackcat msg find …', data: { decision: 'allowed' } });
  for (let i = 0; i < 50; i++) record({ kind: 'job', category: 'mail/sync', ms: 900, countOnly: true });
  record({ kind: 'job', category: 'mail/sync', ms: 2000, summary: 'home: 2 new, 1 kept' });
  record({ kind: 'nonsense', category: 'x' });

  const all = recent({ limit: 100 });
  assert.equal(all.length, 4, 'the fifty idle runs are counted, not listed');
  assert.deepEqual(
    all.map((e) => e.kind),
    ['job', 'command', 'model', 'model'],
  );
  assert.equal(recent({ failed: true }).length, 1);
  assert.equal(recent({ kind: 'model', category: 'school' })[0].category, 'watch: School');

  const byCat = totals({ days: 1, by: 'category' });
  assert.deepEqual(byCat.rows.map((r) => [r.name, r.n]).sort(), [
    ['chat', 1],
    ['watch: School', 1],
  ]);
  assert.equal(byCat.rows[0].cacheRead, 9000);
  const byKind = Object.fromEntries(totals({ days: 1, by: 'kind' }).rows.map((r) => [r.name, r]));
  assert.deepEqual([byKind.model.n, byKind.command.n, byKind.command.failed, byKind.job.n], [2, 1, 1, 51]);
  assert.equal(Math.round(byKind.model.cost * 10000), 842);
  assert.deepEqual(
    totals({ days: 1, by: 'model' }).rows.map((r) => r.name),
    ['claude-sonnet-5-5'],
  );
});

test('how much of a command is kept', () => {
  const find = "blackcat msg find 'who did not go to space' --also 'astronaut' --since 30d --json";
  assert.equal(commandText(find), 'blackcat msg find … --also --since --json', 'what was asked is not kept');
  assert.equal(commandText(find, { full: true }), find, 'unless it needed your say, was refused or failed');
  assert.equal(commandText('blackcat remind list --json'), 'blackcat remind list --json');
  assert.equal(commandText("ssh nas 'cat /etc/passwd'"), 'ssh …');
  assert.equal(commandText('/usr/bin/df'), 'df');
  set({ commands: 'full' });
  assert.equal(commandText(find), find);
  set({ commands: 'short' });
  assert.equal(commandText(find, { full: true }), 'blackcat msg find … --also --since --json');
  set({ commands: 'off' });
  assert.equal(record({ kind: 'command', category: 'x', summary: 'y' }), null);
  assert.ok(record({ kind: 'event', category: 'x', summary: 'still recorded' }));
  set({});
  assert.deepEqual(
    [
      commandCategory('Bash', { command: 'blackcat msg find x' }),
      commandCategory('Bash', { command: 'blackcat --version' }),
      commandCategory('Bash', { command: '/usr/bin/ssh nas ls' }),
      commandCategory('Read', {}),
    ],
    ['blackcat msg', 'blackcat', 'ssh', 'read a file'],
  );
});

test('switched off, nothing is recorded; old entries age out but daily totals stay', () => {
  const before = recent({ limit: 500 }).length;
  set({ on: false });
  assert.equal(record({ kind: 'event', category: 'x', summary: 'no' }), null);
  assert.equal(recent({ limit: 500 }).length, before);
  set({ days: 30 });
  const old = Math.floor(Date.now() / 1000) - 40 * 86400;
  record({ kind: 'model', category: 'chat', ts: old, ...fromClaude(RESULT) });
  assert.equal(recent({ limit: 500 }).filter((e) => e.ts === old).length, 1);
  // the daily tidy-up runs once a day: make it think it has not run today
  const Database =
    fs.existsSync(path.join(dir, 'data/agent.db')) &&
    spawnSync(process.execPath, [
      '-e',
      `const D=require('${root}node_modules/better-sqlite3');const d=new D('${dir}/data/agent.db');d.prepare("DELETE FROM meta WHERE key='activity_pruned'").run()`,
    ]);
  assert.equal(Database.status, 0);
  record({ kind: 'event', category: 'x', summary: 'triggers the tidy-up' });
  assert.equal(recent({ limit: 500 }).filter((e) => e.ts === old).length, 0, 'the 40-day-old entry is gone');
  assert.ok(totals({ days: 60, by: 'day' }).rows.length >= 2, 'its day is still in the totals');
});

test('recording never gets in the way', () => {
  assert.equal(record(null), null);
  assert.equal(
    record({
      kind: 'event',
      category: {
        toString() {
          throw new Error('boom');
        },
      },
    }),
    null,
  );
  const id = record({
    kind: 'event',
    category: 'x'.repeat(500),
    summary: 'y'.repeat(5000),
    data: { big: 'z'.repeat(10_000) },
    ms: 'not a number',
  });
  assert.ok(id);
  const e = recent({ limit: 1 })[0];
  assert.ok(e.category.length <= 80 && e.summary.length <= 400);
});

test('a single-question call to Claude records what it was for and what it used, not what was said', async () => {
  fs.writeFileSync(path.join(dir, 'fake-bin/claude'), `#!/bin/sh\n${SIGNED_IN}cat >/dev/null\necho '${JSON.stringify(RESULT)}'\n`, {
    mode: 0o755,
  });
  clear();
  const { askModel, askModelAbout } = await import('../src/agent/oneshot.js');
  assert.equal(
    await askModel('SYSTEM PROMPT TEXT', 'A PRIVATE MESSAGE', 'sonnet', { category: 'watch: School', reader: 'watch/list' }),
    'SECRET ANSWER TEXT',
  );
  await askModelAbout('SYSTEM', { type: 'image', source: {} }, 'what is this', 'sonnet', { category: 'attachments' });
  await askModel('SYSTEM', 'x', 'sonnet'); // nobody said what for
  const got = recent({ kind: 'model' });
  assert.deepEqual(
    got.map((e) => e.category),
    ['reader', 'attachments', 'watch: School'],
  );
  const e = got[2];
  assert.deepEqual(
    [e.model, e.tokens_out, e.cache_read, e.data.reader, e.data.sentChars, e.surface],
    ['claude-sonnet-5-5', 150, 9000, 'watch/list', 35, 'job'],
  );
  assert.equal(got[1].data.file, 'image');
  assert.doesNotMatch(JSON.stringify(got), /PRIVATE MESSAGE|SECRET ANSWER|SYSTEM PROMPT/);
  // a call that fails is recorded as failed
  fs.writeFileSync(path.join(dir, 'fake-bin/claude'), `#!/bin/sh\n${SIGNED_IN}cat >/dev/null\nexit 1\n`, { mode: 0o755 });
  await assert.rejects(() => askModel('S', 'x', 'sonnet', { category: 'watch: School' }));
  assert.deepEqual([recent({ failed: true })[0].category, recent({ failed: true })[0].ok], ['watch: School', false]);
});

test('scheduled work: a run that did something is listed, one that found nothing is only counted, a failure is marked', () => {
  fs.mkdirSync(path.join(dir, 'user-plugins/chores'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'user-plugins/chores/plugin.js'),
    `export default { api: 1, name: 'chores', title: 'Chores', description: 'test jobs',
    commands: { hi: { summary: 'hi', access: 'allow', run: () => 'hi' } },
    jobs: [{ id: 'idle', cron: '0 * * * *', run: () => ({ idle: true }) }, { id: 'busy', cron: '0 * * * *', run: () => ({ did: 'swept 3 rooms' }) },
      { id: 'plain', cron: '0 * * * *', run: () => {} }, { id: 'broken', cron: '0 * * * *', run: () => { throw new Error('the mop broke'); } }] };`,
  );
  save({ ...load(), plugins: { enabled: ['chores'] } });
  clear();
  const job = (id) =>
    spawnSync(process.execPath, [`${root}bin/bc.js`, 'plugin', 'job', 'chores', id], { encoding: 'utf8', env: process.env }).status;
  assert.deepEqual([job('idle'), job('idle'), job('busy'), job('plain')], [0, 0, 0, 0]);
  assert.notEqual(job('broken'), 0);
  const got = recent({ kind: 'job' });
  assert.deepEqual(
    got.map((e) => [e.category, e.ok, e.summary]),
    [
      ['chores/broken', false, 'failed: the mop broke'],
      ['chores/plain', true, null],
      ['chores/busy', true, 'swept 3 rooms'],
    ],
  );
  assert.equal(totals({ days: 1, by: 'category', kind: 'job' }).rows.find((r) => r.name === 'chores/idle').n, 2);
});

test('the commands that read it back', () => {
  const bc = (...a) => spawnSync(process.execPath, [`${root}bin/bc.js`, ...a], { encoding: 'utf8', env: process.env });
  const r = JSON.parse(bc('activity', 'recent', '--kind', 'job', '--json').stdout);
  assert.equal(r.entries.length, 3);
  assert.equal(r.entries[0].summary, 'failed: the mop broke');
  assert.equal(JSON.parse(bc('activity', 'recent', '--failed', '--since', '1h', '--json').stdout).entries.length, 1);
  const u = JSON.parse(bc('activity', 'usage', '--by', 'kind', '--json').stdout);
  assert.equal(u.rows.find((x) => x.kind === 'job').calls, 5);
  assert.match(bc('activity', 'status').stdout, /entries kept/);
  assert.match(bc('activity', 'settings').stdout, /never recorded: what was said/);
  assert.match(bc('activity', 'recent').stdout, /chores\/busy: swept 3 rooms/);
  // the agent may read it, may not clear it, and needs approval to change what is recorded
  const asAgent = (...a) =>
    spawnSync(process.execPath, [`${root}bin/bc.js`, ...a], {
      encoding: 'utf8',
      env: { ...process.env, BLACKCAT_CALLER: 'agent', BLACKCAT_SLOW: '1' },
    });
  assert.equal(asAgent('activity', 'recent', '--json').status, 0);
  assert.notEqual(asAgent('activity', 'clear').status, 0);
  assert.equal(JSON.parse(bc('activity', 'recent', '--json').stdout).entries.length > 0, true, 'still there');
});

test('a chat turn: every command is recorded with how it was allowed, and the turn with what it used', async () => {
  fs.writeFileSync(
    path.join(dir, 'fake-bin/claude'),
    `#!/bin/sh\n${SIGNED_IN}exec ${process.execPath} ${new URL('./support/fake-claude-session.mjs', import.meta.url).pathname}\n`,
    { mode: 0o755 },
  );
  fs.mkdirSync(path.join(dir, 'agent'), { recursive: true }); // the folder a conversation starts in
  clear();
  const brain = await import('../src/agent/brain.js');
  await (await import('../src/plugins/registry.js')).loadPlugins(); // the rules know each command's access from its plugin
  // You are asked about the delete and about reading a file; you take a moment, refuse the
  // first and allow the second.
  const asked = [];
  brain.setApprover(async (req) => {
    asked.push(req.tool);
    await new Promise((r) => setTimeout(r, 120));
    return req.tool === 'Read' ? { allow: true } : { allow: false, note: 'you said no' };
  });
  const answer = await brain.reply(brain.TERMINAL, 'A PRIVATE QUESTION');
  assert.match(answer, /PRIVATE REPLY/);
  assert.deepEqual(
    asked,
    ['Bash', 'Read'],
    'the delete and the file needed asking; the watch command did not, and the key was refused outright',
  );

  const cmds = recent({ kind: 'command' }).reverse();
  assert.deepEqual(
    cmds.map((c) => [c.category, c.ok]),
    [
      ['blackcat watch', true],
      ['rm', false],
      ['cat', false],
      ['read a file', true],
    ],
  );
  // an ordinary allowed command: what was run, not with what
  assert.equal(cmds[0].summary, 'blackcat watch show … --status --json');
  assert.equal(cmds[0].data.decision, 'allowed');
  // declined by you: kept in full, with how long you took
  assert.equal(cmds[1].summary, 'rm -rf /tmp/some-folder');
  assert.match(cmds[1].data.decision, /^declined: you said no/);
  assert.ok(cmds[1].data.waitedForYouMs >= 100);
  // refused by the rules: kept in full, with why
  assert.equal(cmds[2].summary, 'cat /home/someone/.ssh/id_ed25519');
  assert.match(cmds[2].data.decision, /^refused by policy: /);
  assert.equal(cmds[3].summary, 'Read /etc/hostname');
  assert.equal(cmds[3].data.decision, 'approved by you');

  const [turn] = recent({ kind: 'model' });
  assert.deepEqual(
    [turn.category, turn.surface, turn.model, turn.tokens_out, turn.cache_read, turn.cost],
    ['chat', 'terminal', 'claude-opus-5-5', 300, 30000, 0.05],
  );
  assert.equal(turn.data.commands, 2, 'two commands actually ran');
  assert.equal(turn.data.newConversation, true);
  assert.ok(turn.data.waitedForYouMs >= 200 && turn.ms >= turn.data.waitedForYouMs, 'both waits are counted');
  assert.equal(turn.data.steps, 5);
  // Two more turns in the same conversation. Claude Code reports cost as a running total
  // there (0.05, then 0.07, then 0.09): each turn is recorded with its own share.
  await brain.reply(brain.TERMINAL, 'ANOTHER PRIVATE QUESTION');
  await brain.reply(brain.TERMINAL, 'AND ANOTHER');
  brain.stopAll();
  const turns = recent({ kind: 'model' }).reverse();
  assert.deepEqual(
    turns.map((t) => Math.round(t.cost * 100)),
    [5, 2, 2],
  );
  assert.deepEqual(
    turns.map((t) => !!t.data.newConversation),
    [true, false, false],
  );
  assert.equal(
    Math.round(totals({ days: 1, by: 'category' }).rows.find((r) => r.name === 'chat').cost * 100),
    9,
    'the day adds up to what was really used',
  );

  // nothing that was said is anywhere in the record
  const everything = JSON.stringify(recent({ limit: 100 }));
  assert.doesNotMatch(everything, /PRIVATE/);
});
