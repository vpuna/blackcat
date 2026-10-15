// Every `bc` command, every command the agent runs and every scheduled job starts a new
// process, several hundred times a day. Starting must stay cheap: the large libraries
// (WhatsApp, Telegram, mail, speech, calendar) are loaded only by the commands that use them.
// This test fails if an import at the top of a file brings one of them back for everybody.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { test } from 'node:test';
import { home } from './helpers.js';

home();
const root = new URL('..', import.meta.url).pathname;
const hook = new URL('./support/loaded.mjs', import.meta.url).pathname;
const bundled = [...fs.readdirSync(`${root}plugins`), 'watch', 'remind', 'check']; // (and the parts of blackcat itself that have commands and can be switched off)
const { save } = await import('../src/config.js');
save({ plugins: { enabled: bundled } }); // everything switched on, as on a full installation

const HEAVY = [
  'baileys',
  'telegram',
  'grammy',
  'imapflow',
  'mailparser',
  'html-to-text',
  '@huggingface/transformers',
  'onnxruntime-node',
  'ical.js',
  'qrcode-terminal',
  'sqlite-vec',
  'pino',
];
function run(args) {
  const r = spawnSync(process.execPath, ['--import', hook, `${root}bin/bc.js`, ...args], {
    encoding: 'utf8',
    env: process.env,
    timeout: 60_000,
  });
  const packages = (/PACKAGES (.*)/.exec(r.stderr)?.[1] ?? '')
    .split(' ')
    .filter(Boolean)
    .map((x) => x.replace(/:\d+$/, ''));
  return { ...r, packages };
}

for (const args of [
  ['--help'],
  ['--version'],
  ['plugin', 'list'],
  ['pi', 'status'],
  ['remind', 'list', '--json'],
  ['watch', 'list', '--json'],
  ['msg', 'chats', '--json'],
  ['mail', 'status'],
  ['mail', 'rules'],
  ['calendar', 'status'],
  ['shortcut', 'list'],
  ['ssh', 'hosts'],
  ['voice', 'status'],
  ['backup', 'status'],
  ['ha', 'status'],
  ['unifi', 'settings'],
  ['wa', 'settings'],
  ['tg', 'account', 'settings'],
]) {
  test(`bc ${args.join(' ')} loads none of the large libraries`, () => {
    const r = run(args);
    assert.deepEqual(
      r.packages.filter((p) => HEAVY.includes(p)),
      [],
      `loaded: ${r.packages.join(', ')}`,
    );
  });
}

test('every bundled plugin loads, and answers `status` and `settings` on an empty installation', () => {
  for (const name of bundled) {
    const mount = { tg: ['tg', 'account'], 'tg-bot': ['tg', 'bot'], 'claude-code': ['claude'] }[name] ?? [name];
    for (const cmd of ['status', 'settings']) {
      const r = run([...mount, cmd]);
      const err = r.stderr.replace(/PACKAGES.*/, '').trim();
      // Either it answers, or it says plainly that it isn't set up yet. Never a crash.
      assert.ok(
        r.status === 0 || /not set up|not linked|not connected/i.test(err),
        `bc ${mount.join(' ')} ${cmd} exited ${r.status}: ${err.slice(0, 300)}`,
      );
      assert.doesNotMatch(err, /\n\s+at .*\(?file:\/\//, `bc ${mount.join(' ')} ${cmd} crashed: ${err.slice(0, 400)}`);
      assert.doesNotMatch(r.stderr, /skipped:/, `a plugin failed to load: ${r.stderr.slice(0, 300)}`);
    }
  }
});
