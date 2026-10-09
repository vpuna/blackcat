// What runs the model is a plugin (docs/plugins.md, "Engines"). These tests hold the two things that
// matter about that: which engine, model and options are used is the owner's choice, made
// separately for the chat and the readers; and what the agent may do is decided by blackcat,
// in the same way, whichever engine is plugged in.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { SIGNED_IN, home } from './helpers.js';
import { parrotPlugin } from './support/parrot-engine.js';

const dir = home();
process.env.HOME = dir;
const root = new URL('..', import.meta.url).pathname;
const doneLog = path.join(dir, 'done.log');
const startsLog = path.join(dir, 'starts.log');
const claudeLog = path.join(dir, 'claude.log');
fs.mkdirSync(path.join(dir, 'user-plugins/parrot'), { recursive: true });
fs.writeFileSync(path.join(dir, 'user-plugins/parrot/plugin.js'), parrotPlugin({ doneLog, startsLog }));
fs.mkdirSync(path.join(dir, 'agent'), { recursive: true });
fs.writeFileSync(path.join(dir, 'agent/AGENT.md'), 'Rules.\n');
// A stand-in for `claude` that notes how it was started (arguments, and where it was told
// the model is) and answers.
fs.writeFileSync(
  path.join(dir, 'fake-claude.mjs'),
  `
import fs from 'node:fs'; import readline from 'node:readline';
const args = process.argv.slice(2);
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'test' })); process.exit(0); }
fs.appendFileSync(${JSON.stringify(claudeLog)}, JSON.stringify({ args, url: process.env.ANTHROPIC_BASE_URL ?? null, key: process.env.ANTHROPIC_AUTH_TOKEN ?? null, caller: process.env.BLACKCAT_CALLER ?? null, chat: process.env.BLACKCAT_CHAT_ID ?? null }) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.type !== 'user') return;
  console.log(JSON.stringify({ type: 'system', subtype: 'init' }));
  const said = typeof m.message.content === 'string' ? m.message.content : 'a file';
  console.log(JSON.stringify({ type: 'result', is_error: false, result: 'claude heard: ' + said.split('\\n').at(-1), session_id: 'sess-c', duration_ms: 5, duration_api_ms: 4, num_turns: 1, total_cost_usd: 0.01,
    usage: { input_tokens: 3, output_tokens: 2 }, modelUsage: { 'claude-test': { costUSD: 0.01, contextWindow: 1000 } } }));
});`,
);
fs.writeFileSync(
  path.join(dir, 'fake-bin/claude'),
  `#!/bin/sh\n${SIGNED_IN}exec ${process.execPath} ${path.join(dir, 'fake-claude.mjs')} "$@"\n`,
  {
    mode: 0o755,
  },
);

const { save, load, update } = await import('../src/config.js');
save({ plugins: { enabled: ['parrot'] }, engine: { chat: { model: 'opus' }, readers: { model: 'haiku' } } });
const { loadPlugins } = await import('../src/plugins/registry.js');
await loadPlugins();
const eng = await import('../src/engines/registry.js');
const brain = await import('../src/agent/brain.js');
const { askModel } = await import('../src/agent/oneshot.js');
const activity = await import('../src/activity/log.js');
const conversations = await import('../src/conversations/store.js');
after(() => brain.stopAll());

