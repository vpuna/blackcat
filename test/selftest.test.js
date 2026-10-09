// `bc selftest` asks everything that is set up whether it works right now: one read-only
// probe for each thing configured (two machines, two probes), by whoever knows how to ask.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { home } from './helpers.js';

const dir = home();
const data = path.join(dir, 'data');
const root = new URL('..', import.meta.url).pathname;
const { FORCE_COLOR: _f, BLACKCAT_CALLER: _c, ...env } = process.env;
// (Not spawnSync: the calendars and Home Assistant it asks are servers in this very process.)
const bc = (...a) =>
  new Promise((done) => {
    const c = spawn(process.execPath, [`${root}bin/bc.js`, ...a], { env });
    let stdout = '';
    let stderr = '';
    c.stdout.on('data', (d) => (stdout += d));
    c.stderr.on('data', (d) => (stderr += d));
    c.on('close', (status) => done({ status, stdout, stderr }));
  });
const json = async (...a) => {
  const r = await bc('selftest', ...a, '--json');
  if (!r.stdout.trim()) throw new Error('nothing printed: ' + r.stderr.slice(0, 400));
  return { ...JSON.parse(r.stdout), status: r.status };
};
const of = (out, part) => Object.fromEntries((out.parts.find((p) => p.part === part)?.results ?? []).map((r) => [r.name, r]));

// A stand-in for ssh: the machine at 10.0.0.9 refuses the key, any other answers.
const touched = path.join(dir, 'touched-by-a-probe');
fs.writeFileSync(
  path.join(dir, 'fake-bin/ssh'),
  `#!/bin/sh\ncase "$*" in *@10.0.0.9*) echo "me@10.0.0.9: Permission denied (publickey)." >&2; exit 255;; esac\nwhile [ $# -gt 0 ] && [ "$1" != "--" ]; do shift; done\n[ $# -gt 1 ] || exit 0\nshift\nexec sh -c "$1"\n`,
  { mode: 0o755 },
);
// Two calendars and a Home Assistant, served here.
const ICS =
  'BEGIN:VCALENDAR\r\nX-WR-CALNAME:Family\r\nBEGIN:VEVENT\r\nUID:1\r\nDTSTART:20300101T100000Z\r\nDTEND:20300101T110000Z\r\nSUMMARY:Dentist\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
