// What the agent remembers from one conversation to the next is kept by blackcat, in its own
// database: the same whichever engine runs the model, saved and forgotten with blackcat
// commands, and handed to the engine as text at the start of a conversation.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { home } from './helpers.js';

const dir = home();
process.env.HOME = dir;
const root = new URL('..', import.meta.url).pathname;
fs.mkdirSync(path.join(dir, 'agent'), { recursive: true });
fs.writeFileSync(path.join(dir, 'agent/AGENT.md'), 'Rules.\n');

const { save: saveConfig } = await import('../src/config.js');
saveConfig({});
const store = await import('../src/memory/store.js');
store.save({
  name: 'family-and-nicknames',
  kind: 'user',
  summary: "who the owner's family are",
  text: "Told by the owner on 2026-10-03:\n- Maya is the owner's wife.\n\nSee [[school-pdfs]].",
});
const plain = (extra = {}) => {
  const { FORCE_COLOR: _f, ...env } = process.env;
  return { ...env, NO_COLOR: '1', ...extra };
};
const bc = (...args) => {
  const r = spawnSync(process.execPath, [`${root}bin/bc.js`, ...args], { encoding: 'utf8', env: plain() });
  return { ...r, json: () => JSON.parse(r.stdout) };
};

test('saving: a new memory, more about the same subject, a correction, and what is refused', () => {
  const a = store.save({
    name: 'Brother Sam',
    kind: 'user',
    summary: "Sam is the owner's brother",
    text: "Sam is the owner's brother. Told on 2026-10-06.",
  });
  assert.deepEqual([a.created, a.memory.name, a.memory.by], [true, 'brother-sam', 'agent']);
  // more about him: added to what is there, and the rest stays as it was
  const b = store.save({ name: 'brother-sam', text: 'He lives in Lisbon.', append: true });
  assert.deepEqual([b.created, b.memory.kind, b.memory.summary], [false, 'user', "Sam is the owner's brother"]);
  assert.equal(b.memory.text, "Sam is the owner's brother. Told on 2026-10-06.\nHe lives in Lisbon.");
  // a correction: the text is replaced; only the summary can be changed too
  assert.equal(
    store.save({ name: 'brother-sam', text: "Sam is the owner's brother. He lives in Porto." }).memory.text,
    "Sam is the owner's brother. He lives in Porto.",
  );
  assert.equal(store.save({ name: 'brother-sam', summary: 'Sam, in Porto' }).memory.text, "Sam is the owner's brother. He lives in Porto.");
  assert.equal(store.get('brother-sam').summary, 'Sam, in Porto');
  // with no summary given, the first line is it
  assert.equal(store.save({ name: 'tea', kind: 'user', text: 'Likes tea.\nGreen, mostly.' }).memory.summary, 'Likes tea.');
  for (const [bad, why] of [
    [{ name: '!', kind: 'user', text: 'x' }, /short name in words/],
    [{ name: 'new-one', text: 'x' }, /what kind it is/],
    [{ name: 'new-one', kind: 'gossip', text: 'x' }, /--kind is one of/],
    [{ name: 'new-one', kind: 'user' }, /what to remember/],
    [{ name: 'tea', append: true }, /what to add/],
    [{ name: 'tea', text: 'x'.repeat(4001) }, /up to 4000 characters/],
  ]) {
    assert.throws(() => store.save(bad), why);
  }
  assert.equal(store.remove('tea').name, 'tea');
  assert.equal(store.remove('tea'), null);
});

