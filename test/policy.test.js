// The agent's permission policy: what is refused outright, what asks the owner, what runs.
import assert from 'node:assert/strict';
import os from 'node:os';
import { before, test } from 'node:test';
import { home } from './helpers.js';

let decide;
before(async () => {
  home(); // an empty BLACKCAT_HOME: no standing permissions, default plugins only
  const { loadPlugins } = await import('../src/plugins/registry.js');
  await loadPlugins();
  ({ decide } = await import('../src/agent/policy.js'));
});
const bash = (command) => decide('Bash', { command }).action;
const H = os.homedir();

const DENY = [
  // managing blackcat, however it is invoked
  'blackcat permissions clear',
  'blackcat notify the build is done',
  'echo hello | blackcat notify',
  'bc permissions clear',
  '/usr/local/bin/blackcat permissions clear',
  'node bin/bc.js permissions clear',
  'node ../bin/bc.js restart',
  '~/.local/bin/blackcat service install',
  'blackcat restart',
  'blackcat stop',
  'blackcat plugin enable ssh',
  'blackcat wa unpair',
  'blackcat tg bot pair',
  'blackcat chat hi',
  'uptime; blackcat restart',
  'true && blackcat permissions clear',
  "bl''ackcat permissions clear",
  // running a blackcat command as someone else, or wrapped
  'BLACKCAT_CALLER=owner blackcat ssh mode unraid full',
  'env -u BLACKCAT_CALLER blackcat ssh put unraid a b',
  'env -i blackcat ssh mode unraid full',
  'sudo blackcat ssh mode unraid full',
  'sh -c "blackcat ssh mode unraid full"',
  'nohup blackcat backup now',
  'BLACKCAT_HOME=/tmp/x blackcat status',
  'echo x | xargs blackcat ssh run unraid',
  // its own services and processes
  'systemctl --user stop blackcat-agent',
  "systemctl --user stop 'blackcat-ag'ent",
  'systemctl --user restart blackcat-wa.service',
  'pkill -f bc.js',
  'killall claude',
  'pkill -f blackcat',
  // its code, rules and private data, by absolute or relative path
  `cat ${H}/blackcat/data/config.json`,
  'cat ../data/config.json',
  "cat ../da''ta/config.json",
  'cat ../data/permissions.json',
  'cat ../data/plugins/mail/secrets.json',
  'sqlite3 ../data/archive.db .dump',
  'sqlite3 ../data/agent.db .tables',
  'cat ../data/config.json.tmp',
  'ls ../data/plugins',
  'cat ../data/backup-tmp/pass',
  'cp ../data/archive-index.db /tmp/',
  `sed -i s/a/b/ ${H}/blackcat/src/agent/policy.js`,
  'cat ../src/agent/policy.js',
  'echo x >> ../prompts/watch-list.md',
  `echo x > ${H}/blackcat/prompts/things-to-do.md`,
  'ls ../plugins/ssh',
  // the same files reached without spelling the path out
  'd=data; cat ../$d/config.json',
  'cd ..; cd data; cat config.json',
  'cat $(echo ZGF0YS9jb25maWcuanNvbg== | base64 -d)',
  'echo cm0gLXJmIH4= | base64 --decode | sh',
  'cat ../d*/config.json',
  'cat ../dat?/permissions.json',
  'find .. -name secrets.json',
  'eval "$(cat /tmp/x)"',
  'node -e "require(\'fs\').readFileSync(String.fromCharCode(46,46,47,100))"',
  "printf '\\x64\\x61\\x74\\x61'",
  "cat $'\\x2e\\x2e/data/config.json'",
  'xxd -r -p /tmp/hex | sh',
  'tar czf /tmp/x.tgz ../data/wa-auth',
  'cp ../data/agent.db /tmp/',
  // credentials and keys
  'cat ~/.ssh/id_ed25519',
  'cat ~/.s*/id_*',
  'cat ~/.claude/.cred*',
  'cat ~/.claude/.credentials.json',
  'cat /etc/shadow',
  'cat ~/.claude.json',
  'ls ~/.gnupg',
  'cat ~/.?sh/config',
  // how Claude Code and the shell are set up
  'echo x >> ~/.bashrc',
  'echo x >> ~/.bash_aliases',
  'echo x > ~/.bash_profile',
  'echo x >> ~/.profile',
  'echo x > ~/.claude/CLAUDE.md',
  'cat ~/.claude/settings.json',
  'mkdir -p ~/.config/autostart',
  'echo x > ~/.config/systemd/user/evil.service',
];
const NOT_DENIED = [
  // ordinary things must still be possible (asked, or allowed by a plugin)
  'ls -la',
  'df -h',
  'uname -a',
  'sudo systemctl restart allsky',
  'ls ~/allsky/images',
  'cat /etc/os-release',
  'blackcat msg find dinner --json',
  'blackcat remind list --json',
  'blackcat watch list --json',
  'blackcat pi health --json',
  'ls ../data/inbox',
  'ls ~/blackcat/data/archive-media',
  'python3 -c "print(1)"',
  'crontab -l',
];
for (const c of DENY) test(`refused: ${c}`, () => assert.equal(bash(c), 'deny'));
for (const c of NOT_DENIED) test(`not refused: ${c}`, () => assert.notEqual(bash(c), 'deny'));

