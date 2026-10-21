// One message that shows how work is going (ctx.progress): sent once, then changed, no more
// often than the channel allows, the last change always made.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { home, setUp } from './helpers.js';

home();
await setUp({ channel: 'tg-bot', plugins: { settings: { 'tg-bot': { owner: { chat: 42, name: 'Owner' } } } } });
const { resetDesk, setCarrier } = await import('../src/channels/desk.js');
const { progressOwner } = await import('../src/channels/send.js');

function channel(can) {
  const did = [];
  resetDesk();
  setCarrier({
    can,
    label: 'a test',
    send: async (chat, m) => (did.push(['send', m.text]), 7),
    edit: async (chat, ref, m) => void did.push(['edit', ref, m.text]),
  });
  return did;
}

test('it is sent once and changed as work goes on; quick changes are folded into one', async () => {
  const did = channel({ edit: true });
  const p = await progressOwner('⏳ 1. Open the app', { everyMs: 100 });
  p.update('✓ 1 · ⏳ 2');
  p.update('✓ 1 · ✓ 2 · ⏳ 3');
  await new Promise((r) => setTimeout(r, 250));
  await p.done('✓ all done');
  assert.deepEqual(did, [
    ['send', '⏳ 1. Open the app'],
    ['edit', 7, '✓ 1 · ✓ 2 · ⏳ 3'],
    ['edit', 7, '✓ all done'],
  ]);
});

test('where a message cannot be changed, only the first and the last are sent', async () => {
  const did = channel({ edit: false });
  const p = await progressOwner('starting', { everyMs: 10 });
  p.update('middle');
  await p.done('finished');
  assert.deepEqual(did, [
    ['send', 'starting'],
    ['send', 'finished'],
  ]);
});
