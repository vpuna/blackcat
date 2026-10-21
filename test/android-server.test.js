// The server that reads and touches an Android device's screen, in blackcat's build: started
// with a new key each time, every request carrying it; an earlier server, which answers anyone
// on the device's network, is replaced; stopping one never stops the shell it is stopped from.
// The device here is a stand-in: adb's answers, and the server behind the forwarded port.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, test } from 'node:test';
import { home } from './helpers.js';

const dir = home();
const { Device, SERVER, STOP_SERVER, serverFile } = await import('../plugins/android/device.js');

// The device: what is on it, what runs on it, and what was asked of it.
const device = { jar: 'old', running: 'old', key: null, shell: [], pushes: 0 };
const server = http.createServer((req, res) => {
  const ours = device.running === 'ours';
  if (!device.running || (ours && req.headers['x-blackcat-key'] !== device.key)) return res.writeHead(device.running ? 401 : 503).end();
  if (req.url === '/ping') return res.end('pong');
  let body = '';
  req
    .on('data', (d) => (body += d))
    .on('end', () =>
      res.end(
        JSON.stringify(
          device.stuck
            ? { jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'java.lang.RuntimeException' } }
            : { jsonrpc: '2.0', id: 1, result: { displayWidth: 1080 } },
        ),
      ),
    );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
after(() => server.close());

const file = path.join(dir, 'u2.jar');
fs.writeFileSync(file, 'blackcat build');
const md5 = (t) => crypto.createHash('md5').update(t).digest('hex');
const { serverKey } = await import('../plugins/android/routines.js');
const ctx = {
  dataDir: dir,
  exec: async (_cmd, args) => {
    const [, , what, ...rest] = args; // adb -s <serial> …
    const out = (stdout) => ({ code: 0, stdout, stderr: '' });
    if (what === 'forward') return out(rest[0] === '--list' ? '' : String(server.address().port));
    if (what === 'push') return (device.pushes++, (device.jar = 'ours'), out(''));
    const line = rest.join(' ');
    device.shell.push(line);
    if (line.startsWith('md5sum')) return out(`${md5(device.jar === 'ours' ? 'blackcat build' : 'openatx 0.4.0')}  ${SERVER.onDevice}`);
    if (line === STOP_SERVER) return ((device.running = null), (device.stuck = false), out(''));
    const started = /-t ([0-9a-f]{64}) /.exec(line);
    if (started) return (((device.running = device.jar === 'ours' ? 'ours' : 'old'), (device.key = started[1])), out(''));
    return out('');
  },
};

test('an earlier server, answering without a key, is replaced by the pinned one, started with a new key', async () => {
  const dev = new Device(ctx, 'phone1');
  assert.equal(await dev.serverAnswers(), false, "the earlier one, which answers anyone, is not taken for blackcat's");
  await dev.ensureServer({ file });
  assert.equal(device.pushes, 1, 'the pinned server is put on the device');
  assert.equal(device.running, 'ours');
  assert.match(device.key, /^[0-9a-f]{64}$/);
  assert.equal(serverKey(ctx, 'phone1'), device.key, "kept in the plugin's database, for every blackcat process");
  assert.ok(
    device.shell.indexOf(STOP_SERVER) < device.shell.findIndex((l) => l.includes('-t ')),
    'the earlier one is stopped before the new one starts',
  );
  assert.deepEqual((await dev.call('deviceInfo')).displayWidth, 1080, 'a request carries the key');
  const { recent } = await import('../src/activity/log.js');
  const [said] = recent({ category: 'android' });
  assert.match(
    said.summary,
    /^screen server started on the phone1 with a new key: an earlier build was running, which answered anyone on the network: replaced \(the pinned build was put on it\)$/,
  );
  assert.ok(!said.summary.includes(device.key), 'never its key');
});

test('one already running with its key is left as it is; a key changed elsewhere is read again; one no process has the key of is started again', async () => {
  const dev = new Device(ctx, 'phone1');
  const before = device.shell.length;
  await dev.ensureServer({ file });
  assert.equal(device.shell.length, before, 'nothing asked of the device');
  // Started again by another blackcat process: its key is read again, and the request goes through.
  const { setServerKey } = await import('../plugins/android/routines.js');
  device.key = 'e'.repeat(64);
  setServerKey(ctx, 'phone1', device.key);
  assert.equal((await dev.call('deviceInfo')).displayWidth, 1080);
  // Started again with a key no blackcat process has (some other way): the request that met it
  // starts it again with a new key, and goes through, with nothing said to whoever asked.
  device.key = 'f'.repeat(64);
  const starts = device.shell.filter((l) => l.includes(' -t ')).length;
  assert.equal((await dev.call('deviceInfo')).displayWidth, 1080);
  assert.equal(device.shell.filter((l) => l.includes(' -t ')).length, starts + 1, 'started once more');
  assert.notEqual(device.key, 'f'.repeat(64));
  assert.equal(serverKey(ctx, 'phone1'), device.key, 'and the new key is the one kept');
  assert.equal(device.pushes, 1, 'the server on the device is already the pinned one: not put there again');
});

test('one that answers but can no longer look at the screen is started again, and the request goes through', async () => {
  const dev = new Device(ctx, 'phone1');
  device.stuck = true; // (as after a TV box's HDMI link reset: up, keyed, and unable to read the screen)
  const starts = device.shell.filter((l) => l.includes(' -t ')).length;
  assert.equal((await dev.call('dumpWindowHierarchy')).displayWidth, 1080);
  assert.equal(device.shell.filter((l) => l.includes(' -t ')).length, starts + 1, 'started once more');
  const { recent } = await import('../src/activity/log.js');
  assert.match(recent({ category: 'android' })[0].summary, /it answered but could not look at the screen/);
});

test('stopping the server is written so that it cannot stop the shell it runs in', () => {
  // pkill -f matches whole command lines: the shell running it holds the pattern too, unless
  // the pattern is written so that the text it matches is not the text it is.
  const pattern = /'(.+)'/.exec(STOP_SERVER)[1];
  assert.ok(new RegExp(pattern).test('app_process / com.wetest.uia2.Main -p 9008'), 'the server is matched');
  assert.ok(!new RegExp(pattern).test(`sh -c ${STOP_SERVER}`), 'the shell is not');
});

test('the server comes with the plugin and is the pinned one', () => {
  assert.equal(serverFile(), SERVER.file);
  assert.equal(fs.statSync(SERVER.file).size, SERVER.bytes);
});
