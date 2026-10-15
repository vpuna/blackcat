// Every source file must load: each of its imports must exist and export what is asked of
// it. A refactor that moves or drops a function shows up here, rather than hours later when
// a scheduled job first needs the file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { home } from './helpers.js';

home();
const root = new URL('..', import.meta.url).pathname;
const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.name.endsWith('.js')) files.push(full);
  }
};
walk(path.join(root, 'src'));
walk(path.join(root, 'plugins'));

// (The speech worker and the waiting command process start working as soon as they are
// loaded: they are programs, not modules.)
const SKIP = ['plugins/voice/worker.js', 'src/agent/warm-worker.js'];

test(`all ${files.length} source files load`, async () => {
  const failed = [];
  for (const f of files) {
    if (SKIP.includes(path.relative(root, f))) continue;
    try {
      await import(f);
    } catch (e) {
      failed.push(`${path.relative(root, f)}: ${e.message.split('\n')[0]}`);
    }
  }
  assert.deepEqual(failed, []);
});
