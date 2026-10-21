// What a check saw, kept for a while (data/check-history.db): the figures from each look, a
// limit on them, what was going on when one was passed, and checks that plugins offer ready to
// add. So "why was the server hot last night?" is answered from what was recorded.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { home } from './helpers.js';

const dir = home();
const root = new URL('..', import.meta.url).pathname;
// A plugin of the owner's that offers a check, as ssh or unifi do.
fs.mkdirSync(path.join(dir, 'user-plugins/meter'), { recursive: true });
fs.writeFileSync(
  path.join(dir, 'user-plugins/meter/plugin.js'),
  `export default {
  api: 1, name: 'meter', title: 'Meter', description: 'a test plugin',
  commands: { reading: { summary: 'how hot it is', access: 'allow', run: () => 'warm' } },
  checks: [{ id: 'heat', name: 'Meter heat', summary: 'how hot it runs', run: 'cat ${dir}/temp', limit: ['temp>75'], context: 'echo busy: transcoding', every: '10m' }],
};`,
);
const { save } = await import('../src/config.js');
save({ plugins: { enabled: ['meter'] } });
{
  const { openChecksDb } = await import('../src/checks/db.js');
  const db = openChecksDb();
  db.exec("DELETE FROM checks WHERE builtin IS NOT NULL; DELETE FROM sqlite_sequence WHERE name = 'checks';");
  db.close();
}
const bc = (...args) => {
  const { FORCE_COLOR: _f, ...env } = process.env;
  const r = spawnSync(process.execPath, [`${root}bin/bc.js`, ...args], { encoding: 'utf8', env: { ...env, NO_COLOR: '1' } });
  return { ...r, said: r.stdout + r.stderr, json: () => JSON.parse(r.stdout) };
};
const temp = (n) => fs.writeFileSync(path.join(dir, 'temp'), `${n}\n`);
const { figures } = await import('../src/checks/check.js');
const history = await import('../src/checks/history.js');

test('the figures in what a command prints: JSON, one number alone, or name=value lines', () => {
  assert.deepEqual(figures('{"tempC": 54.5, "load": [1.2, 3]}', ['tempC', 'load.0']), {
    numbers: { tempC: 54.5, 'load.0': 1.2 },
    missing: [],
  });
  assert.deepEqual(figures('74.5\n', ['temp']), { numbers: { temp: 74.5 }, missing: [] });
  assert.deepEqual(figures('temp=74\nload: 3.2\n', ['temp', 'load', 'fans']), { numbers: { temp: 74, load: 3.2 }, missing: ['fans'] });
  assert.deepEqual(figures('74', ['temp', 'load']).missing, ['temp', 'load'], 'a number alone is one figure only');
});

test('a check with a limit: each look kept; past it, not working, with which way it went and what was going on', async () => {
  temp(60);
  const made = bc(
    'check',
    'add',
    'Server',
    'heat',
    '--run',
    `cat ${dir}/temp`,
    '--limit',
    'temp>75',
    '--context',
    'echo busy: backup',
    '--json',
  ).json();
  assert.deepEqual([made.limits, made.measure, made.state], [['temp>75'], null, 'working']);
  assert.match(made.what, /not working when temp is above 75 · when it is not, keeps what `echo busy: backup` prints/);
  const { getCheck, openChecksDb, addFinding, resolveFinding } = await import('../src/checks/db.js');
  const { runCheck } = await import('../src/checks/check.js');
  const db = openChecksDb();
  const look = async () => runCheck(db, getCheck(db, 1));
  let r = await look();
  assert.deepEqual([r.result.ok, r.result.numbers], [true, { temp: 60 }]);
  // (Readings from earlier, as if it had been looking for an hour; and a time it was too hot before.)
  const now = Math.floor(Date.now() / 1000);
  {
    const { openSqlite } = await import('../src/db.js');
    const h = openSqlite(history.HISTORY_DB);
    h.prepare("INSERT INTO history (check_id, ts, kind, numbers) VALUES (1, ?, 'reading', ?)").run(
      now - 2700,
      JSON.stringify({ temp: 70 }),
    );
    h.close();
    const before = addFinding(db, 1, { key: 'temp-high', title: 'temp 77, above 75' });
    db.prepare('UPDATE check_findings SET first_seen = ?, last_seen = ? WHERE id = ?').run(now - 5 * 86400, now - 5 * 86400, before.id);
    resolveFinding(db, before.id);
    db.prepare('UPDATE check_findings SET resolved_ts = ? WHERE id = ?').run(now - 5 * 86400 + 2400, before.id);
  }

  temp(80);
  r = await look();
  assert.equal(r.result.ok, false);
  assert.match(
    r.notices[0].text,
    /^⚠️ Server heat: temp 80, above 75\. Rising: it was 70 45m ago\. Last time \(.+\) it lasted 40m\. What was going on is kept: bc check history 1$/,
  );
  r = await look();
  assert.deepEqual(r.notices, [], 'nothing more is said while it stays so');
  assert.equal(history.contexts(1, 0, now + 60).length, 1, 'what was going on is kept once, not on every look');

  temp(64);
  r = await look();
  assert.match(r.notices[0].text, /^✅ Server heat: working again\. It had not been since .*: down \d+s, peak temp 80\./);
  db.close();

  const h = bc('check', 'history', 'server', '--json').json();
  assert.equal(h.figures[0].field, 'temp');
  assert.equal(h.figures[0].range, '60 to 80');
  assert.equal(h.figures[0].now, 64);
  assert.equal(h.readings.length, 6, 'the first look when it was added, and five more');
  assert.deepEqual(
    h.incidents.map((n) => [n.title, n.context.map((k) => k.output)]),
    [['temp 80, above 75', ['busy: backup']]],
    'only what was wrong in the time asked about, with what was going on',
  );
  assert.match(
    bc('check', 'history', 'server').stdout,
    /temp: 60 to 80, now 64 \(6 readings\)\n\nNot working:\n {3}.* \(\d+s\): temp 80, above 75\n {6}What was going on, .*:\n {8}busy: backup/,
  );
});

