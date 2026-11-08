// Simple commands learned from the agent: the owner's words, when the agent did one simple thing
// for them and nothing else, are kept with it, and the same words next time (a small typo apart)
// go to the plugin's quick route without the agent. Measured on the owner's own messages on
// 2026-10-28: a match by meaning took "create a shortcut for a ride" for running it, so only
// words that were said before are taken, never words that are only like them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { home } from './helpers.js';
import { parrotPlugin } from './support/parrot-engine.js';

const dir = home();
fs.mkdirSync(path.join(dir, 'user-plugins/parrot'), { recursive: true });
fs.writeFileSync(
  path.join(dir, 'user-plugins/parrot/plugin.js'),
  parrotPlugin({ doneLog: path.join(dir, 'done.log'), startsLog: path.join(dir, 'starts.log') }),
);
// A made-up plugin: lamps it switches, a state it only looks at, and something it asks about.
fs.mkdirSync(path.join(dir, 'user-plugins/lamp'), { recursive: true });
fs.writeFileSync(
  path.join(dir, 'user-plugins/lamp/plugin.js'),
  `const one = (summary, access = 'allow') => ({ summary, access, usage: '[name...]', run: () => 'done' });
export default { api: 1, name: 'lamp', title: 'Lamp', description: 'lamps',
  commands: { on: one('switch one on'), off: one('switch one off'), state: one('what is on'), buy: one('buy a lamp', 'ask') },
  chat: {
    quick: async (text) => { const m = /^lamp (on|off) (\\w+)$/.exec(text); return m ? { text: m[2] + ' is ' + m[1], note: 'lamp ' + m[1] } : null; },
    learn: async (command, tokens) => (command === 'state' ? 'look' : ['on', 'off'].includes(command) && tokens.length === 1 ? 'lamp ' + command + ' ' + tokens[0] : null),
  } };\n`,
);
fs.mkdirSync(path.join(dir, 'agent'), { recursive: true });
fs.writeFileSync(path.join(dir, 'agent/AGENT.md'), 'Rules.\n');
const { save } = await import('../src/config.js');
save({ plugins: { enabled: ['parrot', 'lamp'] } });
const { loadPlugins } = await import('../src/plugins/registry.js');
await loadPlugins();
(await import('../src/engines/registry.js')).choose('chat', { name: 'parrot' });
const brain = await import('../src/agent/brain.js');
const { learnFrom, recall, wording, listLearned, forget } = await import('../src/channels/learned.js');
const { tryQuick } = await import('../src/channels/quick.js');
brain.afterTurn(learnFrom);
after(() => brain.stopAll());

const CHAT = 7;
const DO = (...commands) => commands.map((c) => `DO Bash ${JSON.stringify({ command: c })}`).join('\n');
// The agent's turn for these words, and what was learned from it once it is over.
async function turn(said, ...commands) {
  const before = listLearned().length;
  await brain.reply(CHAT, DO(...commands), { said });
  for (let i = 0; i < 20 && listLearned().length === before; i++) await new Promise((r) => setTimeout(r, 25));
}

test('the words are kept as said, less what changes nothing', () => {
  assert.equal(wording('Can you turn ON the kitchen light, please?'), 'turn on kitchen light');
  assert.equal(wording("Don't turn off the TV"), 'do not turn off tv');
  assert.equal(wording('bc sky'), 'sky');
  assert.equal(wording('one two three four five six seven eight nine ten eleven'), null, 'too long to be a simple command');
});

test('one simple thing done, with looks besides: learned, and done without the agent next time', async () => {
  await turn('Hall lamp please!', 'blackcat lamp state --json', "blackcat lamp on 'hall' --json");
  assert.deepEqual(
    listLearned().map((l) => [l.wording, l.plugin, l.words]),
    [['hall lamp', 'lamp', 'lamp on hall']],
  );
  const sent = [];
  const c = { chat: CHAT, conversation: CHAT, reply: async (text, o) => sent.push([text, !!o?.actions]) };
  assert.equal(await tryQuick(c, 'hall lamp'), true);
  assert.deepEqual(sent, [
    ['hall is on', false],
    ['↪️ As when you said “hall lamp” before.', true],
  ]);
  // (Offered to be forgotten the first few times only.)
  for (let i = 0; i < 3; i++) await tryQuick(c, 'Hall lamp.');
  assert.deepEqual(sent.at(-1), ['hall is on', false]);
  assert.equal(await tryQuick(c, 'the hall lamp, now'), true, 'the same words, less what changes nothing');
  assert.equal(await tryQuick(c, 'kitchen lamp'), false, 'words never said: the agent');
});

