// The tools are blackcat's (docs/plugins.md, "Engines", phase 2): Claude Code is started with none of
// its own, a call to a tool arrives in blackcat, is put to the policy, and is carried out
// there. These tests run real conversations through that path, with a stand-in for
// `claude` that speaks its side of it, and hold the one thing that matters: nothing is
// done that the policy did not allow, because there is nowhere else for it to be done.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { SIGNED_IN, home } from './helpers.js';

const dir = home();
process.env.HOME = dir;
const root = new URL('..', import.meta.url).pathname;
const startLog = path.join(dir, 'claude-starts.log');
process.env.FAKE_CLAUDE_LOG = startLog;
fs.writeFileSync(
  path.join(dir, 'fake-bin/claude'),
  `#!/bin/sh\n${SIGNED_IN}exec ${process.execPath} ${root}test/support/fake-claude-served.mjs "$@"\n`,
  { mode: 0o755 },
);
const agent = path.join(dir, 'agent');
fs.mkdirSync(agent, { recursive: true });
fs.writeFileSync(path.join(agent, 'AGENT.md'), 'Rules.\n');
fs.mkdirSync(path.join(dir, 'data/plugins/x'), { recursive: true });
fs.writeFileSync(path.join(dir, 'data/plugins/x/secrets.json'), '{"token":"S3CRET"}');
fs.mkdirSync(path.join(dir, 'data/inbox'), { recursive: true });
fs.writeFileSync(path.join(dir, 'data/inbox/from-someone.txt'), 'a file somebody sent\n');

