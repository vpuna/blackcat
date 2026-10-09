// A check looks at a system on a schedule, keeps whether it is working, tells the owner when
// that changes, and may try a fix the owner approved. It is a part of blackcat of its own:
// not a kind of watch, which reads messages and keeps a list.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { home } from './helpers.js';

const dir = home();
const root = new URL('..', import.meta.url).pathname;
const { save } = await import('../src/config.js');
save({});
const plain = (extra = {}) => {
  const { FORCE_COLOR: _f, ...env } = process.env;
  return { ...env, NO_COLOR: '1', ...extra };
};
const bc = (...args) => {
  const r = spawnSync(process.execPath, [`${root}bin/bc.js`, ...args], { encoding: 'utf8', env: plain() });
  return { ...r, said: r.stdout + r.stderr, json: () => JSON.parse(r.stdout) };
};
const flag = path.join(dir, 'working.flag');
const { listRules } = await import('../src/agent/permissions.js');
const ruleOf = (command) => listRules().find((r) => r.command === command) ?? null;

test('a check is set up, looked at straight away, and shown with how it is doing', () => {
  fs.writeFileSync(flag, 'x');
  const made = bc('check', 'add', 'Web', 'server', '--run', `test -f ${flag}`, '--every', '10m', '--json').json();
  assert.deepEqual(
    [made.id, made.name, made.runs, made.looks, made.state, made.tested.ok, made.active],
    [1, 'Web server', `test -f ${flag}`, 'every 10 minutes', 'working', true, true],
  );
  assert.match(
    bc('check', 'list').stdout,
    /1 {2}Web server\n\s+looks at: runs `test -f [^`]+`\n\s+looks: {4}every 10 minutes\n\s+state: {4}fine \(checked \d+m \d+s ago: all checks passed\)/,
  );
  const shown = bc('check', 'show', 'web').stdout;
  assert.match(shown, /^Web server\n/);
  assert.match(shown, /Nothing has gone wrong since it was set up\./);
  assert.deepEqual(
    bc('check', 'list', '--json')
      .json()
      .checks.map((c) => c.name),
    ['Web server'],
  );
  assert.match(bc('status').stdout, /Checks\s+1 check · all fine/);
});

test('what is refused when setting one up, said plainly', () => {
  for (const [args, why] of [
    [['add', 'Nothing'], /needs something to look at: --run "<command>", --file <path>, or both/],
    [['add', 'Old', '--run', 'true', '--max-age', '10m'], /--max-age needs --file/],
    [['add', 'Often', '--run', 'true', '--every', '1m'], /no more often than every 5 minutes/],
    [['add', 'Tries', '--run', 'true', '--fix', 'true', '--tries', '9'], /--tries is a number from 1 to 5/],
    [['add', 'Wait', '--run', 'true', '--fix', 'true', '--wait', '20m'], /--wait can be at most 10m/],
    [['add', 'Web server', '--run', 'true'], /already a check called "Web server"/],
    [['show', 'nothing-such'], /No single check matches "nothing-such"/],
    [['edit', 'web'], /Say what to change/],
  ]) {
    const r = bc('check', ...args);
    assert.notEqual(r.status, 0, args.join(' '));
    assert.match(r.said, why, args.join(' '));
  }
  assert.equal(bc('check', 'list', '--json').json().checks.length, 1, 'and nothing was created by any of them');
  // a watch reads messages: it has none of this
  assert.match(bc('watch', 'add', 'Sky', '--check', 'true').said, /unknown option '--check'/);
});

test('one that does not pass its first look starts paused, and its fix has not been run', () => {
  const made = bc('check', 'add', 'Broken', '--run', 'false', '--fix', `touch ${path.join(dir, 'fix-ran')}`, '--json').json();
  assert.deepEqual([made.active, made.paused, made.tested.ok], [false, true, false]);
  assert.match(made.advice, /It is paused, and its fix has not been run/);
  assert.ok(!fs.existsSync(path.join(dir, 'fix-ran')));
  // its fix was given a standing permission, in the check's name; removing the check takes it back
  assert.equal(ruleOf(`touch ${path.join(dir, 'fix-ran')}`)?.via, `check ${made.id}`);
  assert.match(bc('check', 'remove', 'broken').stdout, /Check "Broken" removed, and its fix may no longer run by itself/);
  assert.equal(ruleOf(`touch ${path.join(dir, 'fix-ran')}`), null);
});

test('it stops working: the owner is told once, the fix is tried, and told again when it is well', async () => {
  const { getCheck, incidents, openChecksDb, updateCheck } = await import('../src/checks/db.js');
  const { runCheck } = await import('../src/checks/check.js');
  const db = openChecksDb();
  const look = async () => runCheck(db, getCheck(db, 1));

  // no fix: told when it stops, not again while it stays so, and told when it recovers
  fs.rmSync(flag);
  let r = await look();
  assert.equal(r.result.ok, false);
  assert.match(r.notices[0], /^⚠️ Web server: not working\. `test -f .*` failed \(exit 1\)\. I'll tell you when it recovers\.$/);
  assert.deepEqual([getCheck(db, 1).state.status, incidents(db, 1).map((i) => i.open)], ['failing', [1]]);
  assert.match(bc('check', 'show', '1').stdout, /Not working: `test -f .*` failed \(exit 1\) {2}\(still so\)/);
  assert.match(bc('status').stdout, /Checks\s+1 check · 1 NOT WORKING/);
  r = await look();
  assert.deepEqual(r.notices, [], 'nothing more is said while it stays so');
  fs.writeFileSync(flag, 'x');
  r = await look();
  assert.match(r.notices[0], /^✅ Web server: working again \(it had not been since /);
  assert.deepEqual([getCheck(db, 1).state.status, incidents(db, 1).map((i) => i.open)], ['ok', [0]]);

  // with a fix that works: it is run, and the owner is told what was done
  bc('check', 'edit', '1', '--fix', `touch ${flag}`, '--wait', '1s');
  assert.equal(ruleOf(`touch ${flag}`)?.via, 'check 1');
  fs.rmSync(flag);
  r = await look();
  assert.match(r.notices[0], /^🔧 Web server: it was not working \(.*\)\. I ran `touch .*` 1 time and it is working again\./);
  assert.equal(getCheck(db, 1).state.status, 'ok');
  assert.match(incidents(db, 1)[0].title, /^Fixed: /);

  // the owner takes the permission back: the fix is not run, and that is said
  const { removeRule } = await import('../src/agent/permissions.js');
  removeRule(ruleOf(`touch ${flag}`).id);
  fs.rmSync(flag);
  r = await look();
  assert.match(r.notices[0], /not working\..*Its automatic fix is no longer permitted \(\/permissions\), so I ran nothing\./);
  assert.ok(!fs.existsSync(flag));
  assert.match(bc('check', 'list').stdout, /fix: `touch [^`]+`, up to 2 tries, 1s apart \(NOT PERMITTED: see \/permissions\)/);

  // a dry run only looks: nothing is said, fixed or changed
  updateCheck(db, 1, { state: { status: 'ok' } });
  const dry = await runCheck(db, getCheck(db, 1), { dryRun: true });
  assert.deepEqual([dry.result.ok, dry.notices, getCheck(db, 1).state.status], [false, [], 'ok']);
  fs.writeFileSync(flag, 'x');
  db.close();
});

