// blackcat runs without a model. Commands, shortcuts, reminders and checks need none; a
// message in words and a watch do, and say so instead of failing.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { home } from './helpers.js';
import { startBot } from './support/bot.js';

const dir = home();
const root = new URL('..', import.meta.url).pathname;
// A `claude` that is installed and not signed in: it says so, and does nothing else. (Every
// time it is run for anything but that question is noted: there should be few.)
const ran = path.join(dir, 'claude-ran.log');
const NOT_SIGNED_IN = `
import fs from 'node:fs';
const a = process.argv.slice(2);
if (a[0] === 'auth') { console.log(JSON.stringify({ loggedIn: false })); process.exit(0); }
fs.appendFileSync(${JSON.stringify(ran)}, a.slice(0, 2).join(' ') + '\\n');
// As the real one does: it starts, says so, and only then answers that it is not signed in.
if (a.includes('stream-json')) {
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }));
  process.stdin.once('data', () => {
    console.log(JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in · Please run /login', session_id: 's' }));
    process.exit(1);
  });
} else {
  console.error('Not logged in · Please run /login');
  process.exit(1);
}
`;
const starts = () => (fs.existsSync(ran) ? fs.readFileSync(ran, 'utf8').trim().split('\n').length : 0);
const { FORCE_COLOR: _f, ...plain } = process.env;
const bc = (...a) =>
  spawnSync(process.execPath, [`${root}bin/bc.js`, ...a], { encoding: 'utf8', env: { ...plain, NO_COLOR: '1' }, timeout: 60_000 });

let bot;
let tg;
before(async () => {
  bot = await startBot(dir, {
    claude: NOT_SIGNED_IN,
    signedIn: false,
    config: { plugins: { settings: { shortcut: { shortcuts: { hi: { description: 'says hi', run: ['echo hi from a shortcut'] } } } } } },
  });
  tg = bot.tg;
});
after(() => bot?.stop());

test('the agent service starts without a model, says so once in its log, and does not try to start one', async () => {
  for (const end = Date.now() + 10_000; Date.now() < end && !/no model/.test(bot.log());) await new Promise((r) => setTimeout(r, 50));
  assert.match(bot.log(), /no model: Claude Code is not ready: not signed in.*Running without one/);
  assert.ok(starts() <= 1, 'it was tried once, and not again and again');
});

test('what needs no model works: a command of the bot, a shortcut, a typed blackcat command, a reminder', async () => {
  assert.equal((await tg.ask('/ping')).text, 'pong 🏓');
  assert.match((await tg.ask('/hi')).text, /hi from a shortcut/);
  assert.match((await tg.ask('/remind add Call the bank --in 2d')).text, /Call the bank/);
  assert.match((await tg.ask('/remind list')).text, /Call the bank/);
});

test('a message in words is answered plainly, not as a fault, and at once the second time', async () => {
  const first = await tg.ask('what do I need to do this week?');
  assert.match(
    first.text,
    /^No model is set up \(Claude Code is not ready: not signed in.*\)\. Commands still work without one: \/help lists them\. To set one up: bc engine status$/,
  );
  assert.doesNotMatch(first.text, /😿/);
  const before = starts();
  const again = await tg.ask('and tomorrow?');
  assert.equal(again.text, first.text);
  assert.equal(starts(), before, 'known to be missing: nothing was started for the second message');
  // and the commands go on working afterwards
  assert.equal((await tg.ask('/ping')).text, 'pong 🏓');
});

test('the same in the terminal', () => {
  const r = bc('chat', 'hello');
  assert.match(r.stdout + r.stderr, /No model is set up \(Claude Code is not ready: not signed in/);
});

test('the service can be installed without a model, and it is said what will not work', async () => {
  const { services } = await import('../src/service/units.js');
  const all = await services();
  assert.equal(await all.agent.ready(), null);
  assert.match(
    await all.agent.warn(),
    /no model is set up \(Claude Code is not ready.*It runs without one: commands, shortcuts, reminders and checks work; messages in words and watches need a model/,
  );
  const st = bc('status');
  assert.match(st.stdout, /engine +○ no model \(Claude Code: not signed in.*commands, shortcuts, reminders and checks work/);
  const self = bc('selftest', 'blackcat');
  assert.match(self.stdout, /engine for chat: .*no model/);
  assert.doesNotMatch(self.stdout, /✗ engine for/, 'a model that was never set up is not a failure');
});

test('a watch reads nothing and marks nothing as read: its messages wait for a model, and no failure is recorded', async () => {
  const { openWrite } = await import('../src/archive/db.js');
  const { openWatchDb, addWatch, getWatch } = await import('../src/watch/db.js');
  const { withDb } = await import('../src/db.js');
  const wa = openWrite();
  wa.prepare("INSERT INTO chats (ref, name, is_group) VALUES ('111@s.whatsapp.net', 'Maya', 0)").run();
  for (let n = 1; n <= 3; n++)
    wa.prepare(
      "INSERT INTO messages (chat_ref, id, sender_ref, from_me, ts, type, text) VALUES ('111@s.whatsapp.net', ?, '111@s.whatsapp.net', 0, ?, 'text', ?)",
    ).run(`M${n}`, Math.floor(Date.now() / 1000) - 60 + n, `there is a concert on Saturday ${n}`);
  wa.close();
  const id = withDb(
    openWatchDb,
    (db) =>
      addWatch(db, {
        chatId: 42,
        name: 'Ideas',
        lookFor: 'things to do',
        sources: { chats: [{ ref: '111@s.whatsapp.net', name: 'Maya' }] },
        mode: 'briefing',
      }).id,
  );
  const r = bc('watch', 'scan', String(id), '--json');
  assert.equal(r.status, 0, r.stderr);
  const w = JSON.parse(r.stdout).watches[0];
  assert.equal(w.looked, 0);
  assert.match(w.waiting, /^No model is set up/);
  assert.match(bc('watch', 'scan', String(id)).stdout, /Ideas: not read\. No model is set up/);
  // nothing was marked as read, so it is all still there for the day a model is
  withDb(openWatchDb, (db) => {
    assert.equal(db.prepare('SELECT COUNT(*) FROM watch_seen WHERE watch_id = ?').pluck().get(id), 0);
    assert.ok(getWatch(db, id));
  });
  assert.doesNotMatch(bc('activity', 'recent', '--failed').stdout, /Ideas|reader|watch/);
  assert.match(bc('status').stdout, /not reading: no model is set up/);
});

test('a check that only runs a command works; one that asks a model to judge says it could not', async () => {
  const add = bc('check', 'add', 'Plain', '--run', 'true', '--every', '1h');
  assert.equal(add.status, 0, add.stdout + add.stderr);
  assert.match(bc('check', 'run', 'plain', '--dry-run').stdout, /working|passed|ok/i);
});
