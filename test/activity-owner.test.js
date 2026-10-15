// The activity record holds more than what the agent did: what the owner did directly, what
// blackcat sent them unasked, who was turned away, and every change to what may be done.
// Always what and when; never what was said.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { home } from './helpers.js';
import { startBot } from './support/bot.js';
import { CLAUDE, DEMO_PLUGIN } from './support/demo-plugin.js';

const dir = home();
const root = new URL('..', import.meta.url).pathname;
fs.mkdirSync(path.join(dir, 'user-plugins/demo'), { recursive: true });
fs.writeFileSync(path.join(dir, 'user-plugins/demo/plugin.js'), DEMO_PLUGIN);
// (One that takes the name of a plugin that comes with blackcat: it is not loaded, and that is noted.)
fs.mkdirSync(path.join(dir, 'user-plugins/ssh'), { recursive: true });
fs.writeFileSync(path.join(dir, 'user-plugins/ssh/plugin.js'), 'export default {};\n');
const { FORCE_COLOR: _f, BLACKCAT_CALLER: _c, ...base } = process.env;
const bc = (args, extra = {}) =>
  spawnSync(process.execPath, [`${root}bin/bc.js`, ...args], {
    encoding: 'utf8',
    env: { ...base, NO_COLOR: '1', ...extra },
    timeout: 60_000,
    input: '',
  });
const record = (...args) => {
  const r = bc(['activity', 'recent', '-n', '200', '--json', ...args]);
  const d = JSON.parse(r.stdout);
  return (d.entries ?? d.events ?? d).map((e) => ({
    kind: e.kind,
    what: e.category ?? e.for,
    summary: e.summary ?? null,
    ok: e.ok !== false,
  }));
};
const has = (list, what, summary) =>
  list.some((e) => e.what === what && (summary instanceof RegExp ? summary.test(e.summary ?? '') : e.summary === summary));

let bot;
let tg;
before(async () => {
  bot = await startBot(dir, {
    claude: CLAUDE(path.join(dir, 'sent.log')),
    // (This machine's own alerts are off: whether the disk is full where the tests run is not what is tested.)
    config: { plugins: { enabled: ['demo', 'host'], disabled: ['voice'], settings: { host: { alerts: false } } } },
  });
  tg = bot.tg;
});
after(() => bot?.stop());
const settle = () => new Promise((r) => setTimeout(r, 300));

test('what the owner does in the chat without the agent is on the record: a command typed, a button tapped, a thing done directly', async () => {
  await tg.ask('/ping');
  await tg.ask('/remind add Call the bank about the mortgage --in 3d');
  assert.equal((await tg.ask('demo quick')).text, 'done quickly');
  const { addReminder, openRemindersDb } = await import('../src/reminders/db.js');
  const db = openRemindersDb();
  addReminder(db, { chatId: tg.owner.id, text: 'Water the plants', dueTs: Math.floor(Date.now() / 1000) - 5 });
  db.close();
  const due = await tg.next((c) => c.method === 'sendMessage' && /Water the plants/.test(c.text), { ms: 45_000 });
  tg.tap(due, 'Done');
  await tg.next('editMessageText');
  await settle();
  const mine = record('--kind', 'owner');
  assert.ok(has(mine, 'typed', '/ping'), JSON.stringify(mine));
  assert.ok(has(mine, 'typed', '/remind add …'), 'by its name and first word');
  assert.ok(has(mine, 'done directly', 'demo: the demo did something quick'));
  assert.ok(has(mine, 'tapped', /^"✅ Done" · rm:\d+:d$/), 'what the button said, and its id');
  // never what was said
  assert.doesNotMatch(JSON.stringify(record()), /mortgage|Water the plants/);
});

test('what blackcat sent by itself is on the record, named, and never what it said', async () => {
  const sent = record('--kind', 'sent');
  assert.ok(has(sent, 'remind', /^reminder \d+$/), JSON.stringify(sent));
  assert.ok(sent.every((e) => e.ok));
  // a reply to something asked for is not "sent by itself"
  assert.equal(sent.filter((e) => /ping|pong/.test(JSON.stringify(e))).length, 0);
  // a notice from one of the owner's own programs is among them
  // (Run beside this test, not in its way: the stand-in Telegram it sends to is this very process.)
  const { spawn } = await import('node:child_process');
  const code = await new Promise((resolve) =>
    spawn(process.execPath, [`${root}bin/bc.js`, 'notify', '--from', 'disk', 'ninety per cent full'], {
      env: { ...base, NO_COLOR: '1', BLACKCAT_TELEGRAM_API: tg.url },
      stdio: 'ignore',
    }).on('close', resolve),
  );
  assert.equal(code, 0);
  assert.ok(has(record('--kind', 'sent'), 'notify: disk', /^sent \(\d+ characters\)$/));
  assert.doesNotMatch(JSON.stringify(record()), /ninety per cent/);
});