const lines = (f) =>
  fs.existsSync(f)
    ? fs
        .readFileSync(f, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const bc = (args, env = {}) =>
  spawnSync(process.execPath, [`${root}bin/bc.js`, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
const argAfter = (args, flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const CHAT = 42;

test('which model is used is a choice made of the engine, for the chat and the readers separately', () => {
  assert.deepEqual(load().engine, { chat: { model: 'opus' }, readers: { model: 'haiku' } });
  assert.deepEqual([eng.engineName('chat'), eng.engineName('readers')], ['claude-code', 'claude-code']);
});

test("with nothing chosen, the engine's own defaults apply: for the chat and for the readers separately", async () => {
  update((c) => {
    delete c.engine;
  });
  const chat = await eng.engineFor('chat');
  const readers = await eng.engineFor('readers');
  assert.deepEqual([chat.name, chat.model, chat.options], ['claude-code', null, { tools: 'supervised' }]); // the chat: whatever the account's default model is, and supervised
  assert.deepEqual([readers.name, readers.model], ['claude-code', 'sonnet']);
  assert.equal(eng.modelNow('readers'), 'sonnet');
  assert.equal(eng.modelNow('chat'), null);
});

test('a model is whatever the owner says: one from the list, or any other name', async () => {
  eng.choose('chat', { model: 'qwen3:14b', options: { effort: 'high' } });
  eng.choose('readers', { model: 'haiku' });
  assert.deepEqual(load().engine, { chat: { model: 'qwen3:14b', options: { effort: 'high' } }, readers: { model: 'haiku' } });
  const e = await eng.engineFor('chat');
  assert.deepEqual([e.model, e.options], ['qwen3:14b', { tools: 'supervised', effort: 'high' }]);
  // back to the engine's own
  eng.choose('chat', { model: null, options: { effort: null } });
  assert.deepEqual(load().engine, { readers: { model: 'haiku' } });
  assert.throws(() => eng.choose('everything', { model: 'x' }), /not something an engine is chosen for/);
});

test('Claude Code is started with the model and options chosen, and told where the model is', async () => {
  eng.choose('chat', { model: 'qwen3:14b', options: { effort: 'low' } });
  update((c) => {
    c.plugins.settings = { ...c.plugins.settings, 'claude-code': { endpoint: 'http://10.0.0.9:11434' } };
  });
  fs.mkdirSync(path.join(dir, 'data/plugins/claude-code'), { recursive: true });
  const { findLoaded, makeCtx } = await import('../src/plugins/registry.js');
  makeCtx(findLoaded('claude-code'), { caller: 'owner' }).secrets.set('key', 'SECRET-KEY');
  assert.equal(await brain.reply(CHAT, 'hello'), 'claude heard: hello');
  const start = lines(claudeLog).at(-1);
  assert.equal(argAfter(start.args, '--model'), 'qwen3:14b');
  assert.equal(argAfter(start.args, '--effort'), 'low');
  assert.equal(argAfter(start.args, '--tools'), 'Bash,Read,Glob,Grep,Write,Edit');
  assert.match(
    argAfter(start.args, '--settings'),
    /PreToolUse.*permissionDecision.*ask/,
    'and it is made to ask blackcat about every call (the other ways: test/served.test.js)',
  );
  assert.equal(argAfter(start.args, '--permission-prompt-tool'), 'stdio');
  assert.ok(start.args.includes('--strict-mcp-config'));
  assert.deepEqual([start.url, start.key, start.caller, start.chat], ['http://10.0.0.9:11434', 'SECRET-KEY', 'agent', '42']);
  // the key is a secret of the plugin's: never in the settings, never in the arguments
  assert.ok(!JSON.stringify(load()).includes('SECRET-KEY'));
  assert.ok(!JSON.stringify(start.args).includes('SECRET-KEY'));
  // with nothing chosen, neither is passed, and the model is wherever Claude Code's sign-in says
  eng.choose('chat', { model: null, options: { effort: null } });
  update((c) => {
    delete c.plugins.settings['claude-code'];
  });
  makeCtx(findLoaded('claude-code'), { caller: 'owner' }).secrets.delete('key');
  await brain.reply(CHAT, 'again');
  const next = lines(claudeLog).at(-1);
  assert.deepEqual(
    [argAfter(next.args, '--model'), argAfter(next.args, '--effort'), next.url, next.key],
    [undefined, undefined, null, null],
  );
});

test('a new choice is taken up by the next message, on the same conversation', async () => {
  const before = lines(claudeLog).length;
  await brain.reply(CHAT, 'one');
  assert.equal(lines(claudeLog).length, before, 'nothing changed: the process kept ready answers');
  const conv = conversations.list({ channel: 'tg-bot', chat: CHAT })[0];
  fs.mkdirSync(path.join(dir, '.claude/projects', path.join(dir, 'agent').replace(/[^A-Za-z0-9]/g, '-')), { recursive: true });
  eng.choose('chat', { model: 'sonnet' });
  assert.equal(await brain.reply(CHAT, 'two'), 'claude heard: two');
  const start = lines(claudeLog).at(-1);
  assert.equal(lines(claudeLog).length, before + 1, 'a process was started with the new choice');
  assert.equal(argAfter(start.args, '--model'), 'sonnet');
  assert.equal(argAfter(start.args, '--resume'), 'sess-c', 'and it carries the conversation on');
  assert.equal(conversations.list({ channel: 'tg-bot', chat: CHAT })[0].id, conv.id);
});

test('the readers ask through their own engine and model, with no tools', async () => {
  eng.choose('readers', { model: 'haiku' });
  assert.match(
    await askModel('You read messages.', 'some messages', undefined, { category: 'watch: test' }),
    /^claude heard: some messages/,
  );
  const start = lines(claudeLog).at(-1);
  assert.equal(argAfter(start.args, '--model'), 'haiku');
  assert.equal(argAfter(start.args, '--tools'), '', 'no tools at all');
  assert.ok(!start.args.includes('--permission-prompt-tool'));
  // a caller may still name a model for one question
  await askModel('You read.', 'x', 'opus');
  assert.equal(argAfter(lines(claudeLog).at(-1).args, '--model'), 'opus');
  const rec = activity.recent({ kind: 'model', category: 'watch: test' })[0];
  assert.deepEqual([rec.model, rec.data.engine, rec.ok], ['claude-test', 'claude-code', true]);
});

// ---- another engine altogether ----

test("a different engine starts from its own defaults; the old one's model means nothing to it", async () => {
  eng.choose('chat', { model: 'sonnet', options: { effort: 'high' } });
  eng.choose('chat', { name: 'parrot' });
  assert.deepEqual(load().engine.chat, { name: 'parrot' });
  const e = await eng.engineFor('chat');
  assert.deepEqual([e.name, e.label, e.model], ['parrot', 'Parrot', 'grey']);
  // the readers were not touched: each is chosen separately
  assert.deepEqual([(await eng.engineFor('readers')).name, eng.modelNow('readers')], ['claude-code', 'haiku']);
});

test("the conversation carries over to the new engine from blackcat's own record", async () => {
  const conv = conversations.list({ channel: 'tg-bot', chat: CHAT })[0];
  const answer = await brain.reply(CHAT, 'and now?');
  const start = lines(startsLog).at(-1);
  assert.equal(start.resume, null, "the other engine's conversation is not offered to this one");
  assert.match(answer, /^parrot heard: \[You are continuing an earlier conversation with the owner/);
  assert.match(answer, /claude heard: two/, 'it is told what was said');
  assert.match(answer, /and now\?$/);
  const now = conversations.list({ channel: 'tg-bot', chat: CHAT })[0];
  assert.equal(now.id, conv.id, 'it is the same conversation');
  // and it was given exactly what any engine is given: the six tools, the caller, the chat
  assert.deepEqual(start.tools, ['Bash', 'Read', 'Glob', 'Grep', 'Write', 'Edit']);
  assert.deepEqual(start.env, { BLACKCAT_CALLER: 'agent', BLACKCAT_CHAT_ID: '42' });
  assert.ok(start.instructions > 1000, "and blackcat's instructions");
});

test('whatever the engine, blackcat decides what is done: allowed, refused, or put to the owner', async (t) => {
  t.after(() => brain.setApprover(null));
  const asked = [];
  brain.setApprover(async (q) => {
    asked.push(q);
    return /some-folder/.test(q.command ?? q.detail ?? '') ? { allow: false, note: 'no' } : { allow: true };
  });
  fs.rmSync(doneLog, { force: true });
  const answer = await brain.reply(
    CHAT,
    [
      'DO Bash {"command":"blackcat engine status --json"}', // read-only: allowed outright
      'DO Bash {"command":"rm -rf /tmp/some-folder"}', // changes something: the owner is asked, and says no
      'DO Bash {"command":"touch /tmp/blackcat-engine-test"}', // the owner is asked, and says yes
      `DO Bash {"command":"cat ${dir}/data/config.json"}`, // blackcat's own settings: refused, nobody is asked
      `DO Read {"file_path":"${dir}/.ssh/id_ed25519"}`, // a key: refused, nobody is asked
      'DO WebFetch {"url":"http://example.com/?q=secret"}', // not one of the six things it can do: refused
    ].join('\n'),
  );
  const done = lines(doneLog).map((d) => d.input.command ?? d.input.file_path ?? d.input.url);
  assert.deepEqual(done, ['blackcat engine status --json', 'touch /tmp/blackcat-engine-test'], 'only what was allowed was carried out');
  assert.equal(asked.length, 2, 'the owner was asked about the two that change something, and nothing else');
  assert.match(answer, /did Bash \| refused Bash: Not approved: no.*\| did Bash \| refused Bash.*\| refused Read.*\| refused WebFetch/s);
  // and it is all on record, with how each was decided
  const cmds = activity
    .recent({ kind: 'command', limit: 6 })
    .reverse()
    .map((c) => [c.ok ? 1 : 0, c.data.decision.split(':')[0]]);
  assert.deepEqual(
    cmds.map((c) => c[0]),
    [1, 0, 1, 0, 0, 0],
  );
  assert.deepEqual(
    cmds.map((c) => c[1]),
    ['allowed', 'declined', 'approved by you', 'refused by policy', 'refused by policy', 'refused by policy'],
  );
  const turn = activity.recent({ kind: 'model', category: 'chat' })[0];
  assert.deepEqual(
    [turn.model, turn.data.engine, turn.cost],
    ['parrot-grey', 'parrot', null],
    'an engine that reports no price leaves the cost empty',
  );
});

test("with nobody to ask, what needs the owner's say is not done", async () => {
  fs.rmSync(doneLog, { force: true });
  const answer = await brain.reply(CHAT, 'DO Bash {"command":"touch /tmp/blackcat-engine-test-2"}');
  assert.match(answer, /^refused Bash: Not approved/);
  assert.deepEqual(lines(doneLog), []);
});

test("a conversation that has read other people's content says so when the owner is asked", async (t) => {
  t.after(() => brain.setApprover(null));
  const asked = [];
  brain.setApprover(async (q) => (asked.push(q), { allow: false }));
  brain.resetSession(CHAT);
  await brain.reply(CHAT, 'DO Bash {"command":"touch /tmp/a"}');
  assert.equal(asked.at(-1).tainted, false);
  await brain.reply(CHAT, 'DO Bash {"command":"blackcat msg search hello --json"}\nDO Bash {"command":"touch /tmp/b"}');
  assert.equal(asked.at(-1).tainted, true, 'it has read messages: a request to act may have come from one');
});

test('the readers can use a different engine from the chat', async () => {
  eng.choose('readers', { name: 'parrot' });
  const text = await askModel('You read messages.', 'twelve chars', undefined, { category: 'watch: parrot' });
  assert.match(text, /^parrot read 12 with green \{"volume":"soft"\}/, 'its own defaults for the readers');
  assert.match(text, /keys:content,model,options,system$/, 'it is handed a question and nothing else: no tools, no folders');
  eng.choose('readers', { model: 'grey', options: { volume: 'loud' } });
  assert.match(await askModel('s', 'x'), /with grey \{"volume":"loud"\}/);
  assert.equal(activity.recent({ kind: 'model', category: 'watch: parrot' })[0].data.engine, 'parrot');
  assert.equal((await eng.engineFor('chat')).name, 'parrot');
  eng.choose('readers', { name: 'claude-code' });
  assert.equal(eng.modelNow('readers'), 'sonnet', "and back: Claude Code's own default again");
});

test('an engine that is not there says so, rather than falling back to another', async () => {
  eng.choose('readers', { name: 'gone' });
  await assert.rejects(askModel('s', 'x'), /The engine "gone" is not available/);
  assert.match(activity.recent({ kind: 'model' })[0].summary, /^failed: The engine "gone"/);
  eng.choose('readers', { name: 'claude-code' });
});

// ---- the commands ----

test('bc engine status: what is in use and what can be chosen', () => {
  brain.stopAll();
  eng.choose('chat', { name: 'claude-code' });
  eng.choose('chat', { model: 'opus', options: { effort: 'high' } });
  const r = bc(['engine', 'status', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const d = JSON.parse(r.stdout);
  const chat = d.roles.find((x) => x.for === 'chat');
  assert.deepEqual(
    [chat.engine, chat.model, chat.options, chat.ready, chat.where],
    ['claude-code', 'opus', { tools: 'supervised', effort: 'high' }, true, 'your Claude plan'],
  );
  assert.deepEqual(d.engines.map((e) => e.name).sort(), ['claude-code', 'parrot']);
  assert.deepEqual(d.engines.find((e) => e.name === 'claude-code').options[0].values, ['low', 'medium', 'high', 'xhigh', 'max']);
  const text = bc(['engine', 'status']).stdout;
  assert.match(text, /model {4}opus/);
  assert.match(text, /options {2}tools: supervised, effort: high/);
  assert.match(text, /tools {4}supervised, blackcat, engine \(chat only\)/);
  assert.match(text, /or any other by name/);
});

test("bc engine setup: from the list, by any name, and back to the engine's own", () => {
  let r = bc(['engine', 'setup', '--for', 'readers', '--model', 'haiku', '--effort', 'low']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Saved for the background readers: model haiku, effort: low/);
  r = bc(['engine', 'setup', '--for', 'chat', '--model', 'other', '--name', 'qwen3:14b', '--effort', '(default)']);
  assert.match(r.stdout, /model qwen3:14b, tools: supervised\./);
  assert.deepEqual(load().engine, {
    chat: { name: 'claude-code', model: 'qwen3:14b' },
    readers: { name: 'claude-code', model: 'haiku', options: { effort: 'low' } },
  });
  // what is not a choice is refused, and says what is
  r = bc(['engine', 'setup', '--for', 'chat', '--model', 'gpt', '--effort', 'low']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Choose one of: \(default\), opus, sonnet, haiku, other/);
  r = bc(['engine', 'setup', '--for', 'chat', '--model', 'opus', '--effort', 'extreme']);
  assert.match(r.stderr, /Choose one of: \(default\), low, medium, high, xhigh, max/);
  r = bc(['engine', 'setup', '--for', 'chat', '--model', 'other', '--name', 'x; rm -rf /', '--effort', 'low']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /A model name/);
  r = bc(['engine', 'setup', '--for', 'chat', '--model', '(default)', '--effort', '(default)']);
  assert.match(r.stdout, /the model is left to Claude Code/);
  assert.deepEqual(load().engine.chat, { name: 'claude-code' });
});

test('what is left out stays as it is: one thing can be changed without restating the rest', () => {
  bc(['engine', 'setup', '--for', 'chat', '--model', 'sonnet', '--effort', 'low']);
  bc(['engine', 'setup', '--for', 'readers', '--model', 'haiku', '--effort', 'medium']);
  // only how hard the chat thinks
  let r = bc(['engine', 'setup', '--for', 'chat', '--effort', 'high']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(load().engine.chat, { name: 'claude-code', model: 'sonnet', options: { effort: 'high' } });
  // only the readers' model: the chat is not touched, nor the readers' effort
  r = bc(['engine', 'setup', '--for', 'readers', '--model', 'opus']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(load().engine.readers, { name: 'claude-code', model: 'opus', options: { effort: 'medium' } });
  assert.deepEqual(load().engine.chat, { name: 'claude-code', model: 'sonnet', options: { effort: 'high' } });
  // a model given by name stays, name and all
  bc(['engine', 'setup', '--for', 'chat', '--model', 'other', '--name', 'qwen3:14b']);
  r = bc(['engine', 'setup', '--for', 'chat', '--effort', 'low']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(load().engine.chat, { name: 'claude-code', model: 'qwen3:14b', options: { effort: 'low' } });
  // which of the two it is for must always be said
  assert.match(bc(['engine', 'setup', '--model', 'haiku']).stderr, /Missing: --for/);
  // and the help says what each option takes
  const help = bc(['engine', 'setup', '--help']).stdout.replace(/\s+/g, ' ');
  assert.match(help, /--for <value> which one this is for: chat \(the agent you talk to\) or readers/);
  assert.match(help, /--effort <value> How hard it thinks: low, medium, high, xhigh, max, or "\(default\)"\. Left out, it stays as it is/);
  assert.match(help, /--tools <value> .*supervised, blackcat, engine, or "\(default\)" \(chat only\)/);
  bc(['engine', 'setup', '--for', 'chat', '--model', '(default)', '--effort', '(default)']);
  bc(['engine', 'setup', '--for', 'readers', '--model', '(default)', '--effort', '(default)']);
});

test('an option belongs to its engine: Parrot is asked how loud, not how hard it thinks', () => {
  assert.equal(bc(['engine', 'use', 'parrot', '--for', 'readers', '--no-check']).status, 0);
  const r = bc(['engine', 'setup', '--for', 'readers', '--model', 'green', '--volume', 'loud']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /model green, volume: loud/);
  assert.deepEqual(load().engine.readers, { name: 'parrot', model: 'green', options: { volume: 'loud' } });
  assert.match(
    bc(['engine', 'setup', '--for', 'readers', '--model', 'opus', '--volume', 'soft']).stderr,
    /Choose one of: \(default\), grey, green, other/,
  );
});

test("which engine is used is the owner's alone; the agent may look, and must ask to change a model", () => {
  const asAgent = { BLACKCAT_CALLER: 'agent', BLACKCAT_SLOW: '1' };
  let r = bc(['engine', 'use', 'parrot'], asAgent);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /owner only/);
  assert.equal(load().engine.chat.name, 'claude-code');
  assert.equal(bc(['engine', 'status', '--json'], asAgent).status, 0);
  r = bc(['engine', 'use', 'nothing', '--no-check']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /No engine called "nothing". There are: claude-code, parrot/);
});

test('the policy puts a change of model to the owner, and never lets the agent change engine or where the model is', async () => {
  const { decide } = await import('../src/agent/policy.js');
  assert.equal(decide('Bash', { command: 'blackcat engine status --json' }).action, 'allow');
  assert.equal(decide('Bash', { command: 'blackcat engine setup --for chat --model haiku --effort low' }).action, 'ask');
  assert.equal(decide('Bash', { command: 'blackcat engine use parrot' }).action, 'deny');
  assert.equal(decide('Bash', { command: 'blackcat claude setup --endpoint http://evil.example' }).action, 'deny');
});

test("the chat's menu lists the engine's commands, and a plugin whose name cannot be a chat command does not break it", async () => {
  const { directCommands } = await import('../src/channels/commands.js');
  const names = directCommands().map((c) => c.command);
  assert.ok(names.includes('engine') && names.includes('claude') && names.includes('parrot'));
  // Telegram refuses the whole menu if one name has anything but letters, digits and _
  for (const n of names) assert.match(n, /^[a-z][a-z0-9_]{0,31}$/);
  const { mountOf, loaded } = await import('../src/plugins/registry.js');
  const real = mountOf;
  loaded().find((p) => p.name === 'parrot').manifest.mount = 'my-parrot';
  assert.ok(!directCommands().some((c) => c.command === 'my-parrot'), 'left out of the menu (it is still reached with /bc my-parrot)');
  delete loaded().find((p) => p.name === 'parrot').manifest.mount;
  void real;
});

test('the engine in use cannot be switched off', () => {
  const r = bc(['plugin', 'disable', 'claude-code']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /is the engine in use \(for chat\)/);
  assert.ok(!(load().plugins.disabled ?? []).includes('claude-code'));
  // one that is not in use can be
  bc(['engine', 'use', 'claude-code', '--no-check']);
  assert.equal(bc(['plugin', 'disable', 'parrot']).status, 0);
});

test('a plugin that calls itself an engine but cannot hold a conversation is not loaded', async () => {
  fs.mkdirSync(path.join(dir, 'user-plugins/half'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'user-plugins/half/plugin.js'),
    `export default { api: 1, name: 'half', title: 'Half', description: 'x', commands: {}, engine: { label: 'Half', choices: () => ({}), ready: async () => ({ ok: true }) } };`,
  );
  const r = bc(['plugin', 'enable', 'half']);
  assert.match(r.stderr + r.stdout, /engine\.converse must be a function/);
  assert.ok(!JSON.parse(bc(['engine', 'status', '--json']).stdout).engines.some((e) => e.name === 'half'));
});
