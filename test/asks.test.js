// A plugin asking the owner something mid-work (ctx.askOwner): the question is kept, the
// agent service sends it, only the owner's tap answers it, once, and not after it expires.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { home, setUp } from './helpers.js';

home();
await setUp({ channel: 'tg-bot', plugins: { settings: { 'tg-bot': { owner: { chat: 42, name: 'Owner' } } } } });
const { desk, resetDesk, setCarrier } = await import('../src/channels/desk.js');
const { askOwner, installAsks } = await import('../src/channels/asks.js');

function channel() {
  const did = [];
  let n = 0;
  resetDesk();
  setCarrier({
    can: { buttons: true, edit: true, html: true },
    label: 'a test',
    send: async (chat, m) => (did.push({ send: chat, text: m.text, ids: m.actions?.flat().map((a) => a.id) ?? [] }), ++n),
    edit: async (chat, ref, m) => void did.push({ edit: ref, text: m.text, buttons: !!m.actions }),
    toast: async () => {},
    sendFile: async (chat, file) => void did.push({ file }),
  });
  return did;
}
const tap = (id, chat = 42) => desk.action({ chat, conversation: chat, who: 'Owner', id, ref: 1 });
const until = async (fn) => {
  for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 20));
};

test('the question is sent with its choices, and the owner tapping one is the answer', async () => {
  const did = channel();
  const asks = installAsks({ everyMs: 20 });
  const answer = askOwner('demo', 'Demo', { text: 'Book this ride? €24 - 31', choices: ['Confirm', 'Cancel'] });
  await until(() => did.some((d) => d.send));
  const sent = did.find((d) => d.send);
  assert.equal(sent.send, 42);
  assert.match(sent.text, /Demo asks[\s\S]*€24 - 31[\s\S]*Only your tap answers/);
  assert.equal(sent.ids.length, 2);
  await tap(sent.ids[0]);
  assert.deepEqual(await answer, { answer: 'Confirm', how: 'answered' });
  assert.match(did.find((d) => d.edit).text, /<b>Confirm · /, 'the message says what was chosen, with no buttons left');
  // A second tap, or a tap on the other button, changes nothing.
  await tap(sent.ids[1]);
  assert.equal(did.filter((d) => d.edit).length, 1);
  asks.stop();
});

test('a tap from another chat does not answer it, and nothing answers it after it expires', async () => {
  const did = channel();
  const asks = installAsks({ everyMs: 20 });
  const t0 = Date.now();
  const answer = askOwner('demo', 'Demo', { text: 'Open the door?', choices: ['Open', 'Leave it'], expiresIn: 30 });
  await until(() => did.some((d) => d.send));
  const ids = did.find((d) => d.send).ids;
  await tap(ids[0], 7);
  // (Expired by hand: the row's time is moved back rather than waiting half a minute.)
  const { openSqlite } = await import('../src/db.js');
  const { AGENT_DB } = await import('../src/agentdb.js');
  const db = openSqlite(AGENT_DB);
  db.prepare('UPDATE asks SET expires_ts = expires_ts - 60').run();
  db.close();
  const r = await answer;
  assert.deepEqual(r, { answer: null, how: 'expired' });
  assert.ok(Date.now() - t0 < 10_000);
  await tap(ids[0]);
  await until(() => did.some((d) => d.edit));
  assert.match(did.find((d) => d.edit).text, /Expired, nothing was done/);
  asks.stop();
});

test('with no agent service to send it, or no channel, it says it could not ask', async () => {
  channel();
  // (No installAsks: nothing sends it. The wait for a sender is cut short by stopping.)
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 100);
  assert.deepEqual(await askOwner('demo', 'Demo', { text: 'x?', choices: ['A', 'B'] }, { signal: stop.signal }), {
    answer: null,
    how: 'unasked',
    why: 'stopped',
  });
  await setUp({});
  assert.deepEqual(await askOwner('demo', 'Demo', { text: 'x?', choices: ['A', 'B'] }), {
    answer: null,
    how: 'unasked',
    why: 'no channel is in use',
  });
});

test('a question that is not well formed is refused before anything is sent', async () => {
  for (const q of [
    { text: '', choices: ['A', 'B'] },
    { text: 'x', choices: ['A'] },
    { text: 'x', choices: ['A', 'A'] },
    { text: 'x', choices: ['A', 'B', 'C', 'D', 'E'] },
    { text: 'x', choices: ['A', 'B'], expiresIn: 5 },
    { text: 'x', choices: ['A', 'B'], picture: 'relative.jpg' },
  ])
    await assert.rejects(askOwner('demo', 'Demo', q), /askOwner:/);
});

test('the owner writing instead of tapping closes the question, unanswered, as Cancel would', async () => {
  await setUp({ channel: 'tg-bot', plugins: { settings: { 'tg-bot': { owner: { chat: 42, name: 'Owner' } } } } });
  const did = channel();
  const asks = installAsks({ everyMs: 20 });
  const answer = askOwner('demo', 'Demo', { text: 'Book it?', choices: ['Book', 'Cancel'] });
  await until(() => did.some((d) => d.send));
  await desk.text({ chat: 42, conversation: 42, who: 'Owner', text: 'no, the pickup is wrong' });
  assert.deepEqual(await answer, { answer: null, how: 'answered', why: 'the owner wrote instead of answering' });
  await until(() => did.some((d) => d.edit));
  assert.match(did.find((d) => d.edit).text, /Not answered: nothing was done/);
  asks.stop();
});

test("the owner writing instead of tapping an approval is a Not now, and the agent's turn goes on", async () => {
  const did = channel();
  const { installApprovals } = await import('../src/channels/approvals.js');
  const { askApprover } = await import('../src/agent/brain.js');
  installApprovals();
  const decided = askApprover({ chatId: 42, title: 'run a command', command: 'reboot' });
  await until(() => did.some((d) => d.send));
  await desk.text({ chat: 42, conversation: 42, who: 'Owner', text: 'wait, not that' });
  const d = await decided;
  assert.equal(d.allow, false);
  assert.match(d.note, /wrote a message instead/);
  await until(() => did.some((x) => x.edit));
  assert.match(did.find((x) => x.edit).text, /Not now: you wrote instead/);
});
