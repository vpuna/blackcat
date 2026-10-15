// `bc ha check`: whether something in the home is as it should be, for a check to run, with
// how long it may be otherwise first. Against a stand-in for Home Assistant.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { home } from './helpers.js';
import { haServer } from './support/ha-server.js';

const dir = home();
process.env.HOME = dir;
const ha = await haServer();
after(() => ha.close());
const { save } = await import('../src/config.js');
save({ plugins: { enabled: ['ha'], settings: { ha: { url: ha.url } } } });
const reg = await import('../src/plugins/registry.js');
await reg.loadPlugins();
const plugin = reg.findLoaded('ha');
const owner = reg.makeCtx(plugin, { caller: 'owner' });
owner.secrets.set('token', ha.token);
const cmd = (name, input) => plugin.manifest.commands[name].run(owner, input);
const fails = (p, re) => assert.rejects(p, (e) => (assert.match(e.message, re), true));
const CATALOGUE = {
  location: 'Home',
  areas: [{ id: 'living', name: 'Living Room' }],
  entities: [{ id: 'media_player.living_room_tv', name: 'Living Room TV', area: 'living', domain: 'media_player', available: true }],
};

test('before the first sync, what needs to know the home says so, and does not fall over', async () => {
  owner.store.set('catalogue', null);
  await fails(cmd('kind', {}), /not been synced yet\. Run: bc ha sync/);
  owner.store.set('catalogue', CATALOGUE);
  assert.match((await cmd('kind', {})).text ?? '', /media_player/);
});

test('--grace is a duration like any other: minutes, hours, days, seconds', async () => {
  owner.store.set('catalogue', CATALOGUE);
  ha.state.lastChanged = new Date(Date.now() - 2 * 3600_000).toISOString(); // off for two hours
  const check = (grace) => cmd('check', { name: ['living', 'room', 'tv'], is: 'playing', grace });
  assert.match(await check('1d'), /but only for 120 min \(allowed: 1440\)/);
  assert.match(await check('3h'), /but only for 120 min/);
  await fails(check('90s'), /has been off for 2 hours/);
  await fails(check('30m'), /has been off for 2 hours/);
  await fails(check(undefined), /has been off/);
  await fails(check('soon'), /--grace: Can't read duration "soon"/);
});
