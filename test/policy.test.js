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
  'BLACKCAT_CALLER=owner blackcat ssh mode nas full',
  'env -u BLACKCAT_CALLER blackcat ssh put nas a b',
  'env -i blackcat ssh mode nas full',
  'sudo blackcat ssh mode nas full',
  'sh -c "blackcat ssh mode nas full"',
  'nohup blackcat backup now',
  'BLACKCAT_HOME=/tmp/x blackcat status',
  'echo x | xargs blackcat ssh run nas',
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
// Anything that is not one of blackcat's commands: refused, and told where to go instead.
const ONLY_BLACKCAT = [
  'ls -la',
  'df -h',
  'uname -a',
  'date',
  'sudo systemctl restart allsky',
  'ls ~/allsky/images',
  'cat /etc/os-release',
  'ls ../data/inbox',
  'python3 -c "print(1)"',
  'crontab -l',
  'touch /tmp/x',
  // (a blackcat command that does not exist is not one either)
  'blackcat pi health --json',
];
for (const c of DENY) test(`refused: ${c}`, () => assert.equal(bash(c), 'deny'));
test('only blackcat commands are run: anything else is refused outright, and pointed at blackcat host run', () => {
  for (const c of ONLY_BLACKCAT) {
    const d = decide('Bash', { command: c });
    assert.equal(d.action, 'deny', c);
  }
  assert.match(decide('Bash', { command: 'date' }).reason, /blackcat host run date/);
  assert.match(decide('Bash', { command: 'df -h' }).reason, /blackcat host run '<command>'.*blackcat ssh run/);
});

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
test('files: what the owner sent and fetched media may be read without asking; any other file is refused', () => {
  for (const d of ['inbox', 'archive-media', 'shortcut-files'])
    assert.equal(file('Read', `${process.env.BLACKCAT_HOME}/data/${d}/x.jpg`), 'allow', d);
  for (const p of ['/etc/os-release', `${H}/notes.txt`, '/tmp/x.jpg']) assert.equal(file('Read', p), 'deny', p);
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
test('what the file tools may not write, a command may not touch either: every login file, every part of how Claude Code is set up', () => {
  const login =
    '.bashrc .bash_profile .bash_login .bash_aliases .bash_logout .profile .zshrc .zprofile .zshenv .zlogin .inputrc .pam_environment .xprofile .xinitrc';
  const claude = 'settings.json settings.local.json CLAUDE.md commands agents skills hooks plugins';
  const config = 'systemd autostart environment.d';
  for (const p of [
    ...login.split(' ').map((f) => `${H}/${f}`),
    ...claude.split(' ').map((f) => `${H}/.claude/${f}`),
    ...config.split(' ').map((f) => `${H}/.config/${f}`),
  ]) {
    assert.equal(file('Write', p), 'deny', `write ${p}`);
    assert.equal(bash(`echo x >> ${p.replace(H, '~')}`), 'deny', `a command writing ${p}`);
  }
});
test('the agent writes no files at all, not even in its own folder', () => {
  for (const p of [`${process.env.BLACKCAT_HOME}/agent/notes.md`, `${process.env.BLACKCAT_HOME}/data/inbox/x.txt`, '/tmp/x'])
    for (const t of ['Write', 'Edit']) assert.equal(file(t, p), 'deny', `${t} ${p}`);
});
test("Claude Code's own folder is off-limits: its login and every session's transcript", () => {
  for (const p of [`${H}/.claude/projects/x/1.jsonl`, `${H}/.claude/history.jsonl`, `${H}/.claude/sessions`, `${H}/.claude`])
    assert.equal(file('Read', p), 'deny', `read ${p}`);
  for (const t of ['Grep', 'Glob']) assert.equal(decide(t, { pattern: 'x', path: `${H}/.claude` }).action, 'deny', t);
  for (const c of [
    'ls ~/.claude/projects',
    'cat ~/.claude/history.jsonl',
    'grep -ri x ~/.claude',
    `grep -r x ${H}/.claude/`,
    'ls ~/.claude',
    "blackcat host run 'cat ~/.claude/history.jsonl'",
  ])
    assert.equal(bash(c), 'deny', c);
  assert.match(decide('Bash', { command: "blackcat host run 'ls ~/.claude'" }).reason, /Claude Code's own folder/);
});
test('a search may not start above a private folder: it would go through it', () => {
  for (const t of ['Grep', 'Glob']) {
    assert.equal(decide(t, { pattern: 'x', path: H }).action, 'deny', `${t} in the home folder holds ~/.ssh`);
    assert.equal(decide(t, { pattern: 'x', path: process.env.BLACKCAT_HOME }).action, 'deny', `${t} above blackcat's data`);
    assert.equal(decide(t, { pattern: 'x', path: '/usr/share/doc' }).action, 'deny', `${t} outside its own folders`);
    assert.equal(decide(t, { pattern: 'x', path: `${process.env.BLACKCAT_HOME}/data/inbox` }).action, 'allow', `${t} in what it was sent`);
    assert.equal(decide(t, { pattern: 'x' }).action, 'allow', `${t} with no folder: its own`);
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
  // the folders of files it may send are open to the file tools, never to a command
  assert.equal(decide('Read', { file_path: `${DATA}/inbox/a.jpg` }).action, 'allow');
  assert.equal(act(`ls ${DATA}/inbox`), 'deny');
  assert.equal(decide('Read', { file_path: `${DATA}/notes.txt` }).action, 'deny');
});
