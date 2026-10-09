// Cron is the one schedule format: the briefing, a watch's report, when a watch looks, a
// shortcut sent by itself, a repeating reminder and a plugin's job all take it, all show it
// back in words, and all still read what was stored before they did.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { home, setUp } from './helpers.js';

home();
const root = new URL('..', import.meta.url).pathname;
const { save, load } = await import('../src/config.js');
await setUp({
  bot: { allow: [{ id: 42, name: 'me' }] },
  plugins: {
    settings: {
      watch: { briefing: { cron: ['30 6 * * *'], on: true } },
      shortcut: { shortcuts: { old: { description: 'sent by itself', run: ['true'], cron: ['0 8,19 * * 1,5'], since: 1 } } },
    },
  },
});

function bc(...args) {
  const r = spawnSync(process.execPath, [`${root}bin/bc.js`, ...args], { encoding: 'utf8', env: process.env, timeout: 60_000 });
  return { ok: r.status === 0, out: r.stdout.trim(), err: r.stderr.trim(), json: () => JSON.parse(r.stdout) };
}

test('the briefing: set as cron, as times and days, and refused when wrong', () => {
  assert.match(bc('watch', 'briefing', '--show').out, /At 06:30/);
  let r = bc('watch', 'briefing', '--cron', '0 7,18 * * 1-5', '--cron', '30 9 * * 6,0', '--json');
  assert.ok(r.ok, r.err);
  assert.deepEqual(r.json().cron, ['0 7,18 * * 1-5', '30 9 * * 6,0']);
  assert.equal(r.json().description, 'At 07:00 and 18:00, Monday through Friday; and At 09:30, only on Sunday and Saturday');
  assert.equal(r.json().next.length, 3);
  assert.deepEqual(load().plugins.settings.watch.briefing, { on: true, cron: ['0 7,18 * * 1-5', '30 9 * * 6,0'] });

  r = bc('watch', 'briefing', '--at', '07:00', '--at', '18:30', '--days', 'weekdays', '--json');
  assert.deepEqual(r.json().cron, ['0 7 * * 1-5', '30 18 * * 1-5']);
  assert.equal(bc('watch', 'briefing', '--off', '--json').json().on, false);
  assert.deepEqual(bc('watch', 'briefing', '--on', '--json').json(), {
    ...r.json(),
    next: bc('watch', 'briefing', '--show', '--json').json().next,
  });

  for (const bad of [
    ['--cron', '61 7 * * *'],
    ['--cron', 'every morning'],
    ['--cron', '0 0 7 * * *'],
    ['--at', '25:00'],
    ['--days', 'weekdays'],
  ]) {
    const x = bc('watch', 'briefing', ...bad);
    assert.equal(x.ok, false, bad.join(' '));
  }
  assert.deepEqual(load().plugins.settings.watch.briefing.cron, ['0 7 * * 1-5', '30 18 * * 1-5'], 'a refused change leaves it as it was');
});

test('"Things I need to do" looks every hour on a new installation, until told otherwise', () => {
  const w = bc('watch', 'list', '--json')
    .json()
    .find((x) => x.builtin === 'todo');
  assert.deepEqual(w.scan.cron, ['0 * * * *']);
  assert.equal(w.looks, 'every hour');
});

test('a watch: its report and when it looks are cron, however they were said', () => {
  let w = bc('watch', 'add', 'Weekend ideas', '--cron', '0 18 * * 4', '--scan', '0 8,20 * * *', '--json').json();
  assert.equal(w.mode, 'digest');
  assert.deepEqual([w.report.cron, w.scan.cron], [['0 18 * * 4'], ['0 8,20 * * *']]);
  assert.match(w.schedule, /at 18:00, only on Thursday/);
  assert.equal(w.looks, 'at 08:00 and 20:00');

  w = bc('watch', 'add', 'Plain', '--days', 'fri,sat', '--at', '09:15', '--scan', '30m', '--json').json();
  assert.deepEqual([w.report.cron, w.scan.cron], [['15 9 * * 5,6'], ['*/30 * * * *']]);
  w = bc('watch', 'edit', 'Plain', '--scan', '07:00,19:00', '--cron', '0 9 1 * *', '--json').json();
  assert.deepEqual([w.report.cron, w.scan.cron], [['0 9 1 * *'], ['0 7,19 * * *']]);

  w = bc('watch', 'add', 'Default', '--json').json();
  assert.deepEqual(w.scan.cron, ['*/15 * * * *']);
  assert.equal(w.report, null, 'a watch that reports in the briefing has no report schedule of its own');

  for (const bad of [
    ['--scan', '* * * * *'],
    ['--scan', '2m'],
    ['--scan', '45m'],
    ['--cron', '0 18 * * 9'],
    ['--at', '18:00'],
  ]) {
    assert.equal(bc('watch', 'edit', 'Plain', ...bad).ok, false, bad.join(' '));
  }
});

test('whose turn it is to look follows the cron', async () => {
  const { openWatchDb, listWatches, updateWatch } = await import('../src/watch/db.js');
  const { dueWatches } = await import('../src/watch/collect.js');
  const db = openWatchDb();
  const w = listWatches(db).find((x) => x.name === 'Weekend ideas'); // looks at 08:00 and 20:00
  const at = (h, m = 0) => new Date(2026, 9, 5, h, m).getTime();
  updateWatch(db, w.id, { lastScan: Math.floor(at(8) / 1000) });
  const due = (ms) => dueWatches(db, ms).some((x) => x.id === w.id);
  assert.deepEqual([due(at(12)), due(at(19, 59)), due(at(20)), due(at(23))], [false, false, true, true]);
  updateWatch(db, w.id, { lastScan: Math.floor(at(20) / 1000) });
  assert.equal(due(at(23)), false);
  db.close();
});

