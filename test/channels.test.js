// Channels. The chat is not tied to Telegram: a second channel, made of two files and able
// to do nothing but carry text, gets reminders, approvals, setup forms and a plugin's
// screens, with choices as numbered lists. And there is one channel in use at a time,
// chosen in a terminal.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { SIGNED_IN, home } from './helpers.js';
import { CLAUDE, DEMO_PLUGIN } from './support/demo-plugin.js';
import { FILE_CHANNEL } from './support/file-channel.js';

const dir = home();
const root = new URL('..', import.meta.url).pathname;
for (const [name, code] of [
  ['demo', DEMO_PLUGIN],
  ['filechan', FILE_CHANNEL],
]) {
  fs.mkdirSync(path.join(dir, `user-plugins/${name}`), { recursive: true });
  fs.writeFileSync(path.join(dir, `user-plugins/${name}/plugin.js`), code);
}
fs.mkdirSync(path.join(dir, 'agent'), { recursive: true });
const sentLog = path.join(dir, 'sent.log');
fs.writeFileSync(path.join(dir, 'fake-claude.mjs'), CLAUDE(sentLog));
fs.writeFileSync(
  path.join(dir, 'fake-bin/claude'),
  `#!/bin/sh\n${SIGNED_IN}exec ${process.execPath} ${path.join(dir, 'fake-claude.mjs')} "$@"\n`,
  {
    mode: 0o755,
  },
);
const { save, load } = await import('../src/config.js');
save({ channel: 'filechan', plugins: { enabled: ['demo', 'filechan'], settings: { filechan: { owner: { chat: 'me', name: 'Ana' } } } } });

const chan = path.join(dir, 'data/plugins/filechan');
fs.mkdirSync(chan, { recursive: true });
// (Read while it is being written to: a last line that is not whole yet is left for the next look.)
const sent = () =>
  fs.existsSync(path.join(chan, 'out.jsonl'))
    ? fs
        .readFileSync(path.join(chan, 'out.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .flatMap((l) => {
          try {
            return [JSON.parse(l)];
          } catch {
            return [];
          }
        })
    : [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (text, from = 'me') => fs.appendFileSync(path.join(chan, 'in.jsonl'), `${JSON.stringify({ from, text })}\n`);
// Say something (or do something) and collect what is sent next, once it has gone quiet.
async function then(act, { until = () => true, ms = 20_000 } = {}) {
  const mark = sent().length;
  await act();
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (sent().slice(mark).some(until)) break;
    await sleep(40);
  }
  await sleep(300);
  const got = sent().slice(mark);
  assert.ok(got.some(until), `nothing fitting was sent. Sent: ${JSON.stringify(got.map((m) => m.text ?? m.file))}`);
  return got;
}
const ask = async (text) => (await then(() => say(text))).map((m) => m.text);
const bc = (args, env = {}) =>
  spawnSync(process.execPath, [`${root}bin/bc.js`, ...args], { encoding: 'utf8', env: { ...process.env, BLACKCAT_SLOW: '1', ...env } });