const asked = [];
const server = http.createServer((req, res) => {
  asked.push(`${req.method} ${req.url}`);
  if (req.url === '/family.ics') return res.end(ICS);
  if (req.url === '/api/config')
    return req.headers.authorization === 'Bearer good-token'
      ? res.end(JSON.stringify({ version: '2026.9.1', location_name: 'Home' }))
      : (res.writeHead(401), res.end('401: Unauthorized'));
  res.writeHead(404);
  return res.end('no');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const at = `http://127.0.0.1:${server.address().port}`;

// A plugin of the owner's, with probes of every kind.
fs.mkdirSync(path.join(dir, 'user-plugins/kettle'), { recursive: true });
fs.writeFileSync(
  path.join(dir, 'user-plugins/kettle/plugin.js'),
  `export default { api: 1, name: 'kettle', title: 'Kettle', description: 'x', commands: { hello: { summary: 'x', access: 'allow', run: () => 'x' } },
  selftest: (ctx) => (ctx.config.get().kettles ?? []).map((k) => ({ name: k, timeoutMs: 400, run: async () => {
    if (k === 'broken') throw new Error('it does not answer');
    if (k === 'unplugged') return { skip: 'switched off at the wall' };
    if (k === 'silent') return new Promise(() => {});
    return 'warm';
  } })) };\n`,
);
fs.mkdirSync(path.join(dir, 'user-plugins/muddle'), { recursive: true });
fs.writeFileSync(
  path.join(dir, 'user-plugins/muddle/plugin.js'),
  "export default { api: 1, name: 'muddle', title: 'Muddle', description: 'x', commands: { hello: { summary: 'x', access: 'allow', run: () => 'x' } }, selftest: () => { throw new Error('lost the list'); } };\n",
);

const { save, load } = await import('../src/config.js');
const settings = (extra = {}) => ({
  plugins: {
    enabled: ['ssh', 'calendar', 'ha', 'mail', 'kettle', 'muddle', 'host'],
    disabled: ['backup'],
    settings: {
      ssh: {
        keepOpenMinutes: 0,
        hosts: { nas: { host: '10.0.0.5', user: 'me', mode: 'look' }, shed: { host: '10.0.0.9', user: 'me', mode: 'ask' } },
      },
      calendar: { calendars: { family: { title: 'Family' }, work: { title: 'Work' } } },
      ha: { url: at },
      mail: {
        accounts: {
          home: { address: 'me@example.org', host: '127.0.0.1', port: 1 },
          old: { address: 'old@example.org', host: '127.0.0.1', port: 1 },
        },
      },
      kettle: { kettles: ['good', 'broken', 'unplugged', 'silent'] },
      ...extra,
    },
  },
});
save(settings());
const secret = (plugin, o) => {
  fs.mkdirSync(path.join(data, 'plugins', plugin), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(data, 'plugins', plugin, 'secrets.json'), JSON.stringify(o), { mode: 0o600 });
};
secret('calendar', { 'url:family': `${at}/family.ics`, 'url:work': `${at}/gone.ics` });
secret('ha', { token: 'good-token' });
secret('mail', { 'password:old': 'x' });

test('one probe for each thing that is set up: both machines, both calendars, both mail accounts', async () => {
  const out = await json();
  assert.equal(out.status, 1, 'something is not working, so it says so to whatever ran it');
  assert.equal(out.ok, false);
  const ssh = of(out, 'ssh');
  assert.deepEqual(Object.keys(ssh), ['nas', 'shed']);
  assert.equal(ssh.nas.outcome, 'ok');
  assert.match(ssh.nas.detail, /^logged in as me@10\.0\.0\.5 · \S+ .* · the agent's mode: look$/);
  assert.deepEqual(
    [ssh.shed.outcome, ssh.shed.detail],
    ['failed', "the machine refused blackcat's key. Has its public key been added there? See: bc ssh key <host>"],
  );
  const cal = of(out, 'calendar');
  assert.deepEqual(Object.keys(cal), ['family (Family)', 'work (Work)']);
  assert.deepEqual([cal['family (Family)'].outcome, cal['family (Family)'].detail], ['ok', 'reachable · 1 events in it']);
  assert.equal(cal['work (Work)'].outcome, 'failed');
  assert.match(cal['work (Work)'].detail, /the address was not accepted/);
  const mail = of(out, 'mail');
  assert.deepEqual(Object.keys(mail), ['home (me@example.org)', 'old (old@example.org)']);
  assert.match(mail['home (me@example.org)'].detail, /no app password is saved for "home"/);
  assert.equal(mail['old (old@example.org)'].outcome, 'failed', 'a server that is not there');
  const ha = of(out, 'ha');
  assert.deepEqual(
    Object.values(ha).map((r) => [r.outcome, r.detail]),
    [['ok', 'answers · version 2026.9.1 · Home · not synced yet (bc ha sync)']],
  );
});

test('a probe that fails, has nothing to test, or never answers is each said as what it is; a plugin that cannot say its probes costs only itself', async () => {
  const out = await json('kettle', 'muddle', 'host');
  const k = of(out, 'kettle');
  assert.deepEqual([k.good.outcome, k.good.detail], ['ok', 'warm']);
  assert.deepEqual([k.broken.outcome, k.broken.detail], ['failed', 'it does not answer']);
  assert.deepEqual([k.unplugged.outcome, k.unplugged.detail], ['skipped', 'switched off at the wall']);
  assert.deepEqual([k.silent.outcome, k.silent.detail], ['failed', 'no answer within 0.4 s']);
  assert.match(of(out, 'muddle')['its tests'].detail, /could not be worked out: lost the list/);
  assert.equal(Object.values(of(out, 'host'))[0].outcome, 'ok', 'the others are still asked');
  assert.deepEqual([out.passed, out.failed, out.skipped], [2, 3, 1]);
  assert.deepEqual(
    out.parts.map((p) => p.part),
    ['host', 'kettle', 'muddle'],
    'only what was asked for',
  );
});

test('all well is said as such, and to whatever ran it; a name that is nothing to test is refused', async () => {
  const r = await bc('selftest', 'host');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^This machine\n {2}✓ \S+: /);
  assert.match(r.stdout, /All well: 1 working\.\n$/);
  // blackcat's own (the engine is a stand-in here, and says it is not signed in: that is found too)
  const own = (await bc('selftest', 'blackcat')).stdout;
  assert.match(own, /blackcat itself\n {2}✓ settings file: readable · \d+ parts have settings/);
  assert.match(own, /✓ database agent\.db: sound · /);
  assert.match(own, /✓ secrets files: 3 readable, and private/);
  assert.match(own, /✓ free space: \d/);
  assert.match(own, /[✓✗] engine for chat: /);
  const no = await bc('selftest', 'toaster');
  assert.equal(no.status, 1);
  assert.match(no.stderr, /Nothing to test called "toaster"\. There is: blackcat, /);
});

test("blackcat's own: a damaged secrets file, one other accounts can read, and a damaged database are each found", async () => {
  fs.chmodSync(path.join(data, 'plugins/ha/secrets.json'), 0o644);
  assert.match(
    of(await json('blackcat'), 'blackcat')['secrets files'].detail,
    /the secrets of ha can be read by other accounts on this machine: chmod 600 /,
  );
  fs.chmodSync(path.join(data, 'plugins/ha/secrets.json'), 0o600);
  const was = fs.readFileSync(path.join(data, 'plugins/mail/secrets.json'));
  fs.writeFileSync(path.join(data, 'plugins/mail/secrets.json'), '{ "password:old": "x', { mode: 0o600 });
  assert.match(
    of(await json('blackcat'), 'blackcat')['secrets files'].detail,
    /the secrets of mail cannot be read \(the file is damaged\)/,
  );
  fs.writeFileSync(path.join(data, 'plugins/mail/secrets.json'), was, { mode: 0o600 });
  fs.writeFileSync(path.join(data, 'plugins/mail/mail.db'), 'this is not a database, though it is called one');
  const db = of(await json('blackcat'), 'blackcat')['database plugins/mail/mail.db'];
  assert.equal(db.outcome, 'failed');
  fs.rmSync(path.join(data, 'plugins/mail/mail.db'));
});

test('nothing is changed by asking: only reads were made of the servers, no file appeared, and the settings are as they were', async () => {
  const before = JSON.stringify(load());
  const tree = () =>
    fs
      .readdirSync(data, { recursive: true })
      .filter((f) => !/agent\.db|compile-cache|\.lock$/.test(String(f)))
      .sort()
      .join('\n');
  const files = tree();
  asked.length = 0;
  await json();
  assert.deepEqual([...new Set(asked.map((a) => a.split(' ')[0]))], ['GET']);
  assert.equal(JSON.stringify(load()), before);
  assert.equal(tree(), files);
  assert.equal(fs.existsSync(touched), false);
});

test('a wrong token is found by asking, not by looking at what is saved', async () => {
  secret('ha', { token: 'expired-token' });
  const ha = Object.values(of(await json('ha'), 'ha'))[0];
  assert.equal(ha.outcome, 'failed');
  secret('ha', { token: 'good-token' });
  server.close();
});