test('a file that should keep changing: missing, empty, or gone stale', async () => {
  const { evaluate } = await import('../src/checks/check.js');
  const pic = path.join(dir, 'latest.jpg');
  assert.match((await evaluate({ name: 'Pic', file: pic, maxAge: '10m' })).reason, /does not exist/);
  fs.writeFileSync(pic, '');
  assert.match((await evaluate({ name: 'Pic', file: pic, maxAge: '10m' })).reason, /latest\.jpg is empty/);
  fs.writeFileSync(pic, 'jpg');
  assert.deepEqual(await evaluate({ name: 'Pic', file: pic, maxAge: '10m' }), { ok: true, reason: 'all checks passed' });
  const old = new Date(Date.now() - 3600_000);
  fs.utimesSync(pic, old, old);
  assert.match((await evaluate({ name: 'Pic', file: pic, maxAge: '10m' })).reason, /latest\.jpg has not changed for 1h 0m \(limit 10m\)/);
  // a command that never ends counts as not working
  assert.match((await evaluate({ name: 'Exit', command: 'exit 3' })).reason, /`exit 3` failed \(exit 3\)/);
});

test('changing one: what is not given stays; pausing; and looking when its turn comes', async () => {
  const { getCheck, openChecksDb, updateCheck } = await import('../src/checks/db.js');
  const { dueChecks } = await import('../src/checks/commands.js');
  const edited = bc('check', 'edit', 'web', '--every', '08:00,20:00', '--name', 'Site', '--json').json();
  assert.deepEqual(
    [edited.name, edited.looks, edited.runs, edited.fix],
    ['Site', 'at 08:00 and 20:00', `test -f ${flag}`, `touch ${flag}`],
  );
  assert.equal(bc('check', 'edit', 'site', '--no-fix', '--json').json().fix, null);
  assert.equal(bc('check', 'edit', 'site', '--pause', '--json').json().active, false);
  const db = openChecksDb();
  assert.deepEqual(
    dueChecks(db).map((c) => c.name),
    [],
    'a paused one is never due',
  );
  bc('check', 'edit', 'site', '--resume', '--every', '10m');
  updateCheck(db, 1, { last_run: Math.floor(Date.now() / 1000) - 3600 });
  assert.deepEqual(
    dueChecks(db).map((c) => c.name),
    ['Site'],
  );
  // the scheduler's run: those whose turn it is, and each marked as looked at
  const ran = bc('check', 'run', '--due', '--json').json().checks;
  assert.deepEqual(
    ran.map((c) => [c.name, c.result.ok, c.notices.length]),
    [['Site', true, 0]],
  );
  assert.ok(getCheck(db, 1).last_run > Date.now() / 1000 - 30);
  assert.deepEqual(bc('check', 'run', '--due', '--json').json().checks, []);
  assert.match(bc('check', 'run', 'site', '--dry-run').stdout, /^Site: working\. all checks passed/);
  db.close();
});

