// Where a chat's conversation with the engine is at is kept in blackcat's database, not in
// the settings file: a chat turn must not make it look as though settings had changed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { SIGNED_IN, home } from './helpers.js';

const dir = home();
const { save, load, update, CONFIG_FILE } = await import('../src/config.js');
// A settings file as an installation from before has it.
save({
  channel: 'tg-bot',
  agent: { stayReady: false },
});
const { dropSession, keepSession, sessionOf } = await import('../src/agent/sessions.js');
const stamp = () => fs.statSync(CONFIG_FILE).mtimeMs;
const later = () => new Promise((r) => setTimeout(r, 25));

test('a chat turn does not touch the settings file; and nothing is written when a conversation is where it was', async () => {
  const before = stamp();
  await later();
  assert.equal(keepSession(42, { session: 'sess-a', instructions: 'stamp-1', engine: 'claude-code' }), true);
  assert.equal(keepSession(42, { session: 'sess-a', instructions: 'stamp-1', engine: 'claude-code' }), false, 'the same: not written');
  assert.equal(keepSession(42, { session: 'sess-b', instructions: 'stamp-1', engine: 'claude-code' }), true);
  assert.deepEqual(sessionOf(42).session, 'sess-b');
  assert.equal(dropSession(42), true);
  assert.equal(dropSession(42), false);
  assert.equal(sessionOf(42), null);
  assert.equal(stamp(), before, 'the settings file has not been written');
});

test('changing a setting to what it already is writes nothing; a real change does', async () => {
  const before = stamp();
  await later();
  update((c) => {
    c.channel = 'tg-bot';
  });
  assert.equal(stamp(), before);
  update((c) => {
    c.channel = 'other';
  });
  assert.notEqual(stamp(), before);
  assert.equal(load().channel, 'other');
});

test('a conversation run through the agent leaves the settings file alone', async () => {
  fs.mkdirSync(path.join(dir, 'agent'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent/AGENT.md'), 'Rules.\n');
  fs.writeFileSync(
    path.join(dir, 'fake-bin/claude'),
    `#!/bin/sh\n${SIGNED_IN}exec ${process.execPath} ${new URL('./support/fake-claude-session.mjs', import.meta.url).pathname}\n`,
    { mode: 0o755 },
  );
  await (await import('../src/plugins/registry.js')).loadPlugins();
  const brain = await import('../src/agent/brain.js');
  await brain.reply(brain.TERMINAL, 'first');
  const before = stamp();
  await later();
  await brain.reply(brain.TERMINAL, 'second');
  await brain.reply(brain.TERMINAL, 'third');
  assert.equal(stamp(), before, 'two more turns, and the file is as it was');
  assert.ok(sessionOf(brain.TERMINAL)?.session, 'and where the conversation is at is kept');
  brain.stopAll();
});
