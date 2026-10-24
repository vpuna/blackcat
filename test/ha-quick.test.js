// Home Assistant's quick route: a plain "turn X on" done without the agent, only when the
// words name one thing. A real case: "Turn TV on" with the living room TV in standby
// (unreachable in Home Assistant) switched on the dining room's, the only TV answering.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { home } from './helpers.js';

home(); // (the plugin's modules use blackcat's API, which needs a home of its own to look at)
const { plan } = await import('../plugins/ha/quick.js');

const E = (id, name, area, extra = {}) => ({
  id,
  name,
  area,
  domain: id.split('.')[0],
  available: true,
  category: null,
  hidden: false,
  ...extra,
});
const areas = [
  { id: 'living', name: 'Living Room' },
  { id: 'dining', name: 'Dining Room' },
  { id: 'kitchen', name: 'Kitchen' },
];
const cat = (entities) => ({ areas, entities });

test('"turn tv on" with two TVs, one unreachable: left to the agent, never the one that answers', () => {
  const c = cat([
    E('media_player.lr_tv', 'Living room TV', 'living', { available: false }),
    E('media_player.chromecast', 'Dining room TV', 'dining'),
  ]);
  assert.equal(plan('Turn TV on.', c), null);
  assert.equal(plan('tv on', c), null);
  // Named so there is only one, it is done.
  assert.deepEqual(
    plan('turn on the dining room tv', c).things.map((e) => e.id),
    ['media_player.chromecast'],
  );
});

test('the one thing named, unreachable: left to the agent (it can say so, or reach it another way)', () => {
  const c = cat([
    E('media_player.lr_tv', 'Living room TV', 'living', { available: false }),
    E('light.kitchen', 'Kitchen light', 'kitchen'),
  ]);
  assert.equal(plan('living room tv on', c), null);
  const p = plan('turn on kitchen light', c);
  assert.deepEqual(
    p.things.map((e) => e.id),
    ['light.kitchen'],
  );
  assert.equal(p.free, true);
});

test('an unreachable thing with a longer name does not stand in the way of the one named exactly', () => {
  const c = cat([E('light.hall', 'Hallway light', 'living'), E('light.hall_lamp', 'Hallway light lamp', 'living', { available: false })]);
  assert.deepEqual(
    plan('hallway light off', c).things.map((e) => e.id),
    ['light.hall'],
  );
});
