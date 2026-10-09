// The scheduler gives every plugin its turn every 20 seconds. A plugin whose schedule can't
// be worked out must not stop the plugins after it, and a job that hangs must be ended.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { home } from './helpers.js';

const dir = home();
const plugin = (name, body) => {
  fs.mkdirSync(path.join(dir, 'user-plugins', name), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'user-plugins', name, 'plugin.js'),
    `export default { api: 1, name: '${name}', title: '${name}', description: 'a test plugin', commands: { hello: { summary: 'says hello', access: 'allow', run: () => 'hello' } }, ${body} };\n`,
  );
};
const flag = path.join(dir, 'good-ran');
// Its schedule check throws, on every tick.
plugin(
  'aaa-bad',
  "jobs: [{ id: 'work', every: '1m', summary: 'does work', when: () => { throw new Error('broken schedule'); }, run: () => {} }]",
);
// Comes after it, and must still get its turn.
plugin(
  'zzz-good',
  `chat: { tick: () => { require('node:fs').writeFileSync(${JSON.stringify(flag)}, 'yes'); } }`.replace(
    "require('node:fs')",
    'globalThis.__fs',
  ),
);
globalThis.__fs = fs;

const { save } = await import('../src/config.js');
const bundled = [...fs.readdirSync(new URL('../plugins', import.meta.url).pathname), 'watch', 'remind', 'check']; // (and the parts of blackcat itself that can be switched off)
save({ plugins: { enabled: ['aaa-bad', 'zzz-good'], disabled: bundled } });

const { latestSlot, runJob, startScheduler } = await import('../src/agent/scheduler.js');

test('a plugin that throws does not stop the plugins after it', async () => {
  const s = startScheduler({ api: {} });
  await new Promise((r) => setTimeout(r, 500));
  s.stop();
  assert.equal(fs.existsSync(flag), true, 'the plugin after the broken one did not get its turn');
});

test("latestSlot: the most recent of today's times that has passed", () => {
  const at = (hm) => new Date(new Date().setHours(...hm.split(':').map(Number), 0, 0)).getTime();
  assert.equal(latestSlot(['08:00', '20:00'], at('07:59')), null);
  assert.equal(latestSlot(['08:00', '20:00'], at('08:00')), Math.floor(at('08:00') / 1000));
  assert.equal(latestSlot(['08:00', '20:00'], at('19:59')), Math.floor(at('08:00') / 1000));
  assert.equal(latestSlot(['20:00', '08:00'], at('23:10')), Math.floor(at('20:00') / 1000));
});

test('a job that fails reports nothing rather than throwing', async () => {
  assert.equal(await runJob(['plugin', 'job', 'no-such-plugin', 'x'], { timeoutMs: 60_000 }), null);
});

test('a job that runs past its time is stopped', async () => {
  // A job is any bc command. This plugin's job never finishes.
  plugin(
    'hangs',
    "jobs: [{ id: 'forever', every: '1h', summary: 'never ends', run: () => new Promise(() => setInterval(() => {}, 1000)) }]",
  );
  const { update } = await import('../src/config.js');
  update((cfg) => {
    cfg.plugins.enabled.push('hangs');
  });
  const t0 = Date.now();
  assert.equal(await runJob(['plugin', 'job', 'hangs', 'forever'], { timeoutMs: 3000 }), null);
  const took = Date.now() - t0;
  assert.ok(took >= 3000 && took < 20_000, `took ${took} ms`);
});
