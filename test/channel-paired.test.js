// A channel that cannot say whether it is set up (its own check fails) is said to be in
// trouble, with why, and the reason goes in the log: not shown as "not set up", which sends
// the owner to pair it again for nothing. (W8 of the audit of 2026-10-24.)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { home } from './helpers.js';

const dir = home();
const root = new URL('..', import.meta.url).pathname;
fs.mkdirSync(path.join(dir, 'user-plugins/broken'), { recursive: true });
fs.writeFileSync(
  path.join(dir, 'user-plugins/broken/plugin.js'),
  `export default {
  api: 1, name: 'broken', title: 'Broken channel', description: 'a channel whose own check fails, for the tests',
  commands: { pair: { summary: 'pair it', access: 'owner', run: () => 'paired' } },
  channel: {
    label: 'the broken channel',
    paired: () => { throw new Error('its settings file is unreadable'); },
    open: async () => ({ send: async () => 1 }),
    start: async () => ({ stop: async () => {} }),
  },
};
`,
);
const { save } = await import('../src/config.js');
save({ plugins: { enabled: ['broken'] }, channel: 'broken' });

test('a channel that cannot tell whether it is set up says so, with why', async () => {
  const r = spawnSync(process.execPath, [`${root}bin/bc.js`, 'channel', '--json'], { encoding: 'utf8' });
  const c = JSON.parse(r.stdout).channels.find((x) => x.name === 'broken');
  assert.deepEqual([c.name, c.paired, c.error], ['broken', false, 'its settings file is unreadable']);
  const shown = spawnSync(process.execPath, [`${root}bin/bc.js`, 'channel'], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  assert.match(shown.stdout, /could not tell whether it is set up: its settings file is unreadable/);
  assert.doesNotMatch(shown.stdout, /broken .*not set up →/);
  // In the service, the channel in use is not used, and why goes in its log (what it prints).
  const logged = [];
  const was = console.log;
  console.log = (l) => logged.push(l);
  try {
    await (await import('../src/plugins/registry.js')).loadPlugins();
    assert.equal((await import('../src/channels/registry.js')).activeChannel(), null);
  } finally {
    console.log = was;
  }
  assert.match(logged.join('\n'), /broken: could not tell whether it is set up: its settings file is unreadable/);
});
