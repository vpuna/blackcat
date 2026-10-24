// A shortcut asked for in words: run without the agent when the words are its name and
// nothing else, and asked before Home Assistant, whose quick route matches the names of
// things. A real case: "Turn TV on" meant the owner's /tv_on, and Home Assistant switched on
// some other TV instead.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { home, setUp } from './helpers.js';

home();
await setUp({ plugins: { enabled: ['ha'] } });
const { named } = await import('../plugins/shortcut/quick.js');

const parts = ['tv', 'tv cnn', 'tv bbcnews', 'tv_on', 'tv_news', 'waves', 'waves play', 'waves stop', 'temps', 'ride_home_to_work'].map(
  (label) => ({ label }),
);
const pick = (text) => named(text, parts)?.label ?? null;

test('its name, in any order, with words that change nothing', () => {
  assert.equal(pick('Turn TV on.'), 'tv_on');
  assert.equal(pick('turn on the tv'), 'tv_on');
  assert.equal(pick('tv on please'), 'tv_on');
  assert.equal(pick('play the waves'), 'waves play', 'an action is named with its shortcut');
  assert.equal(pick('stop waves'), 'waves stop');
  assert.equal(pick('tv cnn'), 'tv cnn');
  assert.equal(pick('temps'), 'temps');
  assert.equal(pick('Ride home to work'), 'ride_home_to_work');
  assert.equal(pick('tv'), 'tv', 'a menu is a name too');
});

test('anything more than its name is left to the others and the agent', () => {
  assert.equal(pick('turn tv off'), null, '"off" is what is asked');
  assert.equal(pick('tv on at nine'), null);
  assert.equal(pick('is the tv on'), null);
  assert.equal(pick("don't turn the tv on"), null);
  assert.equal(pick('what are the temps on the server'), null);
  assert.equal(pick('waves louder'), null);
  assert.equal(pick('turn on the kitchen lights'), null);
  assert.equal(pick('please'), null);
  assert.equal(pick(''), null);
});

test('two that fit as well as each other are left to the agent', () => {
  assert.equal(named('tv on', [{ label: 'tv_on' }, { label: 'on_tv' }]), null);
});

test('shortcuts are asked before Home Assistant', async () => {
  await (await import('../src/plugins/registry.js')).loadPlugins();
  const order = (await import('../src/channels/quick.js')).inOrder().map((p) => p.name);
  assert.ok(order.includes('ha') && order.includes('shortcut'), order.join(' '));
  assert.ok(order.indexOf('shortcut') < order.indexOf('ha'), order.join(' '));
});
