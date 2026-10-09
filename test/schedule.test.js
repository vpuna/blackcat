// Every repeating schedule in blackcat is cron. This is the one module that reads it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ScheduleError,
  daysOf,
  describe,
  due,
  fromEvery,
  fromTimes,
  isSchedule,
  nextRuns,
  schedule,
  shortestGap,
  summary,
  toSchedule,
} from '../src/util/schedule.js';

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const secs = (ms) => Math.floor(ms / 1000);

test('valid expressions are accepted and tidied; anything else is refused with a reason', () => {
  assert.deepEqual(schedule('0 7 * * *'), ['0 7 * * *']);
  assert.deepEqual(schedule(['0  7 * * 1-5', ' 30 9 * * 6,0 ']), ['0 7 * * 1-5', '30 9 * * 6,0']);
  assert.deepEqual(schedule(['0 7 * * *', '0 7 * * *']), ['0 7 * * *']);
  for (const bad of ['', 'every day', '61 7 * * *', '0 25 * * *', '0 7 * *', '0 0 7 * * *', '0 7 * * 9', null, '* * * * * *']) {
    assert.throws(() => schedule(bad), ScheduleError, String(bad));
    assert.equal(isSchedule(bad), false);
  }
  assert.equal(isSchedule('*/15 * * * *'), true);
});

test('described in English', () => {
  assert.equal(describe('0 7 * * *'), 'At 07:00');
  assert.equal(describe('0 7,18 * * 1-5'), 'At 07:00 and 18:00, Monday through Friday');
  assert.equal(describe('*/15 * * * *'), 'Every 15 minutes');
  assert.equal(describe(['0 7 * * 1-5', '30 9 * * 6,0']), 'At 07:00, Monday through Friday; and At 09:30, only on Sunday and Saturday');
  assert.match(summary('0 7 * * *', at(2026, 10, 5, 12)), /^At 07:00 \(next: Tue,? 6 Oct,? 07:00\)$/);
});

test('next runs, across several expressions, in order', () => {
  const from = at(2026, 10, 5, 6, 0); // a Monday
  assert.deepEqual(nextRuns('0 7,18 * * 1-5', 3, from), [at(2026, 10, 5, 7), at(2026, 10, 5, 18), at(2026, 10, 6, 7)].map(secs));
  assert.deepEqual(
    nextRuns(['0 7 * * 1-5', '30 9 * * 6,0'], 6, at(2026, 10, 9, 8)).map((t) => new Date(t * 1000).getDay()),
    [6, 0, 1, 2, 3, 4],
  );
  // weekends are skipped by a weekday schedule
  assert.deepEqual(nextRuns('0 7 * * 1-5', 1, at(2026, 10, 9, 8)), [secs(at(2026, 10, 12, 7))]);
});

test('due: the most recent moment that has passed since last time, once', () => {
  const s = '0 7,18 * * *';
  const last = secs(at(2026, 10, 5, 7));
  assert.equal(due(s, last, at(2026, 10, 5, 17, 59)), null, 'nothing new yet');
  assert.equal(due(s, last, at(2026, 10, 5, 18, 0)), secs(at(2026, 10, 5, 18)), 'exactly on time');
  assert.equal(due(s, last, at(2026, 10, 5, 18, 0) + 20_000), secs(at(2026, 10, 5, 18)));
  assert.equal(due(s, secs(at(2026, 10, 5, 18)), at(2026, 10, 5, 18, 5)), null, 'not twice');
  // off for three days: one catch-up, for the latest moment missed
  assert.equal(due(s, last, at(2026, 10, 8, 9)), secs(at(2026, 10, 8, 7)));
  // off for a year on an every-minute schedule: answers at once, with the latest minute
  const t0 = Date.now();
  assert.equal(due('* * * * *', secs(at(2025, 10, 5, 7)), at(2026, 10, 5, 7, 0)), secs(at(2026, 10, 5, 7)));
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(due(['0 7 * * *', '30 9 * * *'], last, at(2026, 10, 6, 10)), secs(at(2026, 10, 6, 9, 30)));
});

test('the shortest gap between runs', () => {
  assert.equal(shortestGap('*/15 * * * *'), 900);
  assert.equal(shortestGap('* * * * *'), 60);
  assert.equal(shortestGap('0 7,18 * * *'), 11 * 3600);
  assert.equal(shortestGap(['0 7 * * *', '2 7 * * *']), 120);
});

test('the plain ways of saying a schedule become cron', () => {
  assert.deepEqual(fromTimes('07:00', 'daily'), ['0 7 * * *']);
  assert.deepEqual(fromTimes(['07:00', '18:00'], 'weekdays'), ['0 7,18 * * 1-5']);
  assert.deepEqual(fromTimes(['7:00', '18:30'], 'daily'), ['0 7 * * *', '30 18 * * *']);
  assert.deepEqual(fromTimes('18:00', 'thu'), ['0 18 * * 4']);
  assert.deepEqual(fromTimes('09:30', 'weekend'), ['30 9 * * 0,6']);
  assert.deepEqual(fromTimes('08:00', 'mon,wed,fri'), ['0 8 * * 1,3,5']);
  assert.deepEqual(fromTimes('08:00', [1, 2, 3, 4, 5, 6, 0]), ['0 8 * * *']);
  assert.deepEqual(fromTimes('08:00', [0, 1, 2, 5]), ['0 8 * * 0-2,5']);
  assert.throws(() => fromTimes('25:00', 'daily'), ScheduleError);
  assert.throws(() => daysOf('funday'), ScheduleError);
  assert.deepEqual(fromEvery('15m'), ['*/15 * * * *']);
  assert.deepEqual(fromEvery('5m'), ['*/5 * * * *']);
  assert.deepEqual(fromEvery('1h'), ['0 * * * *']);
  assert.deepEqual(fromEvery('60m'), ['0 * * * *']);
  assert.deepEqual(fromEvery('2h'), ['0 */2 * * *']);
  assert.deepEqual(fromEvery('1d'), ['0 0 * * *']);
  for (const bad of ['45m', '7m', '5h', '2d', 'soon']) assert.throws(() => fromEvery(bad), ScheduleError, bad);
  assert.deepEqual(toSchedule({ at: ['08:00', '20:00'] }), ['0 8,20 * * *']);
  assert.deepEqual(toSchedule({ every: '30m' }), ['*/30 * * * *']);
  assert.deepEqual(toSchedule({ cron: '0 4 * * *' }), ['0 4 * * *']);
  assert.deepEqual(toSchedule('0 4 * * *'), ['0 4 * * *']);
  // everything produced is itself valid
  for (const s of [fromTimes(['07:00', '18:30'], 'weekdays'), fromEvery('20m'), fromEvery('12h')]) assert.equal(isSchedule(s), true);
});
