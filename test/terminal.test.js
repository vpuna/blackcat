// `bc chat`: the terminal as a channel. It is part of the core, not a plugin, but a
// conversation in it goes through the same desk as any channel: a plugin's screens,
// approvals and the quick route work here, with choices as numbered lists.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, test } from 'node:test';
import { SIGNED_IN, home } from './helpers.js';
import { CLAUDE, DEMO_PLUGIN } from './support/demo-plugin.js';

const dir = home();
fs.mkdirSync(path.join(dir, 'user-plugins/demo'), { recursive: true });
fs.writeFileSync(path.join(dir, 'user-plugins/demo/plugin.js'), DEMO_PLUGIN);
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
process.env.NO_COLOR = '1';
const { save } = await import('../src/config.js');
save({
  plugins: {
    enabled: ['demo'],
    settings: { shortcut: { shortcuts: { hi: { description: 'says hi', run: ['echo hi from a shortcut'] } } } },
  },
});
const { conversation } = await import('../src/agent/chat.js');
const { addReminder, openRemindersDb: openAgentDb } = await import('../src/reminders/db.js');

const input = new PassThrough();
const output = new PassThrough();
let screen = '';
output.on('data', (d) => (screen += d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Type a line and collect what appears, once `until` is on the screen and it has gone quiet.
async function type(line, until = /\S/, ms = 20_000) {
  const mark = screen.length;
  input.write(`${line}\n`);
  for (const end = Date.now() + ms; Date.now() < end && !until.test(screen.slice(mark));) await sleep(30);
  await sleep(250);
  const got = screen.slice(mark).trim();
  assert.match(got, until, `typed "${line}", got: ${JSON.stringify(got)}`);
  return got;
}

let done;
before(async () => {
  // a reminder of the owner's, made before any channel existed
  const db = openAgentDb();
  addReminder(db, { chatId: 0, text: 'Water the plants', dueTs: Math.floor(Date.now() / 1000) + 3600 });
  db.close();
  done = conversation({ input, output, opts: {}, tty: false });
  for (const end = Date.now() + 20_000; Date.now() < end && !/in this terminal/.test(screen);) await sleep(30);
});
after(async () => {
  input.write('/exit\n');
  await done;
});

test('a conversation, and the built-in commands', async () => {
  assert.match(screen, /blackcat\s+in this terminal · \/help · \/exit/);
  assert.equal(await type('hello there'), 'echo: hello there');
  assert.equal(await type('/ping'), 'pong 🏓');
  const help = await type('/help');
  assert.match(help, /\/remind/);
  assert.match(help, /Here in the terminal:\n {2}\/<command>/);
  assert.equal(await type('/new'), '🧹 Fresh conversation started. Long-term memories are kept. (/resume goes back to an earlier one.)');
});

test("a plugin's screens work here, with choices as numbers", async () => {
  assert.match(await type('/remind'), /^⏰ Reminders\n\n1\. .* · Water the plants/);
  // a typed blackcat command runs directly
  assert.match(await type('/watch add Ideas', /created/), /Watch 2 "Ideas" created\./);
  await type("/watch add-item 2 --title 'Try the new cafe'", /cafe/);
  assert.equal(await type('/demo hello', /hello/), 'hello from demo');
  const watches = await type('/watch');
  assert.match(watches, /^👁 Your watches\n\n1\. Things I need to do · 0 on the list\n {4}in the daily briefing\n2\. Ideas · 1 on the list/);
  assert.ok(watches.endsWith('1. 1. Things I need to do\n2. 2. Ideas\n(Answer with a number.)'));
  const card = await type('2');
  assert.match(card, /^👁 Ideas\nLooks for: Ideas/);
  assert.ok(card.endsWith('1. 📋 Show list\n2. 🔄 Check for new\n3. ⏸ Pause\n4. ✅ Done ones\n(Answer with a number.)'));
  const list = await type('1', /Still on the list/);
  assert.match(list, /1\. Try the new cafe/);
  const item = await type('1', /Try the new cafe/);
  assert.ok(item.endsWith('1. ✅ Did it\n2. 📌 Keep\n3. 🗑 Not interested\n(Answer with a number.)'));
  assert.match(await type('1'), /Try the new cafe/);
  // the briefing, a shortcut, and the quick route
  assert.match(await type('/briefing', /Today|Tomorrow|Coming|Nothing/), /Water the plants/);
  assert.equal(await type('/hi', /hi from/), 'hi from a shortcut');
  assert.equal(await type('demo quick'), 'done quickly');
});

test('an approval is asked for here, and answered with a number', async () => {
  const asked = await type('please delete the folder', /Answer with a number/);
  assert.match(
    asked,
    /^🐈 blackcat wants to run a command\n\nrm -rf \/tmp\/blackcat-test-target\n\nNothing runs unless you allow it\. Always and Never are for this exact command \(undo: \/permissions\)\. Expires in 5 minutes\.\n/,
  );
  assert.ok(asked.endsWith('1. ✅ Allow once\n2. ∞ Always allow\n3. ❌ Not now\n4. 🚫 Never allow\n(Answer with a number.)'));
  // the outcome is said once, on its own: the request is not printed a second time
  const done = await type('1', /It is deleted\./);
  assert.match(done, /^✅ Allowed once at \d\d:\d\d\n/);
  assert.doesNotMatch(done, /blackcat wants to|Allowed once\n\nAllowed once/);
  await type('please delete the folder', /Answer with a number/);
  assert.match(await type('3', /I did not delete it\./), /❌ Not now/);
  // a number with nothing on offer is just something said to the agent
  assert.equal(await type('7'), 'echo: 7');
});

test('/setup lists what can be set up; /resume lists the conversations kept here', async () => {
  const setup = await type('/setup');
  assert.match(setup, /^⚙️ Setup\. What do you want to do\?\n\n/);
  assert.match(setup, /^\d+\. Demo: set the demo up$/m);
  await type('/new');
  assert.equal(await type('one more question'), 'echo: one more question');
  const list = await type('/resume');
  assert.match(list, /^Which conversation shall we carry on\? \(• is the current one\)\n\n1\. • today \d\d:\d\d · one more question\n/);
  const pick =
    /^(\d+)\. today \d\d:\d\d · please delete the folder$/m.exec(list)?.[1] ?? /^(\d+)\. today \d\d:\d\d · hello there$/m.exec(list)[1];
  assert.match(await type(pick, /Continuing/), /^↩️ Continuing "/);
  // and it is the terminal's own conversations, kept apart from any channel's
  const { list: all } = await import('../src/conversations/store.js');
  assert.ok(all({ channel: 'terminal' }).length >= 2);
  assert.equal(all({ channel: 'tg-bot' }).length, 0);
  // what was typed reached Claude as the owner's own words, with nothing added
  const told = fs
    .readFileSync(sentLog, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l).text);
  assert.ok(told.includes('hello there') && told.includes('one more question'));
});