test('a shortcut: its schedule is cron, however it was said', () => {
  assert.match(bc('shortcut', 'list').out, /at 08:00 and 19:00, only on Monday and Friday/i);
  let r = bc('shortcut', 'schedule', 'old', '--cron', '0 19 * * 6,0', '--json').json();
  assert.deepEqual(r.cron, ['0 19 * * 6,0']);
  assert.equal(r.next.length, 3);
  const sc = load().plugins.settings.shortcut.shortcuts.old;
  assert.deepEqual([sc.cron, sc.at, sc.days], [['0 19 * * 6,0'], undefined, undefined]);
  r = bc('shortcut', 'schedule', 'old', '--at', '08:00', '--days', 'weekdays', '--json').json();
  assert.deepEqual(r.cron, ['0 8 * * 1-5']);
  assert.equal(bc('shortcut', 'schedule', 'old', '--cron', 'nonsense').ok, false);
  assert.deepEqual(load().plugins.settings.shortcut.shortcuts.old.cron, ['0 8 * * 1-5']);
  bc('shortcut', 'schedule', 'old', '--off');
  assert.equal(load().plugins.settings.shortcut.shortcuts.old.cron, undefined);
});

test('a repeating reminder is cron, and comes round when the cron says', async () => {
  let r = bc('remind', 'add', 'Bins', '--cron', '0 20 * * 1,4', '--json').json();
  assert.equal(r.repeat, '0 20 * * 1,4');
  assert.match(r.repeats, /at 20:00, only on Monday and Thursday/);
  r = bc('remind', 'add', 'Rent', '--at', '2027-03-01 09:30', '--repeat', 'monthly', '--json').json();
  assert.equal(r.repeat, '30 9 1 * *');
  r = bc('remind', 'add', 'Stretch', '--at', '2027-03-02 07:00', '--repeat', 'weekdays', '--json').json();
  assert.equal(r.repeat, '0 7 * * 1-5');
  for (const bad of [
    ['--cron', '*/5 * * * *'],
    ['--cron', 'x'],
    ['--repeat', 'fortnightly', '--at', '2027-03-02 07:00'],
    ['--cron', '0 7 * * *', '--repeat', 'daily'],
  ]) {
    assert.equal(bc('remind', 'add', 'Nope', ...bad).ok, false, bad.join(' '));
  }
  const { nextRepeat, repeatCron } = await import('../src/util/when.js');
  const ts = (y, mo, d, h, mi = 0) => Math.floor(new Date(y, mo - 1, d, h, mi).getTime() / 1000);
  assert.equal(nextRepeat(ts(2026, 10, 5, 20), '0 20 * * 1,4'), ts(2026, 10, 8, 20)); // Monday → Thursday
  assert.equal(nextRepeat(ts(2026, 10, 9, 7), '0 7 * * 1-5'), ts(2026, 10, 12, 7)); // Friday → Monday
  assert.equal(nextRepeat(ts(2026, 10, 5, 7), '0 7 * * 1-5;30 9 * * 6,0'), ts(2026, 10, 6, 7));
  // the words reminders were kept with before still work
  assert.equal(nextRepeat(ts(2026, 10, 5, 20), 'weekly'), ts(2026, 10, 12, 20));
  assert.equal(nextRepeat(ts(2026, 10, 9, 7), 'weekdays'), ts(2026, 10, 12, 7));
  assert.equal(nextRepeat(ts(2026, 10, 5, 20), null), null);
  assert.equal(repeatCron('weekly', ts(2026, 10, 5, 20, 15)), '15 20 * * 1');
});

test('a plugin job: cron, the two shorthands, and a schedule that is wrong', async () => {
  const { jobSchedule, due } = await import('../src/util/schedule.js');
  assert.deepEqual(jobSchedule({ cron: '*/5 * * * *' }), ['*/5 * * * *']);
  assert.deepEqual(jobSchedule({ cron: (ctx) => `0 ${ctx.hour} * * *` }, { hour: 3 }), ['0 3 * * *']);
  assert.deepEqual(jobSchedule({ every: '15m' }), ['*/15 * * * *']);
  assert.deepEqual(jobSchedule({ at: ['04:10'] }), ['10 4 * * *']);
  assert.throws(() => jobSchedule({ cron: 'hourly' }));
  // every bundled plugin's jobs have a schedule that can be read
  const { loadPlugins, describeJob, makeCtx } = await import('../src/plugins/registry.js');
  const { default: fs } = await import('node:fs');
  save({ ...load(), plugins: { ...load().plugins, enabled: fs.readdirSync(`${root}plugins`) } });
  let jobs = 0;
  for (const p of await loadPlugins())
    for (const j of p.manifest.jobs ?? []) {
      jobs++;
      assert.doesNotMatch(describeJob(j, makeCtx(p)), /no valid schedule/, `${p.name}.${j.id}`);
    }
  assert.ok(jobs >= 5);
  // a job runs once per moment: not before, once when it comes, not again
  const t = (h, m) => new Date(2026, 9, 5, h, m).getTime();
  const last = Math.floor(t(9, 0) / 1000);
  assert.deepEqual(
    [due('*/15 * * * *', last, t(9, 14)), due('*/15 * * * *', last, t(9, 15)), due('*/15 * * * *', Math.floor(t(9, 15) / 1000), t(9, 16))],
    [null, Math.floor(t(9, 15) / 1000), null],
  );
});
