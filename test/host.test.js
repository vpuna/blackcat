// Running commands on the machine blackcat lives on. Same rules as another machine over
// SSH, plus one of its own: blackcat's private files are never read through it, whatever
// the mode and however the command is written.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';
import { home, setUp } from './helpers.js';

const dir = home();
const root = new URL('..', import.meta.url).pathname;
await setUp({ bot: { token: 'SECRET-BOT-TOKEN' }, plugins: { enabled: ['host'] } });
fs.mkdirSync(path.join(dir, 'data/plugins/mail'), { recursive: true });
fs.writeFileSync(path.join(dir, 'data/plugins/mail/secrets.json'), '{"password":"SECRET-MAIL-PASSWORD"}');
fs.writeFileSync(path.join(dir, 'data/inbox-note.txt'), 'SECRET-IN-DATA-ROOT');
fs.mkdirSync(path.join(dir, 'data/inbox'), { recursive: true });
fs.writeFileSync(path.join(dir, 'data/inbox/hello.txt'), 'a file the owner sent');
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'blackcat-host-'));
fs.writeFileSync(path.join(outside, 'notes.txt'), 'ordinary notes');
fs.symlinkSync(path.join(dir, 'data/config.json'), path.join(outside, 'innocent-link'));

let decide;
before(async () => {
  const { loadPlugins } = await import('../src/plugins/registry.js');
  await loadPlugins();
  ({ decide } = await import('../src/agent/policy.js'));
});
const policy = (cmd) => decide('Bash', { command: `blackcat host run '${cmd}' --json` }).action;
// What actually happens when the agent's command runs (as if the policy, or the owner, had let it through).
const asAgent = (cmd) =>
  spawnSync(process.execPath, [`${root}bin/bc.js`, 'host', 'run', cmd], {
    encoding: 'utf8',
    env: { ...process.env, BLACKCAT_CALLER: 'agent' },
  });
const asOwner = (cmd) =>
  spawnSync(process.execPath, [`${root}bin/bc.js`, 'host', 'run', cmd], { encoding: 'utf8', env: { ...process.env, BLACKCAT_CALLER: '' } });

test('commands that only look run without asking; anything else asks', () => {
  for (const c of ['uptime', 'df -h', 'ls -la /tmp', 'free -m', 'systemctl status cron', 'ps aux | grep node | wc -l', 'docker ps'])
    assert.equal(policy(c), 'allow', c);
  for (const c of [
    'sudo systemctl restart cron',
    'rm -rf /tmp/x',
    'touch /tmp/x',
    'reboot',
    'uptime; reboot',
    'curl http://example.com',
    'echo x > /tmp/y',
  ])
    assert.equal(policy(c), 'ask', c);
});

test('in read mode a change is refused, in full mode everything runs', () => {
  const bc = (...a) => spawnSync(process.execPath, [`${root}bin/bc.js`, ...a], { encoding: 'utf8', env: process.env });
  bc('host', 'mode', 'read');
  assert.equal(policy('uptime'), 'allow');
  assert.equal(policy('touch /tmp/x'), 'deny');
  bc('host', 'mode', 'full');
  assert.equal(policy('touch /tmp/x'), 'allow');
  bc('host', 'mode', 'ask');
  assert.equal(policy('touch /tmp/x'), 'ask');
  assert.match(bc('host', 'mode', 'sideways').stderr, /read, ask, full/);
});

test("blackcat's own secrets are refused by the policy when named", () => {
  for (const c of [
    `cat ${dir}/data/config.json`,
    'cat ~/.ssh/id_ed25519',
    'cat ../data/config.json',
    'sqlite3 data/agent.db .dump',
    'cat /etc/shadow',
  ])
    assert.equal(policy(c), 'deny', c);
});

test('and by the command itself when the path is hidden behind a wildcard, a variable, a link or a folder', () => {
  const d = dir.replace(os.homedir(), '~');
  const cases = [
    `cat ${dir}/dat*/conf*.json`,
    `cat ${dir}/data/plugins/*/secrets.json`,
    `head -c 500 ${dir}/da?a/config.json`,
    `cat ${outside}/innocent-link`,
    `grep -r SECRET ${dir}/data`,
    `grep -r SECRET ${dir}`,
    `cat ${dir}/data/inbox-note.txt`,
    `tar cf - ${dir}/data`,
    `cp ${dir}/data/config.json /tmp/x`,
  ];
  for (const c of cases) {
    const r = asAgent(c);
    assert.notEqual(r.status, 0, `ran: ${c}`);
    assert.match(r.stderr, /private files or folders/, c);
    assert.doesNotMatch(r.stdout + r.stderr, /SECRET-(BOT-TOKEN|MAIL-PASSWORD|IN-DATA-ROOT)/, `leaked: ${c}`);
  }
  assert.ok(d);
});

test('ordinary files and the folders the agent may read are not affected', () => {
  assert.match(asAgent(`cat ${outside}/notes.txt`).stdout, /ordinary notes/);
  assert.match(asAgent(`cat ${dir}/data/inbox/hello.txt`).stdout, /a file the owner sent/);
  assert.match(asAgent('uptime').stdout, /load average/);
  assert.equal(asAgent('ls /tmp').status, 0);
});

test('the owner, typing the command themselves, is not restricted', () => {
  assert.match(asOwner(`cat ${dir}/data/inbox-note.txt`).stdout, /SECRET-IN-DATA-ROOT/);
});

test('it runs from the home folder and reports a failing command plainly', () => {
  assert.equal(asAgent('pwd').stdout.trim(), os.homedir());
  const r = asAgent('ls /definitely/not/here');
  assert.match(r.stdout, /exit code [12]/);
});
