// The path a new plugin author takes: create one from the template, run it, install
// somebody else's from a git address, and remove it again.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { home } from './helpers.js';

const dir = home();
const root = new URL('..', import.meta.url).pathname;
const bc = (...a) => spawnSync(process.execPath, [`${root}bin/bc.js`, ...a], { encoding: 'utf8', env: process.env });

test('bc plugin new: the template loads, is off until enabled, and then works as written', () => {
  const made = bc('plugin', 'new', 'greeter');
  assert.equal(made.status, 0, made.stderr);
  assert.ok(fs.existsSync(path.join(dir, 'user-plugins/greeter/plugin.js')));
  assert.notEqual(bc('greeter', 'hello').status, 0, 'not available before it is enabled');
  // (Enabling asks for confirmation in a terminal; there is none here, so it goes ahead.)
  assert.equal(bc('plugin', 'enable', 'greeter').status, 0);
  const hello = bc('greeter', 'hello', 'Maya');
  assert.match(hello.stdout, /^Hello, Maya\. It is \d\d:\d\d\./);
  assert.equal(JSON.parse(bc('greeter', 'hello', 'Maya', '--json').stdout).greeted, 'Maya');
  assert.equal(bc('greeter', 'setup', '--greeting', 'Hi there').status, 0);
  assert.match(bc('greeter', 'status').stdout, /greeting: Hi there/);
  assert.match(bc('greeter', 'settings').stdout, /greeting: Hi there/);
  assert.match(bc('plugin', 'info', 'greeter').stdout, /bc greeter hello/);
});

test('names that are taken or malformed are refused', () => {
  assert.match(bc('plugin', 'new', 'greeter').stderr, /already a plugin/);
  assert.match(bc('plugin', 'new', 'ssh').stderr, /already a plugin/);
  assert.match(bc('plugin', 'new', 'Bad Name').stderr, /lowercase/);
});

test('bc plugin add: a plugin from a git address is fetched and described, but not switched on', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'blackcat-plugin-repo-'));
  fs.writeFileSync(
    path.join(repo, 'plugin.js'),
    `export default { api: 1, name: 'dice', title: 'Dice', description: 'rolls a die',
    commands: { roll: { summary: 'roll one', access: 'allow', run: (ctx) => ({ text: 'rolled ' + (1 + ctx.api.now() % 6), data: {} }) } } };\n`,
  );
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, stdio: 'ignore' });
  g('init', '-q');
  g('add', '.');
  g('commit', '-qm', 'a plugin');
  const added = bc('plugin', 'add', repo, '--name', 'dice');
  assert.equal(added.status, 0, added.stderr);
  assert.match(added.stdout, /NOT switched on yet/);
  assert.match(added.stdout, /bc dice roll\s+allow/);
  assert.notEqual(bc('dice', 'roll').status, 0);
  bc('plugin', 'enable', 'dice');
  assert.match(bc('dice', 'roll').stdout, /^rolled [1-6]/);
});

test('something that is not a plugin is not kept', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'blackcat-not-a-plugin-'));
  fs.writeFileSync(path.join(repo, 'readme.txt'), 'nothing here');
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, stdio: 'ignore' });
  g('init', '-q');
  g('add', '.');
  g('commit', '-qm', 'x');
  const r = bc('plugin', 'add', repo, '--name', 'nothing');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not a plugin blackcat can use/);
  assert.equal(fs.existsSync(path.join(dir, 'user-plugins/nothing')), false);
});

test('bc plugin remove: an added plugin goes; a bundled one is only ever switched off', () => {
  assert.match(bc('plugin', 'remove', 'dice').stdout, /Removed dice/);
  assert.equal(fs.existsSync(path.join(dir, 'user-plugins/dice')), false);
  assert.notEqual(bc('dice', 'roll').status, 0);
  assert.match(bc('plugin', 'remove', 'ssh').stderr, /part of blackcat/);
  assert.match(bc('plugin', 'remove', 'greeter', '--data').stdout, /with its settings and data/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'data/config.json'), 'utf8')).plugins.settings?.greeter, undefined);
});