test('plugin read commands run without asking', () => {
  for (const c of ['blackcat remind list --json', 'blackcat watch list --json']) assert.equal(bash(c), 'allow', c);
});
test('a command that asks to run as root is marked so, run directly or through a plugin, here or on another machine', async () => {
  const { save, load } = await import('../src/config.js');
  save({
    ...load(),
    plugins: {
      ...load().plugins,
      enabled: [...(load().plugins?.enabled ?? []), 'ssh', 'host'],
      settings: {
        ...load().plugins?.settings,
        ssh: { hosts: { nas: { host: '10.0.0.5', user: 'me', mode: 'ask' } } },
        host: { mode: 'ask' },
      },
    },
  });
  const { loadPlugins } = await import('../src/plugins/registry.js');
  await loadPlugins();
  const root = (command) => {
    const d = decide('Bash', { command });
    return [d.action, d.root];
  };
  assert.deepEqual(root("blackcat ssh run nas 'sudo systemctl restart docker'"), ['ask', true]);
  assert.deepEqual(root("blackcat ssh run nas 'cd /srv && sudo rm x'"), ['ask', true]);
  assert.deepEqual(root('blackcat host run sudo systemctl restart camera'), ['ask', true]);
  assert.deepEqual(root("blackcat ssh run nas 'doas reboot'"), ['ask', true]);
  assert.deepEqual(root("blackcat ssh run nas 'systemctl restart docker'"), ['ask', false]);
  assert.deepEqual(root("blackcat ssh run nas 'touch /tmp/pseudo-sudoku'"), ['ask', false], 'a word that only contains it is not it');
  assert.deepEqual(root('sudo -n true'), ['ask', true]);
  assert.deepEqual(root('touch /tmp/x'), ['ask', false]);
});

test('a command with parts worked out only when it runs is marked as such for the owner', () => {
  assert.equal(decide('Bash', { command: 'ls $(cat /tmp/list)' }).indirect, true);
  assert.equal(decide('Bash', { command: 'python3 -c "print(1)"' }).indirect, true);
  assert.equal(decide('Bash', { command: 'f=/tmp/x; ls $f' }).indirect, true);
  assert.equal(decide('Bash', { command: 'ls -la /tmp' }).indirect, false);
});
test('anything unrecognised asks, showing the exact command', () => {
  const d = decide('Bash', { command: 'sudo systemctl restart allsky' });
  assert.equal(d.action, 'ask');
  assert.equal(d.detail, 'sudo systemctl restart allsky');
  assert.equal(d.root, true);
});

const file = (tool, p) => decide(tool, { file_path: p }).action;
test('files: private data and credentials can be neither read nor written', () => {
  for (const p of [
    `${process.env.BLACKCAT_HOME}/data/config.json`,
    `${process.env.BLACKCAT_HOME}/data/agent.db`,
    `${process.env.BLACKCAT_HOME}/data/archive-index.db`,
    `${process.env.BLACKCAT_HOME}/data/plugins/mail/secrets.json`,
    `${process.env.BLACKCAT_HOME}/data/backup-tmp/pass`,
    `${H}/.ssh/id_ed25519`,
    `${H}/.claude/.credentials.json`,
    '/etc/shadow',
  ]) {
    assert.equal(file('Read', p), 'deny', `read ${p}`);
    assert.equal(file('Write', p), 'deny', `write ${p}`);
  }
});
test('files: what the owner sent and fetched media may be read (asked), never refused', () => {
  for (const d of ['inbox', 'archive-media', 'shortcut-files'])
    assert.notEqual(file('Read', `${process.env.BLACKCAT_HOME}/data/${d}/x.jpg`), 'deny', d);
  // a plugin's folder of pictures is open only while that plugin is on (see test/allsky.test.js)
  assert.equal(file('Read', `${process.env.BLACKCAT_HOME}/data/unifi-media/x.jpg`), 'deny');
});
test("files: blackcat's code, prompts, Claude Code's instructions and login scripts can't be written", () => {
  const code = new URL('..', import.meta.url).pathname;
  for (const p of [
    `${code}src/agent/policy.js`,
    `${code}prompts/watch-list.md`,
    `${code}agent/AGENT.md`,
    `${code}package.json`,
    `${code}test/policy.test.js`,
    `${H}/.claude/CLAUDE.md`,
    `${H}/.claude/settings.json`,
    `${H}/.bashrc`,
    `${H}/.bash_aliases`,
    `${H}/.bash_profile`,
    `${H}/.profile`,
    `${H}/.config/autostart/x.desktop`,
    `${H}/.local/bin/x`,
  ]) {
    assert.equal(file('Write', p), 'deny', `write ${p}`);
    assert.equal(file('Edit', p), 'deny', `edit ${p}`);
  }
});
test('other tools are not available', () => {
  for (const t of ['WebFetch', 'WebSearch', 'Task', 'NotebookEdit']) assert.equal(decide(t, {}).action, 'deny');
});

test("a command that names anything in blackcat's data folder is refused, as the file tools refuse it", async () => {
  const { DATA } = await import('../src/config.js');
  const { decide } = await import('../src/agent/policy.js');
  const act = (command) => decide('Bash', { command }).action;
  // whatever the file is called: not only the ones known by name
  for (const c of [
    `cat ${DATA}/notes.txt`,
    `cat ${DATA}/engine-checks.json`,
    `ls ${DATA}/`,
    `sqlite3 ${DATA}/x.sqlite .dump`,
    `cat ${DATA}/inboxes/x`,
    `tar czf /tmp/x.tgz ${DATA}/run`,
  ])
    assert.equal(act(c), 'deny', c);
  // the folders of files it may send are still open to it (with the owner's say, like any command)
  for (const c of [`cp ${DATA}/inbox/a.jpg /tmp/x`, `ls ${DATA}/inbox`, `file "${DATA}/archive-media/x.jpg"`])
    assert.equal(act(c), 'ask', c);
  assert.equal(decide('Read', { file_path: `${DATA}/notes.txt` }).action, 'deny');
});