test('an account that is not paired is turned away, and that is noted once, not for every message it sends', async () => {
  for (let i = 0; i < 4; i++) tg.say(`let me in ${i}`, { from: { id: 999, first_name: 'Mallory' } });
  await tg.ask('/ping');
  await settle();
  const seen = record('--kind', 'event').filter((e) => e.what === 'channel');
  assert.deepEqual(seen, [{ kind: 'event', what: 'channel', summary: 'ignored an account that is not paired (id 999)', ok: false }]);
  assert.doesNotMatch(JSON.stringify(record()), /let me in/);
});

test('a change to what blackcat may do is on the record, however it was made: a plugin, a mode, a standing permission, a service', async () => {
  const asked = await tg.ask('please delete the folder');
  tg.tap(asked, 'Always allow');
  await tg.next('editMessageText');
  await settle();
  assert.equal(bc(['host', 'mode', 'read']).status, 0);
  bc(['plugin', 'disable', 'demo']);
  bc(['plugin', 'enable', 'demo']);
  const perms = JSON.parse(bc(['permissions', '--json']).stdout);
  bc(['permissions', 'remove', String((perms.rules ?? perms)[0].id)]);
  bc(['stop', 'agent']); // (nothing runs it here: it is still something the owner asked for)
  const mine = record('--kind', 'owner');
  assert.ok(has(mine, 'standing permission', "always allow: blackcat host run 'rm -rf /tmp/blackcat-test-target'"), JSON.stringify(mine));
  assert.ok(has(mine, 'standing permission', 'removed "always allow": blackcat host run \'rm -rf /tmp/blackcat-test-target\''));
  assert.ok(has(mine, 'bc host mode', 'read'));
  assert.ok(has(mine, 'bc plugin disable', 'demo'));
  assert.ok(has(mine, 'bc plugin enable', 'demo'));
  assert.ok(has(mine, 'bc stop', 'agent'));
  assert.ok(has(mine, 'tapped', /^"♾ Always allow" · ap:[0-9a-f]+:a$/));
});

test("a command that only looks is noted too, marked as a look and without its words; what the agent or a scheduled job ran is not the owner's", () => {
  const all = () => JSON.parse(bc(['activity', 'recent', '-n', '300', '--json']).stdout).entries;
  const before = all().length;
  bc(['remind', 'list', '--all']);
  bc(['status']);
  bc(['host', 'health']);
  bc(['msg', 'find', 'the mortgage papers', '--since', '30d']);
  const mine = all().filter((e) => e.kind === 'owner');
  const of = (what) => mine.find((e) => e.category === what);
  assert.equal(of('bc remind list').summary, '--all');
  assert.equal(of('bc remind list').looks, true);
  assert.equal(of('bc status').looks, true);
  assert.ok(of('bc host health').ms >= 0, 'how long it took');
  assert.equal(of('bc host health').who, 'owner');
  // what was looked for is what was said: never kept
  assert.doesNotMatch(JSON.stringify(all()), /mortgage papers/);
  // a change keeps its words, and is not marked as a look
  assert.equal(of('bc host mode').looks, undefined);
  // what a scheduled job ran in the owner's name is blackcat's; what the agent ran is recorded by its conversation, not here
  const n = all().length;
  bc(['host', 'mode', 'ask'], { BLACKCAT_JOB: '1' });
  bc(['host', 'health'], { BLACKCAT_CALLER: 'agent' });
  const added = all().slice(0, all().length - n);
  assert.deepEqual(
    added.map((e) => [e.kind, e.category, e.who]),
    [['job', 'bc host mode', 'blackcat']],
  );
  // nor a service's own command, which blackcat starts by itself
  // (Checks looking when their turn comes is scheduled work, and is on the record: the built-in one is there from the start.)
  assert.ok(!all().some((e) => / run$/.test(e.category) && e.category !== 'bc check run'), 'no "bc wa run" or the like');
  // reading the record is counted, and does not fill the record with itself
  assert.ok(!all().some((e) => e.category.startsWith('bc activity')));
  assert.ok(all().length > before);
});

test('a plugin that was not loaded is noted when blackcat starts', () => {
  const ev = record('--kind', 'event').filter((e) => e.what === 'plugin');
  assert.equal(ev.length, 1, JSON.stringify(ev));
  assert.match(ev[0].summary, /^"ssh" was not loaded: blackcat has a plugin of its own called "ssh"/);
  assert.equal(ev[0].ok, false);
});

