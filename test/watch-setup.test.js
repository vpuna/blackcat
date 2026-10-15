// The questions `bc watch setup` asks about "Things I need to do" start from what is set now.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { home, setUp } from './helpers.js';

home();
await setUp({ bot: { allow: [{ id: 42, name: 'me' }] } });
const { todoForm } = await import('../src/watch/setup.js');
const { TODO, findWatch, openWatchDb, updateWatch } = await import('../src/watch/db.js');
const { withDb } = await import('../src/db.js');
const asked = () =>
  todoForm()
    .find((q) => q.id === 'auto')
    .default();

test('picking things up is offered as on until it is switched off; once off, setup offers off', () => {
  assert.equal(asked(), true, 'the watch is made switched on');
  withDb(openWatchDb, (db) => updateWatch(db, findWatch(db, TODO).id, { active: 0 }));
  assert.equal(asked(), false);
  withDb(openWatchDb, (db) => updateWatch(db, findWatch(db, TODO).id, { active: 1 }));
  assert.equal(asked(), true);
});
