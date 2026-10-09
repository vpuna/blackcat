// Voice: voice notes are turned into words on this machine. What can be held without the
// speech model itself: which files it will read and for whom, how it is set up, what it
// says of itself, and what the chat is told when it cannot hear one. (That a recording
// comes out as the right words needs the model, and is tried by a person.)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { home } from './helpers.js';

const dir = home();
const data = path.join(dir, 'data');
const root = new URL('..', import.meta.url).pathname;
const { FORCE_COLOR: _f, BLACKCAT_CALLER: _c, ...env } = process.env;
const bc = (as, ...a) =>
  spawnSync(process.execPath, [`${root}bin/bc.js`, ...a], {
    encoding: 'utf8',
    env: { ...env, ...(as === 'agent' ? { BLACKCAT_CALLER: 'agent', BLACKCAT_SLOW: '1' } : {}) },
    timeout: 60_000,
  });
const { save, load } = await import('../src/config.js');
save({});
fs.mkdirSync(path.join(data, 'inbox'), { recursive: true });

test('how it is set up: the model and the language, each one of those there are; and what it says of itself', () => {
  assert.match(bc('owner', 'voice', 'settings').stdout, /model: base[\s\S]*language: english/);
  const r = bc('owner', 'voice', 'setup', '--model', 'small', '--language', 'auto');
  assert.equal(r.status, 0, r.stderr);
  assert.match(
    r.stdout,
    /transcribed with the small model, as whatever language is spoken\. The model is downloaded the first time it is used\./,
  );
  assert.deepEqual(load().plugins.settings.voice, { model: 'small', language: 'auto' });
  assert.notEqual(bc('owner', 'voice', 'setup', '--model', 'enormous', '--language', 'english').status, 0, 'a model there is not');
  assert.notEqual(bc('owner', 'voice', 'setup', '--model', 'base', '--language', 'klingon').status, 0, 'a language there is not');
  assert.deepEqual(load().plugins.settings.voice, { model: 'small', language: 'auto' }, 'what was wrong changed nothing');
  assert.match(bc('owner', 'voice', 'status').stdout, /^Voice: ready after a one-time download of the model · the model is not loaded/);
});

test("the helper of another blackcat on the machine is not taken for this one's", async () => {
  const { spawn } = await import('node:child_process');
  // something that looks like a helper: of another installation, then of this one
  const like = (homeDir) =>
    spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)', 'plugins/voice/worker.js'], {
      env: { ...process.env, BLACKCAT_HOME: homeDir },
      stdio: 'ignore',
    });
  const other = like('/somewhere/else');
  try {
    await new Promise((r) => setTimeout(r, 300));
    assert.match(bc('owner', 'voice', 'status').stdout, /the model is not loaded/);
    const own = like(process.env.BLACKCAT_HOME);
    try {
      await new Promise((r) => setTimeout(r, 300));
      assert.match(bc('owner', 'voice', 'status').stdout, /the model is loaded/);
    } finally {
      own.kill();
    }
  } finally {
    other.kill();
  }
});

test('a file that is not there cannot be read; the agent may only have read what it could read itself', () => {
  const none = bc('owner', 'voice', 'transcribe', path.join(dir, 'nothing.ogg'));
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /Can't read .*nothing\.ogg: it doesn't exist\./);
  // somewhere the agent may not look: refused before anything is loaded, and without saying whether it exists
  const secret = path.join(dir, 'private-recording.ogg');
  fs.writeFileSync(secret, 'x');
  const kept = bc('agent', 'voice', 'transcribe', secret, '--json');
  assert.notEqual(kept.status, 0);
  assert.match(kept.stdout + kept.stderr, /it doesn't exist, or it is outside the folders you may read/);
});

test('the agent may have a recording read, and must ask before changing how they are read', async () => {
  const { loadPlugins } = await import('../src/plugins/registry.js');
  await loadPlugins();
  const { decide } = await import('../src/agent/policy.js');
  assert.equal(decide('Bash', { command: `blackcat voice transcribe ${path.join(data, 'inbox/note.ogg')} --json` }).action, 'allow');
  const ask = decide('Bash', { command: 'blackcat voice setup --model tiny --language english' });
  assert.deepEqual([ask.action, ask.title], ['ask', 'use Voice: change how voice notes are transcribed']);
});

test('selftest says whether the model it listens with is on this machine, without transcribing anything', () => {
  const probe = () => JSON.parse(bc('owner', 'selftest', 'voice', '--json').stdout).parts[0].results[0];
  assert.deepEqual([probe().name, probe().outcome], ['the small model', 'skipped']);
  assert.match(probe().detail, /not downloaded yet: it is fetched with the first voice note/);
});

test('it is what turns a voice note into words in the chat: one hook, found by the core without knowing its name', async () => {
  const { loadPlugins, loaded } = await import('../src/plugins/registry.js');
  await loadPlugins();
  const { chatHooks } = await import('../src/channels/hooks.js');
  const listeners = loaded().filter((p) => chatHooks(p).voice);
  assert.deepEqual(
    listeners.map((p) => p.name),
    ['voice'],
  );
  assert.equal(typeof chatHooks(listeners[0]).stop, 'function', 'and it can be told to let go of the model');
  // switched off, there is none, and a voice note is passed on as a file like any other
  save({ ...load(), plugins: { ...load().plugins, disabled: ['voice'] } });
  await loadPlugins();
  assert.deepEqual(
    loaded().filter((p) => chatHooks(p).voice),
    [],
  );
  save({ ...load(), plugins: { ...load().plugins, disabled: [] } });
});
