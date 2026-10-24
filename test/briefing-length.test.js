// A briefing too long for one message: cut between lines, never inside one (Telegram refuses
// formatting cut in half, and the whole briefing with it); the notes at the end kept whole;
// and what is not shown is neither numbered nor counted as told.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { home, setUp } from './helpers.js';

home();
await setUp({ bot: { allow: [{ id: 42, name: 'me' }] } });
const { loadPlugins } = await import('../src/plugins/registry.js');
await loadPlugins();
const { openWatchDb, findWatch, addItem, addWatch, getItem } = await import('../src/watch/db.js');
const { composeBriefing, fitLines } = await import('../src/watch/briefing.js');
const { record } = await import('../src/activity/log.js');

test('lines that do not fit are left out whole, with a line that says so', () => {
  const lines = ['<b>Today</b>', '1. <i>a</i>', '', '<b>Later</b>', '2. <i>b</i>', '3. <i>c</i>'];
  assert.deepEqual(fitLines(lines, 100, 'more'), { lines, dropped: 0 });
  const { lines: kept, dropped } = fitLines(lines, 30, 'more');
  assert.deepEqual(kept, ['<b>Today</b>', '1. <i>a</i>', '', 'more']);
  assert.equal(dropped, 4, 'and the heading of what was cut goes with it');
});

test('a briefing too long for one message: whole lines, its notes, and only what is shown numbered and told', async () => {
  const db = openWatchDb();
  const todo = findWatch(db, 'todo');
  // a watch that reports in the briefing: what is new on it is told there once
  const school = addWatch(db, {
    chatId: todo.chat_id,
    name: 'School',
    lookFor: 'notices',
    sources: { everywhere: 'all' },
    mode: 'briefing',
  });
  const ids = [];
  for (let k = 1; k <= 24; k++)
    ids.push(
      addItem(db, {
        watchId: school.id,
        title: `Entry ${k}: Tom & Jerry's ${'long words of a title '.repeat(9)}`,
        msgId: `m${k}`,
      }).id,
    );
  record({ kind: 'model', category: 'chat', cost: 0.25, ts: Math.floor(Date.now() / 1000) - 86400 });
  const b = await composeBriefing(db, todo.chat_id);
  assert.ok(b.html.length <= 4000, `${b.html.length} characters`);
  for (const line of b.html.split('\n')) {
    for (const tag of ['b', 'i', 'code'])
      assert.equal(line.split(`<${tag}>`).length, line.split(`</${tag}>`).length, `<${tag}> whole in: ${line}`);
    assert.doesNotMatch(line, /&(?!amp;|lt;|gt;|quot;|#\d+;)/, `an entity cut in: ${line}`);
  }
  assert.match(b.html, /<i>… more than fits here: \/watch<\/i>\n\n<b>What the model used yesterday<\/b>/, 'the notes are whole, after it');
  const shown = Math.max(...b.html.split('\n').map((l) => Number(/^(\d+)\. /.exec(l)?.[1] ?? 0)));
  assert.ok(shown > 5 && shown < 24, `${shown} shown`);
  assert.equal(b.listed.length, shown, 'a number for each one shown, and no more');
  b.markReported();
  const told = new Set(b.listed.map((it) => it.id));
  assert.deepEqual(
    ids.map((id) => getItem(db, id).status),
    ids.map((id) => (told.has(id) ? 'kept' : 'new')),
    'what was not shown is told next time',
  );
  assert.equal(ids.filter((id) => getItem(db, id).status === 'new').length, 24 - shown);
  db.close();
});
