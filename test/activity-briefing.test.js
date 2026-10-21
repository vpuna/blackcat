// What the model used, in the daily briefing: yesterday's calls in a few groups, and the
// week's daily average. Today's are not counted yet, and a developer session's never are.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { home, setUp } from './helpers.js';

home();
const { save, load } = await import('../src/config.js');
await setUp({ bot: { allow: [{ id: 42, name: 'me' }] } });
const { record } = await import('../src/activity/log.js');
const { forBriefing } = await import('../src/activity/commands.js');

const now = Math.floor(Date.now() / 1000);
const day = 86400;
const call = (category, cost, ago, extra = {}) => record({ kind: 'model', category, cost, ts: now - ago, ...extra });

test('nothing used the model this week: nothing to say', () => {
  call('chat', 1, 0); // today: not over yet
  assert.equal(forBriefing(), null);
});

test("yesterday's cost in groups, most first, and the week's average; today and a developer's left out", () => {
  call('chat', 0.5, day);
  call('conversation summary', 0.1, day);
  call('watch: Things I need to do', 0.8, day);
  call('watch: From A & B', 0.2, day);
  call('attachments', 0.05, day);
  call('check: nas', 0.04, day);
  call('voice', 0.01, day);
  call('chat', 5, day, { who: 'dev' });
  call('chat', 1.3, 3 * day);
  const lines = forBriefing().note.split('\n');
  assert.deepEqual(lines, [
    '<b>What the model used yesterday</b>',
    '$1.70 (7 calls), at list price',
    '· watch Things I need to do: $0.80 (1 call)',
    '· talking to you: $0.60 (2 calls)',
    '· watch From A &amp; B: $0.20 (1 call)',
    '· reading files: $0.05 (1 call)',
    '· checks: $0.04 (1 call)',
    '· other: $0.01 (1 call)',
    'Last 3 days: $3.00 (8 calls), about $1.00 a day',
  ]);
});

test('more than three watches are one line; with cost not shown, calls only', () => {
  call('watch: C', 0.1, day);
  call('watch: D', 0.1, day);
  assert.ok(forBriefing().note.includes('· watching chats: $1.20 (4 calls)'));
  save({ ...load(), activity: { ...load().activity, cost: false } });
  const note = forBriefing().note;
  assert.ok(!note.includes('$'), note);
  assert.ok(note.includes('· watching chats: 4 calls'), note);
  assert.ok(note.includes('about 3 calls a day'), note);
});

test('the briefing is given it, by the activity part', async () => {
  await (await import('../src/plugins/registry.js')).loadPlugins();
  const said = await (await import('../src/watch/briefing.js')).fromOthers();
  assert.ok(said.some((x) => x.note?.startsWith('<b>What the model used yesterday</b>')));
});

test('with the record off, no note', () => {
  save({ ...load(), activity: { ...load().activity, on: false } });
  assert.equal(forBriefing(), null);
});