test('a small typo is the same words; "on" is never "off"', async () => {
  await turn('garden lamp on', "blackcat lamp on 'garden' --json");
  assert.equal(recall('gardn lamp on')?.words, 'lamp on garden');
  assert.equal(recall('garden lamp off'), null);
  assert.equal(recall('garden lamps on')?.words, 'lamp on garden');
});

test('not learned: two things done, what was asked about, refused or failed, something else run', async (t) => {
  t.after(() => brain.setApprover(null));
  const was = listLearned().length;
  await turn('both lamps', "blackcat lamp on 'porch' --json", "blackcat lamp off 'hall' --json");
  brain.setApprover(async () => ({ allow: true }));
  await turn('get me a lamp', "blackcat lamp buy 'red' --json");
  brain.setApprover(async () => ({ allow: false }));
  await turn('buy one', "blackcat lamp buy 'blue' --json");
  await turn('porch lamp and a note', "blackcat lamp on 'porch' --json", 'blackcat memory list --json');
  await brain.reply(CHAT, DO("blackcat lamp on 'porch' --json"), {}); // not the owner's own words (a forwarded message)
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(listLearned().length, was);
});

test('"Not what I meant": forgotten, and the agent has it next time', async () => {
  const l = recall('hall lamp');
  assert.equal(forget(l.id), true);
  assert.equal(recall('hall lamp'), null);
  assert.equal(await tryQuick({ chat: CHAT, conversation: CHAT, reply: async () => {} }, 'hall lamp'), false);
});

test('managed by the owner: bc learned list and forget, and /learned with a button for each', async () => {
  const { spawnSync } = await import('node:child_process');
  const root = new URL('..', import.meta.url).pathname;
  const bc = (...a) => spawnSync(process.execPath, [`${root}bin/bc.js`, ...a], { encoding: 'utf8', env: process.env });
  await turn('porch lamp please', "blackcat lamp on 'porch' --json");
  const [l] = listLearned().filter((x) => x.wording === 'porch lamp');
  assert.match(bc('learned', 'list').stdout, new RegExp(`${l.id}\\. “porch lamp” → Lamp: lamp on porch · not used yet · learned`));
  assert.deepEqual(JSON.parse(bc('learned', 'list', '--json').stdout).learned.find((x) => x.id === l.id).does, 'Lamp: lamp on porch');
  assert.match(bc('learned', 'forget', '999').stderr, /Nothing learned has the number 999/);

  // In the chat: the screen, and a tap that forgets one and shows what is left.
  const { default: m } = await import('../src/learned/manifest.js');
  const handlers = [];
  const ui = { action: (re, fn) => handlers.push([re, fn]), command: () => {} };
  await m.chat.install(ui);
  const shown = [];
  const { showScreen } = await import('../src/learned/commands.js');
  await showScreen({ reply: async (text, o) => shown.push({ text, buttons: o.actions }) });
  assert.match(shown[0].text, /🧠 <b>Learned words<\/b>[\s\S]*“porch lamp” → Lamp: lamp on porch/);
  const [re, tap] = handlers[0];
  const data = `lf:${l.id}`;
  const edited = [];
  await tap({ match: re.exec(data), toast: async () => {}, edit: async (text) => edited.push(text) });
  assert.equal(recall('porch lamp'), null, 'forgotten');
  assert.doesNotMatch(edited[0], /porch lamp/);

  // The agent asks before it forgets one; the owner does not.
  const { levelOf } = await import('../src/plugins/access.js');
  const part = (await loadPlugins()).find((p) => p.name === 'learned');
  assert.equal(levelOf(part, 'forget', ['1'], 'agent').level, 'ask');
  assert.equal(levelOf(part, 'forget', ['1'], 'owner').level, 'allow');
  assert.equal(bc('learned', 'forget', '--all').status, 0);
  assert.deepEqual(listLearned(), []);
});
