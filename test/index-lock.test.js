// Only one run of the search index at a time: the lock is held by a process that is running,
// and not by whatever process has since been given the same number.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { after, test } from 'node:test';
import { home } from './helpers.js';

home();
const { INDEX_LOCK } = await import('../src/archive/files.js');
const { indexHeld } = await import('../src/archive/semantic.js');
const { bornAt } = await import('../src/service/units.js');
const other = spawn('sleep', ['30']);
after(() => other.kill());
await new Promise((r) => other.once('spawn', r));

test('held by a running indexer; not by a number that now belongs to something else, nor by one that is gone', () => {
  fs.mkdirSync(new URL('.', `file://${INDEX_LOCK}`).pathname, { recursive: true });
  fs.writeFileSync(INDEX_LOCK, `${other.pid} ${bornAt(other.pid)}`);
  assert.equal(indexHeld(), true);
  fs.writeFileSync(INDEX_LOCK, `${other.pid} 1`); // the indexer that wrote it started at another time
  assert.equal(indexHeld(), false);
  fs.writeFileSync(INDEX_LOCK, '999999999');
  assert.equal(indexHeld(), false);
  fs.writeFileSync(INDEX_LOCK, String(other.pid)); // a lock written before the start time was noted
  assert.equal(indexHeld(), true);
  fs.writeFileSync(INDEX_LOCK, String(process.pid));
  assert.equal(indexHeld(), false, 'its own lock does not stop itself');
});