test("the agent may look; setting one up, changing or removing one needs the owner's say, with the commands shown", async () => {
  const { loadPlugins } = await import('../src/plugins/registry.js');
  await loadPlugins();
  const { decide } = await import('../src/agent/policy.js');
  for (const c of ['blackcat check list --json', 'blackcat check show site --json', 'blackcat check run site --dry-run --json'])
    assert.equal(decide('Bash', { command: c }).action, 'allow', c);
  for (const c of [
    "blackcat check add Web --run 'systemctl is-active web' --fix 'sudo systemctl restart web' --json",
    'blackcat check edit site --resume --json',
    'blackcat check remove site --json',
  ])
    assert.equal(decide('Bash', { command: c }).action, 'ask', c);
});

test('the briefing says what is not working, or that all is well', async () => {
  const { forBriefing } = await import('../src/checks/chat.js');
  assert.deepEqual(forBriefing(), { problems: [], fine: '✅ Site: fine' });
  fs.rmSync(flag);
  bc('check', 'run', 'site');
  const said = forBriefing();
  assert.match(said.problems[0], /^⚠️ <b>Site<\/b>: not working since /);
  assert.equal(said.fine, null);
  const briefing = bc('watch', 'briefing', '--print').stdout;
  assert.match(briefing, /Site: not working since /);
  fs.writeFileSync(flag, 'x');
  bc('check', 'run', 'site');
  // (said in the briefing only when nothing else is wrong either)
  assert.deepEqual(forBriefing(), { problems: [], fine: '✅ Site: fine' });
  assert.doesNotMatch(bc('watch', 'briefing', '--print').stdout, /Site: not working/);
});
