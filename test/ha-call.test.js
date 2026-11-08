// A service called in Home Assistant, and what it changed read back: from the states Home
// Assistant answers with, or, for a device that changes a moment later, by asking until its
// state is newer than before. No fixed wait. (W4 of the audit of 2026-10-24: each call slept
// 700 or 800 ms and then read whatever was there, and a script was judged by its name.)
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, test } from 'node:test';
import { home } from './helpers.js';

home();
const { client, settle } = await import('../plugins/ha/api.js');
const { carryOut } = await import('../plugins/ha/quick.js');

// A home with one lamp; how it answers is set by each test.
const lamp = { entity_id: 'light.lamp', state: 'off', last_updated: '2026-10-24T10:00:00Z' };
const home_ = { answer: 'changed', laterMs: 0, gets: 0, script: [] };
const server = http.createServer((req, res) => {
  const send = (o) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o));
  if (req.method === 'GET') return (home_.gets++, send(lamp));
  req.resume().on('end', () => {
    if (req.url === '/api/services/script/turn_on') return send(home_.script);
    const turn = () => Object.assign(lamp, { state: 'on', last_updated: new Date().toISOString() });
    if (home_.answer === 'changed') return (turn(), send([lamp]));
    if (home_.answer === 'later') setTimeout(turn, home_.laterMs);
    send([]);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
after(() => new Promise((r) => server.close(r)));
const ha = client({ url: `http://127.0.0.1:${server.address().port}`, token: 't' });
const reset = (o) => (Object.assign(lamp, { state: 'off', last_updated: '2026-10-24T10:00:00Z' }), Object.assign(home_, { gets: 0 }, o));

test('what Home Assistant says changed is taken as it is, with no wait', async () => {
  reset({ answer: 'changed' });
  const t0 = Date.now();
  const { now } = await ha.call('light', 'turn_on', { entity_id: 'light.lamp' });
  assert.equal(now['light.lamp'].state, 'on');
  assert.ok(Date.now() - t0 < settle.every, 'not waited for');
  assert.equal(home_.gets, 1, 'looked at once, before');
});

test('a device that changes a moment later is asked until it has, and no longer', async () => {
  reset({ answer: 'later', laterMs: 400 });
  const t0 = Date.now();
  const { now } = await ha.call('light', 'turn_on', { entity_id: 'light.lamp' });
  assert.equal(now['light.lamp'].state, 'on');
  assert.ok(Date.now() - t0 < 400 + 2 * settle.every, `as soon as it changed (${Date.now() - t0} ms)`);
});

test('one already as asked: what it is, after its moment', async () => {
  reset({ answer: 'never' });
  const { now } = await ha.call('light', 'turn_off', { entity_id: 'light.lamp' });
  assert.equal(now['light.lamp'].state, 'off');
});

test('a script says what it changed, whatever its name', async () => {
  reset({
    script: [
      { entity_id: 'light.lamp', state: 'on' },
      { entity_id: 'script.lamp_onoff', state: 'off' },
    ],
  });
  const cat = { entities: [{ id: 'light.lamp', name: 'Desk lamp' }] };
  const said = await carryOut({ via: 'script', action: 'on', things: [{ id: 'script.lamp_onoff', name: 'Lamp on/off' }] }, cat, ha);
  assert.equal(said, 'ran Lamp on/off: Desk lamp on');
  reset({ script: [] });
  assert.equal(await carryOut({ via: 'script', action: 'on', things: [{ id: 'script.x', name: 'Goodnight' }] }, cat, ha), 'ran Goodnight');
});