test('a figure that is not printed is a check that is not working; what is set is refused plainly when wrong', () => {
  temp('hot');
  const made = bc('check', 'add', 'Odd', '--run', `cat ${dir}/temp`, '--measure', 'temp', '--json').json();
  assert.deepEqual([made.active, made.tested.ok], [false, false]);
  assert.match(made.tested.reason, /printed no temp$/);
  for (const [args, why] of [
    [['add', 'X', '--file', '/tmp/x', '--limit', 'temp>3'], /--measure and --limit need --run/],
    [['add', 'X', '--run', 'true', '--limit', 'temp=3'], /A limit is a figure, > or <, and a number/],
    [['add', 'X', '--run', 'true', '--keep', '2h'], /--keep is from 1d to 365d/],
  ])
    assert.match(bc('check', ...args).said, why);
  bc('check', 'remove', 'Odd');
});

test('history is kept as long as the check says, and goes with the check', async () => {
  const { openSqlite } = await import('../src/db.js');
  const old = Math.floor(Date.now() / 1000) - 40 * 86400;
  const h = openSqlite(history.HISTORY_DB);
  h.prepare("INSERT INTO history (check_id, ts, kind, numbers) VALUES (1, ?, 'reading', '{\"temp\":50}')").run(old);
  h.prepare("INSERT INTO history (check_id, ts, kind, numbers) VALUES (99, ?, 'reading', '{\"temp\":50}')").run(old + 39 * 86400);
  assert.equal(h.pragma('auto_vacuum', { simple: true }), 2, 'the file shrinks after pruning');
  h.close();
  history.addReading(1, { temp: 51 }, 30 * 86400);
  assert.equal(history.readings(1, 0).filter((r) => r.ts === old).length, 0, 'older than 30 days: gone');
  history.keepOnly([1]);
  assert.equal(history.readings(99, 0).length, 0, 'what is left of a check that is gone goes');
  assert.match(bc('check', 'remove', 'server').said, /removed/);
  assert.deepEqual([history.readings(1, 0).length, history.contexts(1, 0, Date.now()).length], [0, 0]);
});

test('a check a plugin offers: listed, and added with limits of your own', () => {
  const offered = bc('check', 'offered', '--json').json().offered;
  assert.deepEqual(
    offered.map((o) => [o.ref, o.name, o.limit]),
    [['meter:heat', 'Meter heat', ['temp>75']]],
  );
  temp(60);
  const made = bc('check', 'add', '--from', 'meter:heat', '--limit', 'temp>70', '--json').json();
  assert.deepEqual(
    [made.name, made.runs, made.limits, made.context, made.looks, made.state],
    ['Meter heat', `cat ${dir}/temp`, ['temp>70'], 'echo busy: transcoding', 'every 10 minutes', 'working'],
  );
  assert.equal(bc('check', 'history', 'Meter heat', '--json').json().readings.length, 1, 'its first look is its first reading');
  assert.match(bc('check', 'add', '--from', 'meter:nothing').said, /Nothing is offered as "meter:nothing"/);
  // A long command is cut to its start in the list; shown, it is whole.
  bc('check', 'edit', 'Meter heat', '--run', `cat ${dir}/temp # ${'x'.repeat(80)}`);
  assert.match(bc('check', 'list').said, /runs `cat [^`]*x…`/);
  assert.match(bc('check', 'show', 'Meter heat').said, new RegExp(`x{80}\``));
});

test("a plugin whose `checks` are the engine check's requests is told they are `trials` now", async () => {
  const { problems } = await import('../src/plugins/registry.js');
  const said = problems({ api: 1, name: 'x', title: 'X', description: 'x', checks: [{ say: 'hi', expect: /x/ }] }, 'x');
  assert.ok(
    said.some((p) => /^checks\[\]: each needs `id`, `name` and `run` \(the engine check's requests are `trials` now\)$/.test(p)),
    said.join('\n'),
  );
});
