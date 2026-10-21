// What looks wrong in the activity record, found by plain rules (no model), and the check that
// is always there to run them: "blackcat health". Each rule is tried both ways: what should be
// found, and what should not (the owner's own doings, a developer session, too few to matter).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { home, setUp } from './helpers.js';

home();
await setUp({ bot: { token: 't', allow: [{ id: 42, name: 'me' }] } });
const root = new URL('..', import.meta.url).pathname;
const bc = (...args) => {
  const { FORCE_COLOR: _f, CLAUDECODE: _c, ...env } = process.env;
  const r = spawnSync(process.execPath, [`${root}bin/bc.js`, ...args], { encoding: 'utf8', env: { ...env, NO_COLOR: '1' } });
  return { ...r, said: r.stdout + r.stderr, json: () => JSON.parse(r.stdout) };
};
const { openActivityDb } = await import('../src/activity/log.js');
const { FIXED, problems } = await import('../src/activity/problems.js');
const db = openActivityDb();
const now = () => Math.floor(Date.now() / 1000);
const H = 3600;
// One entry, `ago` seconds back.
const put = ({
  ago = 60,
  kind = 'job',
  category,
  ok = 1,
  who = 'blackcat',
  surface = 'job',
  lead = 1,
  cost = null,
  summary = null,
  data = null,
}) =>
  db
    .prepare('INSERT INTO activity (ts, kind, category, surface, ok, cost, summary, data, who, lead) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(now() - ago, kind, category, surface, ok, cost, summary, data ? JSON.stringify(data) : null, who, lead);
const keys = () => problems().map((p) => p.key);
const fresh = () => db.exec('DELETE FROM activity; DELETE FROM activity_daily');
// A day's count in the daily totals, `ago` days back.
const { dayOf } = await import('../src/activity/log.js');
const runs = (ago, category, n, { kind = 'job', who = 'blackcat' } = {}) =>
  db
    .prepare(
      "INSERT INTO activity_daily (day, kind, category, model, who, n) VALUES (?, ?, ?, '', ?, ?) ON CONFLICT DO UPDATE SET n = n + excluded.n",
    )
    .run(dayOf(now() - ago * 86400), kind, category, who, n);

test('the same thing failing again and again is found; once or twice, or what the owner or a developer did, is not', () => {
  fresh();
  for (let k = 0; k < 2; k++) put({ category: 'mail/sync', ok: 0, summary: 'could not reach the server' });
  assert.deepEqual(keys(), [], 'twice is not yet a pattern');
  put({ category: 'mail/sync', ok: 0, summary: 'could not reach the server', ago: 30 });
  const [p] = problems();
  assert.equal(p.key, 'failing-mail-sync');
  assert.match(p.title, /^mail\/sync failed 3 times in the last day, the latest: could not reach the server$/);
  fresh();
  for (let k = 0; k < 5; k++) put({ kind: 'owner', category: 'bc ssh run', ok: 0, who: 'owner', surface: 'terminal' });
  for (let k = 0; k < 5; k++) put({ kind: 'command', category: 'blackcat msg', ok: 0, who: 'dev' });
  for (let k = 0; k < 5; k++) put({ kind: 'event', category: 'check: Camera', ok: 0, summary: 'ran its fix (try 1)' });
  for (let k = 0; k < 5; k++) put({ category: 'mail/sync', ok: 0, ago: 2 * 86400 });
  assert.deepEqual(keys(), [], "the owner's own, a developer's, a check's fix, and what is more than a day old");
});

test('refused by policy, a service that stopped by itself, an account that is not paired: once is enough', () => {
  fresh();
  put({
    kind: 'command',
    category: 'for',
    who: 'agent',
    summary: 'for x in a b; do blackcat …',
    data: { decision: 'refused by policy: not run' },
  });
  put({
    kind: 'command',
    category: 'blackcat msg',
    who: 'blackcat',
    surface: 'chat',
    summary: 'blackcat msg find x',
    data: { decision: 'refused by policy: no' },
  });
  put({ kind: 'event', category: 'service: wa', ok: 0, who: null, summary: 'stopped after 4 s; started again' });
  put({ kind: 'event', category: 'service: wa', ok: 1, who: null, summary: 'connected' });
  put({ kind: 'event', category: 'channel', ok: 0, who: null, summary: 'ignored an account that is not paired (id 999)' });
  const ps = problems();
  assert.deepEqual(ps.map((p) => p.key).sort(), ['refused', 'service-wa', 'unpaired-writing']);
  // (What the agent ran in a chat is the agent's: a refusal of it is still found. The rule leaves
  // out only what the owner did directly and what a developer session did.)
  assert.equal(ps.find((p) => p.key === 'refused').title, 'A command was refused by policy, the latest: blackcat msg find x');
  assert.equal(ps.find((p) => p.key === 'service-wa').title, 'The wa service stopped after 4 s; started again');
  assert.match(ps.find((p) => p.key === 'unpaired-writing').title, /once: ignored an account that is not paired \(id 999\)/);
});

test('a look that keeps taking in as much as it may is found after four in a row', () => {
  fresh();
  const look = (more, ago) =>
    put({
      kind: 'event',
      category: 'watch: Things',
      ago,
      data: { read: more ? 500 : 12, added: 0, updated: 0, ...(more ? { more: true } : {}) },
    });
  look(false, 5 * H);
  for (let k = 3; k >= 1; k--) look(true, k * H);
  assert.deepEqual(keys(), [], 'three in a row');
  look(true, 60);
  assert.deepEqual(keys(), ['at-limit-watch-things']);
  look(false, 30);
  assert.deepEqual(keys(), [], 'the latest read all there was');
});

test("scheduled work costing far more than on a usual day, or each call far more, is found; the owner's chats are not", () => {
  fresh();
  const day = (agoDays, calls, each, extra = {}) => {
    for (let k = 0; k < calls; k++)
      put({ kind: 'model', category: 'watch: Things', lead: 0, cost: each, ago: agoDays * 86400 + 3600 + k * 60, ...extra });
  };
  for (let d = 1; d <= 6; d++) day(d, 24, 0.02);
  day(0, 24, 0.02);
  assert.deepEqual(keys(), [], 'a usual day');
  fresh();
  for (let d = 1; d <= 6; d++) day(d, 24, 0.02);
  day(0, 24, 0.06);
  const [p] = problems();
  assert.equal(p.key, 'cost-watch-things');
  assert.equal(p.title, 'watch: Things cost $1.44 in the last day, against $0.48 on a usual day before ($0.06 a call, was $0.02 at least)');
  // A cost creeping up a little each day is still found: a call is compared with the cheapest day.
  fresh();
  [0.02, 0.025, 0.03, 0.035, 0.04, 0.045].forEach((each, k) => day(6 - k, 24, each));
  day(0, 24, 0.05);
  assert.deepEqual(keys(), ['cost-watch-things']);
  // Under a dollar a day, nothing is said, however it compares.
  fresh();
  for (let d = 1; d <= 6; d++) day(d, 24, 0.001);
  day(0, 24, 0.03);
  assert.deepEqual(keys(), []);
  // What was asked for in a chat is the owner's choice.
  fresh();
  for (let d = 1; d <= 6; d++) day(d, 5, 0.05, { category: 'chat', who: 'owner', surface: 'chat' });
  day(0, 60, 0.2, { category: 'chat', who: 'owner', surface: 'chat' });
  assert.deepEqual(keys(), []);
});

test('scheduled work running far more often than usual is found, counting every run, not only those listed', () => {
  fresh();
  put({ category: 'mail/sync', ago: 2 * 86400 });
  for (let d = 2; d <= 6; d++) runs(d, 'mail/sync', 24);
  runs(1, 'mail/sync', 30);
  assert.deepEqual(keys(), []);
  runs(1, 'mail/sync', 34);
  assert.match(problems()[0].title, /^mail\/sync ran 64 times yesterday, against 24 on a usual day before$/);
  // A check that was not working is listed at each look, but it looked as often as ever.
  fresh();
  for (let d = 1; d <= 6; d++) runs(d, 'check: blackcat', 24, { kind: 'event' });
  for (let d = 2; d <= 6; d++) put({ kind: 'event', category: 'check: blackcat', summary: 'working again', ago: d * 86400 });
  for (let k = 0; k < 24; k++) put({ kind: 'event', category: 'check: blackcat', summary: 'not working', ago: k * H + 60 });
  assert.deepEqual(keys(), []);
  // Messages coming in are how many were sent, not work done on a schedule.
  fresh();
  put({ kind: 'event', category: 'messages: tg', surface: null, ago: 2 * 86400 });
  for (let d = 2; d <= 6; d++) runs(d, 'messages: tg', 30, { kind: 'event' });
  runs(1, 'messages: tg', 125, { kind: 'event' });
  assert.deepEqual(keys(), []);
  // What the owner or a developer ran is theirs.
  fresh();
  put({ category: 'mail/sync', ago: 2 * 86400 });
  for (let d = 2; d <= 6; d++) runs(d, 'mail/sync', 2, { who: 'dev' });
  runs(1, 'mail/sync', 64, { who: 'dev' });
  assert.deepEqual(keys(), []);
});

test('told it is fixed, a rule counts only what happened after that', () => {
  fresh();
  for (let k = 0; k < 4; k++) put({ category: 'mail/sync', ok: 0, ago: 2 * H });
  assert.deepEqual(keys(), ['failing-mail-sync']);
  put({
    kind: 'owner',
    category: FIXED,
    who: 'owner',
    surface: 'chat',
    ago: H,
    data: { check: 'blackcat health', key: 'failing-mail-sync' },
  });
  assert.deepEqual(keys(), [], 'the failures were before the fix');
  for (let k = 0; k < 3; k++) put({ category: 'mail/sync', ok: 0, ago: 60 });
  assert.deepEqual(keys(), ['failing-mail-sync'], 'and it failed again since');
});

test('`bc activity problems` says what it found, and fails when it found something', () => {
  fresh();
  let r = bc('activity', 'problems');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Nothing looks wrong in the last day\./);
  for (let k = 0; k < 3; k++) put({ category: 'mail/sync', ok: 0, summary: 'timeout' });
  r = bc('activity', 'problems', '--json');
  assert.equal(r.status, 1);
  assert.deepEqual(
    r.json().problems.map((p) => p.key),
    ['failing-mail-sync'],
  );
});

