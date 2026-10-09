// The shared helpers every part of blackcat uses for times, sizes and escaping.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { esc, size } from '../src/util/format.js';
import { ago, agoShort, clock, hm, isoLocal, latestSlot, now, pad, todayAt, ymd } from '../src/util/time.js';
import { home } from './helpers.js';

home(); // nothing here may look at the real installation

test('clock: one rule for a time of day', () => {
  for (const [given, want] of [
    ['08:00', '08:00'],
    ['8:00', '08:00'],
    [' 18:30 ', '18:30'],
    ['0:05', '00:05'],
    ['23:59', '23:59'],
    ['00:00', '00:00'],
  ])
    assert.equal(clock(given), want, given);
  for (const bad of ['24:00', '8:60', '8', '08:0', '08:000', '8.30', 'eight', '', null, undefined, '-1:00', '08:00:00', '1e:00'])
    assert.equal(clock(bad), null, String(bad));
});

test('ymd, hm and isoLocal use local time', () => {
  const d = new Date(2026, 0, 5, 9, 7, 30); // 5 Jan 2026, 09:07 local
  const ts = Math.floor(d.getTime() / 1000);
  assert.equal(ymd(d), '2026-01-05');
  assert.equal(ymd(d.getTime()), '2026-01-05');
  assert.equal(hm(ts), '09:07');
  assert.equal(isoLocal(ts), '2026-01-05 09:07');
  assert.equal(hm(Math.floor(new Date(2026, 0, 5, 0, 0).getTime() / 1000)), '00:00');
  assert.equal(pad(3), '03');
  assert.match(ymd(), /^\d{4}-\d{2}-\d{2}$/);
});

test('todayAt and latestSlot', () => {
  const at = (h, m) => new Date(2026, 5, 10, h, m).getTime();
  assert.equal(todayAt('08:00', at(15, 0)), Math.floor(at(8, 0) / 1000));
  assert.equal(latestSlot(['08:00', '20:00'], at(7, 59)), null);
  assert.equal(latestSlot(['08:00', '20:00'], at(8, 0)), Math.floor(at(8, 0) / 1000));
  assert.equal(latestSlot(['20:00', '08:00'], at(21, 0)), Math.floor(at(20, 0) / 1000));
  assert.equal(latestSlot([], at(12, 0)), null);
});

test('ago, in words and short', () => {
  const t = now();
  assert.equal(ago(t - 30), 'just now');
  assert.equal(ago(t - 12 * 60), '12 min ago');
  assert.equal(ago(t - 3 * 3600), '3 h ago');
  assert.equal(ago(t - 5 * 86400), '5 days ago');
  assert.equal(agoShort(0), 'never');
  assert.equal(agoShort(null), 'never');
  assert.equal(agoShort(t - 10), '1m ago');
  assert.equal(agoShort(t - 5 * 60), '5m ago');
  assert.equal(agoShort(t - 3 * 3600), '3h ago');
  assert.equal(agoShort(t - 12 * 86400), '12d ago');
  assert.match(agoShort(t - 90 * 86400), /^\d{4}-\d{2}-\d{2}$/);
});

test('size and esc', () => {
  assert.equal(size(0), '1 KB');
  assert.equal(size(1500), '1 KB');
  assert.equal(size(700 * 1024), '700 KB');
  assert.equal(size(1024 ** 2), '1.0 MB');
  assert.equal(size(49.9 * 1024 ** 2), '49.9 MB');
  assert.equal(esc('<b>a & b</b>'), '&lt;b&gt;a &amp; b&lt;/b&gt;');
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(5), '5');
});

test('parseJsonList pulls the list out of a model answer', async () => {
  const { parseJsonList } = await import('../src/agent/oneshot.js');
  assert.deepEqual(parseJsonList('[{"a":1}]'), [{ a: 1 }]);
  assert.deepEqual(parseJsonList('Here you go:\n```json\n[1, 2]\n```\nDone.'), [1, 2]);
  assert.deepEqual(parseJsonList('[]'), []);
  assert.throws(() => parseJsonList('no list here'), /JSON list/);
  assert.throws(() => parseJsonList('{"a": [1}'), Error);
});