const { save, load } = await import('../src/config.js');
// (One of three ways Claude Code can be run: see plugins/claude-code/run.js. This file is about this one.)
save({ engine: { chat: { options: { tools: 'blackcat' } } } });
await (await import('../src/plugins/registry.js')).loadPlugins();
const brain = await import('../src/agent/brain.js');
const activity = await import('../src/activity/log.js');
after(() => brain.stopAll());
const starts = () =>
  fs
    .readFileSync(startLog, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
const CHAT = 42;
const made = path.join(dir, 'made-by-a-command');
const DO = (tool, input) => `DO ${tool} ${JSON.stringify(input)}`;

test("Claude Code is started with no tools of its own, and blackcat's served to it", async () => {
  assert.equal(await brain.reply(CHAT, 'hello'), 'heard: hello');
  const s = starts().at(-1);
  assert.equal(s.tools, '', 'no shell, no file access, no web: nothing of its own');
  assert.equal(s.server, 'blackcat');
  assert.equal(s.allowed, 'mcp__blackcat');
  assert.ok(!s.args.includes('--add-dir'), 'it has no file tools to open folders to');
  assert.ok(s.args.includes('--permission-prompt-tool') && s.args.includes('--strict-mcp-config'));
});

test("the agent's rules reach the engine as text: nothing is left for it to find in a file of its own", async () => {
  const s0 = starts().at(-1);
  const told = s0.args[s0.args.indexOf('--append-system-prompt') + 1];
  assert.match(told, /^Rules\.\n\n# blackcat runtime/, 'the rules first, then what is true of this installation');
  assert.ok(!fs.existsSync(path.join(agent, 'CLAUDE.md')), 'there is no file named for one engine');
  // a change to the rules is a change to what it is told: the next message starts afresh
  const before = starts().length;
  fs.writeFileSync(path.join(agent, 'AGENT.md'), 'Rules, changed.\n');
  await brain.reply(CHAT, 'hello again');
  assert.equal(starts().length, before + 1);
  const s1 = starts().at(-1);
  assert.match(s1.args[s1.args.indexOf('--append-system-prompt') + 1], /^Rules, changed\.\n\n# blackcat runtime/);
  assert.ok(!s1.args.includes('--resume'), 'a conversation begun under other rules is not carried on as it was');
  fs.writeFileSync(path.join(agent, 'AGENT.md'), 'Rules.\n');
  assert.match(
    await brain.reply(CHAT, 'and back'),
    /^\(My setup has changed since we last spoke/,
    'and the owner is told once why it is a fresh conversation',
  );
  // and with no rules file at all, it is told the rest and still runs
  const { whole, rules, instructions } = await import('../src/agent/instructions.js');
  assert.equal(rules(path.join(dir, 'nowhere')), '');
  assert.match(whole(instructions({ dir: path.join(dir, 'nowhere') })), /^# blackcat runtime/);
});

test('a call arrives in blackcat and is carried out there: a command, a file read, a search', async () => {
  const answer = await brain.reply(
    CHAT,
    [
      DO('bash', { command: 'date +%Y' }),
      DO('read', { file_path: 'AGENT.md' }),
      DO('glob', { pattern: '*.md' }),
      DO('grep', { pattern: 'Rules' }),
    ].join('\n'),
  );
  const [date, read, glob, grep] = answer.split('\n---\n');
  assert.match(date, /^bash: 20\d\d$/);
  assert.equal(read, 'read:      1\tRules.');
  assert.equal(glob, `glob: ${agent}/AGENT.md`);
  assert.equal(grep, `grep: ${agent}/AGENT.md:1:Rules.`);
  // each is on the record, as it always was, with who let it through
  const rows = activity.recent({ kind: 'command', limit: 4 }).reverse();
  assert.deepEqual(
    rows.map((r) => [r.ok, r.data.decision]),
    [
      [true, 'allowed'],
      [true, 'allowed'],
      [true, 'allowed'],
      [true, 'allowed'],
    ],
  );
  assert.match(rows[0].summary, /^date/);
  const turn = activity.recent({ kind: 'model', category: 'chat' })[0];
  assert.deepEqual([turn.data.commands, turn.data.engine], [4, 'claude-code']);
});

test('what the policy refuses is not done, and nobody is asked', async () => {
  const asked = [];
  brain.setApprover(async (q) => (asked.push(q), { allow: true }));
  const answer = await brain.reply(
    CHAT,
    [
      DO('bash', { command: `cat ${dir}/data/plugins/x/secrets.json` }),
      DO('read', { file_path: `${dir}/data/plugins/x/secrets.json` }),
      DO('read', { file_path: `${dir}/data/config.json` }),
      DO('write', { file_path: `${agent}/AGENT.md`, content: 'New rules.' }),
      DO('edit', { file_path: `${agent}/AGENT.md`, old_string: 'Rules', new_string: 'No rules' }),
      DO('bash', { command: 'blackcat tg bot unpair' }),
    ].join('\n'),
  );
  assert.doesNotMatch(answer, /S3CRET/);
  assert.equal(answer.split('\n---\n').filter((l) => /FAILED: Refused by blackcat's policy without asking the owner/.test(l)).length, 6);
  assert.equal(asked.length, 0);
  assert.equal(fs.readFileSync(path.join(agent, 'AGENT.md'), 'utf8'), 'Rules.\n');
  assert.deepEqual(
    activity.recent({ kind: 'command', limit: 6 }).map((r) => [r.ok, r.data.decision.slice(0, 17)]),
    Array(6).fill([false, 'refused by policy']),
  );
  brain.setApprover(null);
});

test("what needs the owner's say waits for it: yes and it is done, no and it is not", async () => {
  const asked = [];
  brain.setApprover(async (q) => (asked.push(q), { allow: /made-by-a-command$/.test(q.command) }));
  const answer = await brain.reply(
    CHAT,
    [
      DO('bash', { command: `touch ${made}`, description: 'to test approvals' }),
      DO('bash', { command: `rm -rf ${dir}/data/inbox` }),
      DO('read', { file_path: '/etc/hostname' }),
    ].join('\n'),
  );
  assert.deepEqual(
    asked.map((q) => [q.tool, q.command ?? null, q.why ?? null]),
    [
      ['Bash', `touch ${made}`, 'to test approvals'],
      ['Bash', `rm -rf ${dir}/data/inbox`, null],
      ['Read', null, null],
    ],
  );
  assert.ok(fs.existsSync(made), 'approved: blackcat ran it');
  assert.ok(fs.existsSync(path.join(dir, 'data/inbox/from-someone.txt')), 'declined: it was not run');
  const lines = answer.split('\n---\n');
  assert.equal(lines[0], 'bash: (no output)');
  assert.match(lines[1], /^bash FAILED: Not approved/);
  assert.match(lines[2], /^read FAILED: Not approved/);
  assert.deepEqual(
    activity
      .recent({ kind: 'command', limit: 3 })
      .reverse()
      .map((r) => r.data.decision.split(':')[0]),
    ['approved by you', 'declined', 'declined'],
  );
  brain.setApprover(null);
  // with nobody to ask, it is simply not done
  fs.rmSync(made);
  assert.match(await brain.reply(CHAT, DO('bash', { command: `touch ${made}` })), /^bash FAILED: Not approved: no way to ask the owner/);
  assert.ok(!fs.existsSync(made));
});

test('a tool that is not one of the six does not exist, whatever it is called', async () => {
  const answer = await brain.reply(
    CHAT,
    [DO('web_fetch', { url: 'http://example.com' }), DO('Bash', { command: 'date' }), DO('agent', { prompt: 'do things' })].join('\n'),
  );
  assert.deepEqual(
    answer.split('\n---\n').map((l) => l.replace(/^(\w+) FAILED: /, '')),
    ['There is no tool called web_fetch.', 'There is no tool called Bash.', 'There is no tool called agent.'],
  );
});

test("a conversation that has read other people's content says so when the owner is asked", async () => {
  const asked = [];
  brain.setApprover(async (q) => (asked.push(q), { allow: false }));
  brain.resetSession(CHAT);
  await brain.reply(CHAT, DO('bash', { command: 'touch /tmp/a' }));
  assert.equal(asked.at(-1).tainted, false);
  await brain.reply(CHAT, `${DO('read', { file_path: `${dir}/data/inbox/from-someone.txt` })}\n${DO('bash', { command: 'touch /tmp/b' })}`);
  assert.equal(asked.at(-1).tainted, true, 'it has read a file somebody sent: a request to act may have come from it');
  brain.setApprover(null);
});

test('a path is judged as the file it really is: a link into the secrets is refused', async () => {
  fs.symlinkSync(path.join(dir, 'data/plugins/x/secrets.json'), path.join(agent, 'notes.txt'));
  const answer = await brain.reply(
    CHAT,
    [DO('read', { file_path: 'notes.txt' }), DO('grep', { pattern: 'token', path: 'notes.txt' })].join('\n'),
  );
  assert.doesNotMatch(answer, /S3CRET/);
  assert.equal(answer.split('\n---\n').filter((l) => /Refused by blackcat's policy/.test(l)).length, 2);
  fs.rmSync(path.join(agent, 'notes.txt'));
});

test('a command still running when the conversation is stopped is stopped with it', async () => {
  const marker = path.join(dir, 'outlived');
  brain.setApprover(async () => ({ allow: true }));
  const going = brain.reply(CHAT, DO('bash', { command: `sleep 4; touch ${marker}` })).catch((e) => e);
  await new Promise((r) => setTimeout(r, 800));
  brain.resetSession(CHAT);
  await going;
  await new Promise((r) => setTimeout(r, 4500));
  assert.ok(!fs.existsSync(marker), 'it did not go on by itself');
  brain.setApprover(null);
});

test('the other two ways are an option away: supervised (the usual one), or the engine deciding for itself', async () => {
  const eng = await import('../src/engines/registry.js');
  const startedAs = async (tools) => {
    eng.choose('chat', { options: { tools } });
    // (the stand-in does not speak those ways; what matters here is how it is started)
    brain.reply(CHAT, 'hello').catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    brain.stopAll();
    return starts().at(-1);
  };
  const hookOf = (s) => (s.args.includes('--settings') ? JSON.parse(s.args[s.args.indexOf('--settings') + 1]) : null);
  // with nothing chosen: its own tools, and a hook that makes it ask about every one
  const supervised = await startedAs(null);
  assert.equal((await eng.engineFor('chat')).options.tools, 'supervised', "the engine's own default");
  assert.equal(supervised.tools, 'Bash,Read,Glob,Grep,Write,Edit');
  assert.equal(supervised.server, null);
  const hook = hookOf(supervised).hooks.PreToolUse[0];
  assert.equal(hook.matcher, '*', 'every tool');
  assert.match(hook.hooks[0].command, /"permissionDecision":"ask"/, 'the answer is always: ask (and asking goes to blackcat)');
  assert.ok(supervised.args.includes('--permission-prompt-tool'));
  assert.ok(!supervised.args.includes('supervised'), 'the option says how it is started; it is not passed on');
  // the engine deciding for itself, as it was: its own tools, no hook
  const engine = await startedAs('engine');
  assert.equal(engine.tools, 'Bash,Read,Glob,Grep,Write,Edit');
  assert.equal(hookOf(engine), null);
  assert.ok(engine.args.includes('--add-dir'));
  eng.choose('chat', { options: { tools: 'blackcat' } });
});

test("the way it works is the owner's to choose: shown with the model, changed like it, and never by the agent", async () => {
  const { spawnSync } = await import('node:child_process');
  const bc = (args, env = {}) =>
    spawnSync(process.execPath, [`${root}bin/bc.js`, ...args], {
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: undefined, ...env },
    });
  let r = bc(['engine', 'status']);
  assert.match(r.stdout, /options {2}tools: blackcat/);
  assert.match(r.stdout, /tools {4}supervised, blackcat, engine \(chat only\)/);
  r = bc(['engine', 'setup', '--for', 'chat', '--model', '(default)', '--effort', '(default)', '--tools', 'supervised']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /tools: supervised/);
  assert.match(
    bc(['engine', 'setup', '--for', 'chat', '--model', '(default)', '--effort', '(default)', '--tools', 'anything']).stderr,
    /Choose one of: \(default\), supervised, blackcat, engine/,
  );
  // the readers have no tools: the question is not theirs
  r = bc(['engine', 'setup', '--for', 'readers', '--model', 'haiku', '--effort', '(default)']);
  assert.equal(r.status, 0, r.stderr);
  // the agent may change the model with the owner's say, but never whose tools it works with
  const { decide } = await import('../src/agent/policy.js');
  assert.equal(decide('Bash', { command: 'blackcat engine setup --for chat --model opus --effort high' }).action, 'ask');
  for (const c of [
    'blackcat engine setup --for chat --model opus --effort high --tools engine',
    'blackcat engine setup --for chat --tools=engine',
    'blackcat engine setup --tools engine --for chat --model opus',
  ])
    assert.equal(decide('Bash', { command: c }).action, 'deny', c);
  assert.notEqual(
    bc(['engine', 'setup', '--for', 'chat', '--model', '(default)', '--effort', '(default)', '--tools', 'engine'], {
      BLACKCAT_CALLER: 'agent',
      BLACKCAT_SLOW: '1',
    }).status,
    0,
    'refused by the command itself too',
  );
  assert.equal(load().engine.chat.options.tools, 'supervised');
  // changing it means what was checked before no longer stands
  const report = await import('../src/engines/check/report.js');
  const eng = await import('../src/engines/registry.js');
  const before = eng.engineStamp('chat');
  eng.choose('chat', { options: { tools: 'blackcat' } });
  assert.notEqual(eng.engineStamp('chat'), before);
  eng.choose('chat', { options: { tools: null } });
  assert.equal(eng.engineStamp('chat'), before, 'left to the engine is the same as its usual way, named');
  void report;
});