// (Everything an entry holds, as `--json` gives it.)
const full = (...args) => JSON.parse(bc(['activity', 'recent', '-n', '300', '--json', ...args]).stdout).entries;

test('each of them says how long it took and how it ended, so that "why was that slow?" can be answered', async () => {
  // a reminder that is hours late, a voice note, a slash command blackcat does not have, and a command that fails
  const { addReminder, openRemindersDb } = await import('../src/reminders/db.js');
  const db = openRemindersDb();
  addReminder(db, { chatId: tg.owner.id, text: 'Long overdue', dueTs: Math.floor(Date.now() / 1000) - 2 * 3600 });
  db.close();
  await tg.next((c) => c.method === 'sendMessage' && /Long overdue/.test(c.text), { ms: 45_000 });
  tg.sendVoice();
  await tg.next((c) => c.text === 'done quickly');
  // and one the agent answers
  tg.sendVoice('say:anything new today?');
  await tg.next((c) => /echo: anything new today\?/.test(c.text ?? ''), { ms: 45_000 });
  await tg.ask('/nosuchcommand please');
  assert.notEqual(bc(['host', 'mode', 'no-such-mode']).status, 0);
  await settle();
  const mine = full('--kind', 'owner');
  const of = (list, category, summary) =>
    list.find((e) => e.category === category && (summary instanceof RegExp ? summary.test(e.summary) : e.summary === summary));
  const num = (x) => typeof x === 'number' && x >= 0;
  // a tap and a typed command: how long what they set off took
  assert.ok(num(of(mine, 'tapped', /Done/).ms), JSON.stringify(of(mine, 'tapped', /Done/)));
  assert.ok(num(of(mine, 'typed', '/ping').ms));
  assert.equal(of(mine, 'typed', '/ping').by, 'command');
  assert.equal(of(mine, 'typed', '/nosuchcommand please').by, 'agent', 'one blackcat does not have is left to the agent, and says so');
  assert.ok(num(of(mine, 'done directly', /^demo:/).ms));
  // a command at the terminal: noted as it ends, with how it ended
  assert.ok(num(of(mine, 'bc host mode', 'read').ms));
  const bad = of(mine, 'bc host mode', 'no-such-mode');
  assert.equal(bad.ok, false);
  assert.ok(bad.exit > 0 && num(bad.ms));
  // stopping a service: how long it took, and that here it did not work (nothing is running)
  assert.ok(num(of(mine, 'bc stop', 'agent').ms));
  assert.equal(of(mine, 'bc stop', 'agent').ok, false);
  // what was sent: how long the channel took, how long it was, and how late
  const sent = full('--kind', 'sent').filter((e) => e.category === 'remind');
  assert.ok(
    sent.every((e) => num(e.ms) && e.chars > 0),
    JSON.stringify(sent),
  );
  const late = sent.filter((e) => e.lateS);
  assert.equal(late.length, 1, 'only the one that was late says so');
  assert.ok(late[0].lateS >= 7200 && late[0].lateS < 7400);
  // a voice note: how long the audio was, and how long turning it into words took; not the words
  const voice = of(full('--kind', 'event'), 'voice note', '2 s of audio');
  assert.ok(voice && num(voice.ms), JSON.stringify(full('--kind', 'event')));
  assert.equal(voice.audioS, 2);
  assert.equal(voice.score, 88, 'how sure the reader was is kept, as for the voice notes in collected chats');
  // it is the owner's piece of work, and the agent's answer to it is part of the same one
  assert.equal(voice.who, 'owner');
  const all = full('--all');
  const answered = all.filter((e) => e.category === 'voice note').find((v) => all.some((e) => e.work === v.work && e.kind === 'model'));
  assert.ok(answered, JSON.stringify(all.filter((e) => e.category === 'voice note' || e.kind === 'model')));
  const turn = all.filter((e) => e.work === answered.work);
  assert.ok(
    turn.every((e) => e.who === 'owner'),
    JSON.stringify(turn),
  );
  assert.deepEqual(
    full('--work', '--all')
      .filter((e) => e.work === answered.work)
      .map((e) => e.category),
    ['voice note'],
    'the voice note stands for it',
  );
  assert.doesNotMatch(JSON.stringify(full()), /Long overdue|demo quick"/);
  // and a person reading it sees the same
  const text = bc(['activity', 'recent', '-n', '300']).stdout;
  assert.match(text, /→ remind: reminder \d+ · 2h \d+m late|→ remind: reminder \d+ · 2\.0h late|→ remind: reminder \d+ · \S+ late/);
  assert.match(text, /◆ typed: \/nosuchcommand please · left to the agent/);
  assert.match(text, /✗◆ bc host mode: no-such-mode/);
});

test('a message that took its time to arrive says so, on a command and on a turn of the agent; a tap on what is gone says that', async () => {
  const written = Math.floor(Date.now() / 1000) - 90;
  tg.say('/ping', { extra: { date: written } });
  await tg.next((c) => c.method === 'sendMessage');
  tg.say('hello there, slowly', { extra: { date: written } });
  await tg.next((c) => c.method === 'sendMessage');
  // a reminder that is deleted before its button is tapped
  const { addReminder, openRemindersDb } = await import('../src/reminders/db.js');
  let db = openRemindersDb();
  const id = addReminder(db, { chatId: tg.owner.id, text: 'Soon gone', dueTs: Math.floor(Date.now() / 1000) - 5 });
  db.close();
  const due = await tg.next((c) => c.method === 'sendMessage' && /Soon gone/.test(c.text), { ms: 45_000 });
  db = openRemindersDb();
  db.prepare('DELETE FROM reminders WHERE id = ?').run(id?.id ?? id);
  db.close();
  tg.tap(due, 'Done');
  await tg.next('answerCallbackQuery');
  await settle();
  const late = full('--kind', 'owner').filter((e) => e.category === 'typed' && e.waitedS);
  assert.equal(late.length, 1, JSON.stringify(full('--kind', 'owner').filter((e) => e.category === 'typed')));
  assert.ok(late[0].waitedS >= 90 && late[0].waitedS < 120);
  const turn = full('--kind', 'model').filter((e) => e.waitedS);
  assert.equal(turn.length, 1, 'the one turn whose message was slow to arrive');
  assert.ok(turn[0].waitedS >= 90 && turn[0].waitedS < 120);
  const gone = full('--kind', 'owner').filter((e) => e.gone);
  assert.equal(gone.length, 1);
  assert.match(gone[0].summary, /^"✅ Done" · rm:\d+:d$/);
  const text = bc(['activity', 'recent', '-n', '300']).stdout;
  assert.match(
    text,
    /typed: \/ping · reached blackcat 1m \d+s after it was written|typed: \/ping · reached blackcat \S+ after it was written/,
  );
  assert.match(text, /what it was about is gone/);
});

test('a service says when it is connected: how long after it was started, and after how long cut off', () => {
  const r = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { serviceConnected } from '${root}src/activity/log.js'; serviceConnected(); serviceConnected({ offlineMs: 42_000 });`,
    ],
    { encoding: 'utf8', env: { ...base, BLACKCAT_SERVICE: 'collector' } },
  );
  assert.equal(r.status, 0, r.stderr);
  const ev = full('--kind', 'event').filter((e) => e.category === 'service: collector');
  assert.deepEqual(ev.map((e) => e.summary).sort(), ['connected', 'connected again']);
  assert.ok(ev.find((e) => e.summary === 'connected').ms > 0);
  assert.equal(ev.find((e) => e.summary === 'connected again').offlineS, 42);
  // the same code run by hand (pairing an account) is not a service connecting
  const before = full('--kind', 'event').length;
  spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `import { serviceConnected } from '${root}src/activity/log.js'; serviceConnected();`],
    {
      env: base,
    },
  );
  assert.equal(full('--kind', 'event').length, before);
});

test('what was sent and did not arrive says why', async () => {
  const { sentBy } = await import('../src/agent/scheduler.js');
  const ui = sentBy({ send: async () => Promise.reject(new Error('the channel is not connected')), sendFile: async () => false }, 'demo');
  process.env.BLACKCAT_HOME = dir;
  await assert.rejects(ui.send(1, 'private words', { what: 'the weekly report' }), /not connected/);
  assert.equal(await ui.sendFile(1, '/nowhere', { what: 'a chart' }), false);
  const sent = full('--kind', 'sent', '--failed').filter((e) => e.category === 'demo');
  assert.deepEqual(sent.map((e) => [e.summary, e.ok, e.error ?? null, e.file ?? false]).sort(), [
    ['a chart', false, null, true],
    ['the weekly report', false, 'the channel is not connected', false],
  ]);
  assert.doesNotMatch(JSON.stringify(sent), /private words/);
});

test('the kinds can be asked for by name, and each is shown with a mark of its own', () => {
  const text = bc(['activity', 'recent', '-n', '200']).stdout;
  assert.match(text, /◆ typed: \/ping/);
  assert.match(text, /→ remind: reminder \d+/);
  assert.match(bc(['activity', 'recent', '--help']).stdout, /only one kind: model, command, job, event, owner, sent/);
});