test('the commands: for the owner in a terminal, and the same ones for the agent', () => {
  const made = bc('memory', 'save', 'coffee order', '--kind', 'user', '--text', "Black. Maya's is with oat milk.", '--json').json();
  assert.deepEqual([made.name, made.created, made.by, made.text], ['coffee-order', true, 'owner', "Black. Maya's is with oat milk."]);
  const agent = spawnSync(
    process.execPath,
    [`${root}bin/bc.js`, 'memory', 'save', 'coffee-order', '--append', '--text', 'Told on 2026-10-06.', '--json'],
    { encoding: 'utf8', env: plain({ BLACKCAT_CALLER: 'agent' }) },
  );
  assert.deepEqual([JSON.parse(agent.stdout).created, JSON.parse(agent.stdout).by], [false, 'agent']);
  assert.match(bc('memory', 'list').stdout, /coffee-order\s+user ·[^\n]*\n {2}Black\. Maya's is with oat milk\.\n {2}Told on 2026-10-06\./);
  assert.deepEqual(bc('memory', 'list', '--kind', 'feedback', '--json').json(), { memories: [] });
  assert.deepEqual(
    bc('memory', 'list', '--json')
      .json()
      .memories.map((m) => m.name),
    ['coffee-order', 'brother-sam', 'family-and-nicknames'],
  );
  assert.equal(bc('memory', 'show', 'coffee-order', '--json').json().kind, 'user');
  assert.match(bc('memory', 'show', 'nothing-such').stderr, /No memory called "nothing-such"/);
  assert.match(bc('memory', 'save', 'x', '--text', 'a').stderr, /short name in words/);
  assert.match(bc('memory', 'remove', 'coffee-order').stdout, /Forgot "coffee-order"/);
  assert.notEqual(bc('memory', 'remove', 'coffee-order').status, 0);
  assert.match(bc('status').stdout, /Memory\s+2 things remembered/);
});

test('the policy: the agent saves and adds by itself; forgetting, and writing over what was said, are put to the owner; the folder an engine might keep is like any other', async () => {
  const { loadPlugins } = await import('../src/plugins/registry.js');
  await loadPlugins();
  const { decide } = await import('../src/agent/policy.js');
  const OLD_DIR = path.join(dir, '.claude/projects/x/memory');
  for (const c of [
    "blackcat memory save brother-sam --append --text 'He lives in Lisbon.' --json",
    'blackcat memory save dentist --kind reference --summary "the dentist" --text "Dr Rao, Palm Street. The owner\'s words, 2026-10-06." --json',
    'blackcat memory list --json',
    'blackcat memory show brother-sam --json',
    // only what a memory is filed under changes: nothing it said is lost
    'blackcat memory save brother-sam --kind user --summary "the owner\'s brother" --json',
  ])
    assert.equal(decide('Bash', { command: c }).action, 'allow', c);
  // What would lose something remembered is put to the owner first, with what would go.
  const forget = decide('Bash', { command: 'blackcat memory remove brother-sam --json' });
  assert.equal(forget.action, 'ask');
  assert.match(forget.title, /^use Memory: forget what I remember as "brother-sam" \(/);
  const over = decide('Bash', { command: "blackcat memory save brother-sam --text 'Something else entirely.' --json" });
  assert.equal(over.action, 'ask');
  assert.match(over.title, /replace what I remember as "brother-sam" \(.*\) with something else/);
  assert.equal(
    decide('Bash', { command: 'blackcat memory remove never-was --json' }).action,
    'ask',
    'asked even of one that is not there: the command then says so',
  );
  // the owner's own hand is not asked: typed in a terminal, or as /memory … in the chat
  const { levelOf } = await import('../src/plugins/access.js');
  const { findLoaded } = await import('../src/plugins/registry.js');
  assert.equal(levelOf(findLoaded('memory'), 'remove', ['brother-sam'], 'owner').level, 'allow');
  assert.equal(levelOf(findLoaded('memory'), 'save', ['brother-sam', '--text', 'x'], 'owner').level, 'allow');
  assert.notEqual(decide('Write', { file_path: path.join(OLD_DIR, 'x.md'), content: 'x' }).action, 'allow');
  assert.notEqual(decide('Read', { file_path: path.join(OLD_DIR, 'MEMORY.md') }).action, 'allow');
});

test('what the model is handed: everything while it is short, the oldest in a line each past that; the readers get who is who', () => {
  const told = store.remembered();
  assert.match(
    told,
    /^# What you remember\n\nWhat you saved in earlier conversations, from what the owner told you \(2 in all, most recently changed first\)\. It was true when it was saved/,
  );
  assert.match(told, /\n## brother-sam \(user\): Sam, in Porto\nSam is the owner's brother\. He lives in Porto\.\n/);
  assert.match(told, /\n## family-and-nicknames \(user\): who the owner's family are\nTold by the owner on 2026-10-03:/);
  // a great deal remembered: the most recent whole, the rest named, to be asked for
  for (let i = 0; i < 4; i++) store.save({ name: `long-${i}`, kind: 'project', summary: `long one ${i}`, text: `${i} `.repeat(1500) });
  const much = store.remembered();
  assert.ok(much.length < 9500, `${much.length} characters`);
  assert.match(much, /More, in a line each \(the whole of one: `blackcat memory show <name> --json`\):\n(- [\w-]+ \(\w+\): [^\n]+\n?)+$/);
  for (const m of store.all()) assert.ok(much.includes(m.name), m.name);
  for (let i = 0; i < 4; i++) store.remove(`long-${i}`);
  // the readers: only what is about the owner and the people around them, and no links
  store.save({ name: 'open-pdfs', kind: 'feedback', text: 'PDFs may be opened.' });
  const about = store.aboutOwner();
  assert.match(about, /^\n\nAbout the owner and the people around them, as the owner told it\./);
  assert.ok(
    about.includes('He lives in Porto.') &&
      about.includes("Maya is the owner's wife.") &&
      !about.includes('PDFs may be opened') &&
      !about.includes('[['),
  );
  store.remove('open-pdfs');
});

test('with nothing remembered, the model is told so, and the readers nothing', () => {
  for (const m of store.all()) store.remove(m.name);
  assert.equal(store.remembered(), '# What you remember\n\nNothing yet.');
  assert.equal(store.aboutOwner(), '');
});

test('the instructions: what is remembered is handed over with the rest, and saving something does not begin the conversation afresh', async () => {
  const { instructions, stamp, whole } = await import('../src/agent/instructions.js');
  const before = stamp('chat');
  store.save({ name: 'likes-tea', kind: 'user', text: 'The owner likes tea.' });
  const i = instructions({ surface: 'chat' });
  assert.match(i.memory, /## likes-tea \(user\): The owner likes tea\./);
  assert.match(whole(i), /^Rules\.\n\n# blackcat runtime[\s\S]*\n\n# What you remember\n[\s\S]*The owner likes tea\.$/);
  assert.equal(stamp('chat'), before, 'the fingerprint is of the rules and the setup, not of what is remembered');
  // the agent is told how to use it: the notes of the memory feature are in the generated part
  assert.match(i.generated, /## Memory \(`blackcat memory …`\)[\s\S]*\*\*When to save\.\*\* Do not wait to be asked\./);
});

test('Claude Code: it is handed what is remembered, and its own memory is off', async () => {
  const { conversationArgs, environment } = await import('../plugins/claude-code/run.js');
  const args = conversationArgs({
    tools: [],
    readDirs: [],
    instructions: { rules: 'Rules.', generated: 'Generated.', memory: '# What you remember\n\nNothing yet.' },
  });
  assert.equal(args[args.indexOf('--append-system-prompt') + 1], 'Rules.\n\nGenerated.\n\n# What you remember\n\nNothing yet.');
  const env = environment({ config: { get: () => ({}) }, secrets: { get: () => null } });
  assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
});
