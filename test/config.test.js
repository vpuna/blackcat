// The config file is written by the bot, the sources, scheduled jobs and commands, all
// separate processes. Changes made through update() must all survive, and the file must
// never be left half-written.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { home } from './helpers.js';

const dir = home();
const config = new URL('../src/config.js', import.meta.url).pathname;
const { load, save, update } = await import(config);

test('update() applies a change and returns the result', () => {
  save({ a: 1 });
  const out = update((cfg) => {
    cfg.b = 2;
  });
  assert.deepEqual(out, { a: 1, b: 2 });
  assert.deepEqual(load(), { a: 1, b: 2 });
  assert.equal(fs.statSync(path.join(dir, 'data/config.json')).mode & 0o777, 0o600);
});

test('eight processes changing it at once lose nothing and leave no debris', async () => {
  save({});
  const PROCS = 8;
  const EACH = 25;
  const script = `const { update } = await import(${JSON.stringify(config)});
    for (let i = 0; i < ${EACH}; i++) update((cfg) => { cfg.items = { ...cfg.items, [process.argv[1] + '-' + i]: true }; });`;
  const codes = await Promise.all(
    Array.from(
      { length: PROCS },
      (_, n) =>
        new Promise((resolve) => {
          spawn(process.execPath, ['--input-type=module', '-e', script, `p${n}`], { env: process.env, stdio: 'inherit' }).on(
            'close',
            resolve,
          );
        }),
    ),
  );
  assert.deepEqual(codes, Array(PROCS).fill(0));
  assert.equal(Object.keys(load().items).length, PROCS * EACH);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'data')).sort(), ['config.json']);
});

test('a lock left behind by a process that died is taken over', () => {
  const lock = path.join(dir, 'data/config.json.lock');
  fs.mkdirSync(lock);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  update((cfg) => {
    cfg.after = true;
  });
  assert.equal(load().after, true);
  assert.equal(fs.existsSync(lock), false);
});

test('an installation lives where its code is, wherever that was put; BLACKCAT_HOME names another folder', async () => {
  const ask = (env) =>
    new Promise((resolve) => {
      let out = '';
      const c = spawn(process.execPath, ['-e', `import(${JSON.stringify(config)}).then((m) => console.log(m.HOME + '|' + m.DATA))`], {
        env,
      });
      c.stdout.on('data', (d) => (out += d));
      c.on('close', () => resolve(out.trim()));
    });
  const { BLACKCAT_HOME: _h, NODE_TEST_CONTEXT: _t, ...bare } = process.env;
  const root = path.resolve(new URL('..', import.meta.url).pathname);
  assert.equal(await ask(bare), `${root}|${path.join(root, 'data')}`, 'not a fixed folder in the home directory');
  assert.equal(await ask({ ...bare, BLACKCAT_HOME: dir }), `${dir}|${path.join(dir, 'data')}`);
});