test('the check "blackcat health" is there from the start: each problem is a finding of its own; it can be paused, not removed or pointed elsewhere', () => {
  fresh();
  const list = bc('check', 'list', '--json').json().checks;
  const it = list.find((c) => c.name === 'blackcat health');
  assert.ok(it, 'there from the start');
  assert.equal(it.builtin, true);
  assert.equal(it.runs, 'blackcat activity problems --json');
  assert.equal(it.looks, 'at 5 minutes past the hour');
  assert.equal(it.lookFor, null, 'no model judges it');

  let r = bc('check', 'remove', 'blackcat health');
  assert.notEqual(r.status, 0);
  assert.match(r.said, /part of blackcat and can't be removed\. Pause it instead/);
  r = bc('check', 'edit', 'blackcat health', '--run', 'true');
  assert.notEqual(r.status, 0);
  assert.match(r.said, /what it looks at stays as it is/);
  r = bc('check', 'edit', 'blackcat health', '--look-for', 'anything');
  assert.notEqual(r.status, 0);
  assert.equal(bc('check', 'edit', 'blackcat health', '--alert', 'briefing').status, 0);

  // Two things wrong: two findings, each of its own.
  for (let k = 0; k < 3; k++) put({ category: 'mail/sync', ok: 0, summary: 'timeout' });
  put({ kind: 'event', category: 'service: wa', ok: 0, who: null, summary: 'stopped after 2 s; started again' });
  const run = bc('check', 'run', 'blackcat health', '--json').json().checks[0];
  assert.equal(run.result.ok, false);
  assert.equal(run.result.reason, '2 things are wrong');
  assert.deepEqual(run.result.problems.map((p) => p.key).sort(), ['failing-mail-sync', 'service-wa']);
  const shown = bc('check', 'show', 'blackcat health', '--json').json();
  assert.equal(shown.now.length, 2);
  assert.ok(shown.now.every((f) => f.state === 'open'));

  // "I fixed it": the failures before now no longer count, and both are over.
  r = bc('check', 'fixed', 'blackcat health', '--no-wait', '--json');
  assert.equal(r.json().working, true);
  assert.equal(bc('check', 'show', 'blackcat health', '--json').json().now.length, 0);
  assert.equal(
    db.prepare('SELECT COUNT(*) FROM activity WHERE category = ?').pluck().get(FIXED),
    2,
    'what the owner said was fixed is on the record, one entry each',
  );

  assert.equal(bc('check', 'edit', 'blackcat health', '--pause').status, 0);
  assert.equal(
    bc('check', 'list', '--json')
      .json()
      .checks.find((c) => c.builtin).active,
    false,
  );
});

test('the built-in check tells the owner, wherever they are', async () => {
  const { openChecksDb, listChecks } = await import('../src/checks/db.js');
  const cdb = openChecksDb();
  const it = listChecks(cdb).find((c) => c.builtin);
  assert.equal(cdb.prepare('SELECT chat_id FROM checks WHERE id = ?').pluck().get(it.id), null, 'no chat of its own');
  assert.equal(it.chat_id, 42, "the owner's");
  cdb.close();
});

test('a check still called "blackcat itself" is renamed "blackcat health"; a name the owner gave it stays', async () => {
  const { openChecksDb } = await import('../src/checks/db.js');
  const { openAgentDb } = await import('../src/agentdb.js');
  const back = (name) => {
    const a = openAgentDb();
    a.prepare("UPDATE checks SET name = ? WHERE builtin = 'itself'").run(name);
    a.prepare("UPDATE shapes SET step = step - 1 WHERE part = 'checks'").run();
    a.close();
    const c = openChecksDb();
    const got = c.prepare("SELECT name FROM checks WHERE builtin = 'itself'").get().name;
    c.close();
    return got;
  };
  assert.equal(back('blackcat itself'), 'blackcat health');
  assert.equal(back('Mine'), 'Mine');
  back('blackcat health');
});