let agent;
let log = '';
before(async () => {
  agent = spawn(process.execPath, [`${root}bin/bc.js`, 'agent', 'run'], {
    env: { ...process.env, BLACKCAT_SLOW: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  agent.stdout.on('data', (d) => (log += d));
  agent.stderr.on('data', (d) => (log += d));
  for (const end = Date.now() + 30_000; Date.now() < end && !/file channel running/.test(log);) await sleep(50);
  assert.match(log, /file channel running · paired: Ana/, log);
});
after(async () => {
  agent?.kill('SIGTERM');
  await new Promise((r) => agent.on('exit', r));
});

test('a conversation, the built-in commands, and nobody but the owner', async () => {
  assert.deepEqual(await ask('/ping'), ['pong 🏓']);
  assert.deepEqual(await ask('hello there'), ['echo: hello there']);
  assert.deepEqual(await ask('/start'), ["Hi Ana 👋 I'm blackcat. Just talk to me, or send /help to see what I can do."]);
  const mark = sent().length;
  say('let me in', 'mallory');
  assert.deepEqual(await ask('/ping'), ['pong 🏓']);
  assert.equal(sent().length, mark + 1, 'the stranger got nothing');
  // a long answer is cut to what this channel can carry
  const parts = await ask('long please');
  assert.ok(parts.length > 10 && parts.every((p) => p.length <= 500));
  assert.equal(parts.join('\n').split('\n').length, 90);
});

test('a reminder arrives with its choices as a numbered list, and a number answers', async () => {
  const { addReminder, openRemindersDb: openAgentDb } = await import('../src/reminders/db.js');
  const db = openAgentDb();
  addReminder(db, { chatId: 'me', text: 'Call the bank', dueTs: Math.floor(Date.now() / 1000) - 5 });
  db.close();
  const [due] = await then(() => {}, { until: (m) => /Call the bank/.test(m.text ?? ''), ms: 45_000 });
  assert.equal(
    due.text,
    '⏰ Call the bank\n\n1. ✅ Done\n2. ⏰ 1 hour\n3. 🌅 Tomorrow 9:00\n(Answer with a number.)',
    'no tags, no buttons: plain text with numbered choices',
  );
  assert.equal(due.actions, null);
  const after1 = await ask('2');
  // the acknowledgement, and the message as it now stands (this channel cannot edit, so it is sent again)
  assert.match(after1[0], /^⏰ Snoozed to (today|tomorrow) \d\d:\d\d$/);
  assert.match(after1[1], /^⏰ Call the bank\n\n⏰ Snoozed to (today|tomorrow) \d\d:\d\d$/);
  assert.match((await ask('/remind'))[0], /^⏰ Reminders\n\n1\. (today|tomorrow) \d\d:\d\d · Call the bank/);
  // a number with nothing on offer is just a message
  assert.deepEqual(await ask('7'), ['echo: 7']);
});

test('an approval is asked for and answered the same way', async () => {
  const [asked] = await ask('please delete the folder');
  assert.match(asked, /^🐈‍⬛ blackcat wants to run a command\n\nrm -rf \/tmp\/blackcat-test-target\n/);
  assert.ok(asked.endsWith('\n\n1. ✅ Allow once\n2. ♾ Always allow\n3. ❌ Not now\n4. 🚫 Never allow\n(Answer with a number.)'));
  const allowed = await then(() => say('1'), { until: (m) => m.text === 'It is deleted.' });
  assert.ok(
    allowed.some((m) => /✅ Allowed once at \d\d:\d\d/.test(m.text)),
    'the outcome is recorded in the chat',
  );
  const [again] = await ask('please delete the folder');
  assert.ok(again.includes('1. ✅ Allow once'));
  const refused = await then(() => say('3'), { until: (m) => m.text === 'I did not delete it.' });
  assert.ok(refused.some((m) => /❌ Not now/.test(m.text)));
});

test('setup by answering questions, with a secret that cannot be taken back here', async () => {
  const [menu] = await ask('/setup');
  assert.match(menu, /^⚙️ Setup\. What do you want to do\?/);
  const pick = /^(\d+)\. Demo: set the demo up$/m.exec(menu)[1];
  const begun = await then(() => say(pick), { until: (m) => /called/.test(m.text ?? '') });
  assert.deepEqual(
    begun.map((m) => m.text),
    [
      'Demo: set the demo up\n(/cancel stops it.)',
      'This is the demo setup.',
      'What is it called?\n\n1. Use kettle\n(Answer with a number.)',
    ],
  );
  assert.deepEqual(await ask('1'), ['Its secret key\n\n🔒 Type it here. I delete your message as soon as I have read it.']);
  const afterSecret = await ask('hunter2');
  assert.equal(
    afterSecret[0],
    "I couldn't delete that message. Please delete it yourself.",
    'said plainly, since this channel cannot remove a message',
  );
  assert.equal(afterSecret[1], 'How big?\n\n• Medium: the usual\n\n1. Small\n2. Medium ✓\n3. Large\n(Answer with a number.)');
  assert.deepEqual(await ask('3'), ['Make it loud?\n\n1. Yes\n2. No\n(Answer with a number.)']);
  const end = await then(() => say('2'), { until: (m) => /Saved/.test(m.text ?? '') });
  assert.equal(end.at(-1).text, 'Saved: kettle, l, quiet, key of 7 characters.');
  assert.doesNotMatch(fs.existsSync(sentLog) ? fs.readFileSync(sentLog, 'utf8') : '', /hunter2/, 'the secret never reached Claude');
});

test("a plugin's own screens, a typed command, the quick route, and a note from another process", async () => {
  await ask('/watch add Ideas');
  await ask("/watch add-item 2 --title 'Try the new cafe'");
  const [watches] = await ask('/watch');
  assert.equal(
    watches,
    '👁 Your watches\n\n1. Things I need to do · 0 on the list\n    in the daily briefing\n2. Ideas · 1 on the list\n    in the daily briefing\n\n1. 1. Things I need to do\n2. 2. Ideas\n(Answer with a number.)',
  );
  const [card] = await ask('2');
  assert.match(card, /^👁 Ideas\nLooks for: Ideas\n/);
  assert.ok(card.endsWith('\n\n1. 📋 Show list\n2. 🔄 Check for new\n3. ⏸ Pause\n4. ✅ Done ones\n(Answer with a number.)'));
  const [list] = await ask('1');
  assert.match(list, /Still on the list\n1\. Try the new cafe/);
  // typed commands, and one that changes something asks first
  assert.deepEqual(await ask('/demo hello'), ['hello from demo']);
  assert.deepEqual(await ask('/demo change'), [
    'This changes something:\nbc demo change\n\n1. ▶️ Run it\n2. ✖ Cancel\n(Answer with a number.)',
  ]);
  assert.deepEqual(
    (await then(() => say('1'), { until: (m) => m.text === 'changed it' })).map((m) => m.text),
    ['Running', 'changed it'],
  );
  assert.deepEqual(await ask('demo quick'), ['done quickly']);
  // a command run in another process tells the owner through the same channel
  const note = await then(() => say('/demo notify'), { until: (m) => m.text === 'told' });
  assert.deepEqual(
    note.map((m) => [m.chat, m.text]),
    [
      ['me', 'a note from the demo plugin'],
      ['me', 'told'],
    ],
  );
});

test('one channel is in use at a time, and it is changed in a terminal only', async () => {
  const list = JSON.parse(bc(['channel', '--json']).stdout).channels;
  assert.deepEqual(list.map((c) => [c.name, c.paired, c.active]).sort(), [
    ['filechan', true, true],
    ['tg-bot', false, false],
  ]);
  assert.match(bc(['channel']).stdout, /● filechan\s+the file channel\s+in use/);
  assert.match(bc(['channel']).stdout, /○ tg-bot\s+Telegram\s+not set up → bc tg bot pair/);
  // not one that is not set up, and not something that is not a channel
  assert.match(bc(['channel', 'use', 'tg-bot']).stderr, /Telegram is not set up yet\. Pair it first: bc tg bot pair/);
  assert.match(bc(['channel', 'use', 'demo']).stderr, /"demo" is not a channel/);
  assert.equal(load().channel, 'filechan');
  // never from a chat, and never by the agent: a channel cannot switch itself
  assert.deepEqual(await ask('/bc channel off'), ['Which channel is in use is changed in a terminal on this machine, not from a chat.']);
  assert.notEqual(bc(['channel', 'off'], { BLACKCAT_CALLER: 'agent' }).status, 0);
  assert.equal(load().channel, 'filechan');

  // switching it off: what is yours goes back to being kept for the terminal, and comes with you when one is in use again
  const { openAgentDb } = await import('../src/agentdb.js');
  const owners = () => {
    const db = openAgentDb();
    const r = {
      reminders: db.prepare('SELECT DISTINCT chat_id FROM reminders').pluck().all(),
      watches: db.prepare('SELECT DISTINCT chat_id FROM watches').pluck().all(),
    };
    db.close();
    return r;
  };
  assert.deepEqual(owners(), { reminders: ['me'], watches: ['me'] });
  const off = bc(['channel', 'off']);
  assert.match(
    off.stdout,
    /No channel is in use now\. Everything is still kept, and shown in bc chat\. \d+ reminders? and watch(es)? moved with you\./,
  );
  assert.equal(load().channel, undefined);
  assert.deepEqual(owners(), { reminders: [0], watches: [0] });
  const { hasBot, ownerChat } = await import('../src/owner.js');
  assert.deepEqual([hasBot(), ownerChat()], [false, 0]);
  assert.match(bc(['channel', 'use', 'filechan']).stdout, /● filechan is now the channel in use\./);
  assert.deepEqual(owners(), { reminders: ['me'], watches: ['me'] });
  assert.deepEqual([hasBot(), ownerChat()], [true, 'me']);
});
