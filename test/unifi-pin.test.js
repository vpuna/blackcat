// The UniFi API key must only ever be sent to the console whose certificate was accepted
// at setup, including when something else starts answering at that address later on.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { home } from './helpers.js';

const dir = home();
const { client, fingerprint } = await import('../plugins/unifi/api.js');

function cert(name) {
  const key = path.join(dir, `${name}.key`);
  const crt = path.join(dir, `${name}.crt`);
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '2', '-subj', `/CN=${name}`],
    { stdio: 'ignore' },
  );
  return { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };
}
const seen = []; // every request that reached a server, with the key it carried
const serve = (creds, label, port = 0) =>
  new Promise((resolve) => {
    const s = https.createServer(creds, (req, res) => {
      seen.push({ label, key: req.headers['x-api-key'] ?? null });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: label }));
    });
    s.listen(port, '127.0.0.1', () => resolve(s));
  });
const stop = (s) =>
  new Promise((r) => {
    s.closeAllConnections?.();
    s.close(r);
  });

let real, realCreds, impostorCreds, port, pin;
before(async () => {
  realCreds = cert('console');
  impostorCreds = cert('impostor');
  real = await serve(realCreds, 'real');
  port = real.address().port;
  pin = await fingerprint(`127.0.0.1:${port}`);
});
after(async () => real && stop(real));

test('the remembered console gets the key and answers', async () => {
  const u = client({ host: `127.0.0.1:${port}`, key: 'SECRET-KEY', pin });
  assert.deepEqual(await u.get('network', '/info'), { ok: 'real' });
  assert.deepEqual(seen.at(-1), { label: 'real', key: 'SECRET-KEY' });
});

test('a console with another certificate is refused before the key is sent', async () => {
  const other = await serve(impostorCreds, 'impostor');
  const before = seen.length;
  const u = client({ host: `127.0.0.1:${other.address().port}`, key: 'SECRET-KEY', pin });
  await assert.rejects(u.get('network', '/info'), /certificate/i);
  assert.equal(seen.length, before, 'no request may reach the impostor');
  await stop(other);
});

test('something that takes over the address later, in the same process, never gets the key', async () => {
  const u = client({ host: `127.0.0.1:${port}`, key: 'SECRET-KEY', pin });
  await u.get('network', '/info'); // the certificate is now known to this process
  await stop(real);
  real = await serve(impostorCreds, 'impostor', port); // same address, different certificate
  const before = seen.length;
  await assert.rejects(u.get('network', '/info'), /certificate/i);
  await assert.rejects(u.post('internal', '/api/x', { a: 1 }), /certificate/i);
  assert.equal(seen.length, before, 'no request may reach the impostor');
});

test('with no certificate remembered, the key is not sent at all', async () => {
  const s = await serve(realCreds, 'real-2');
  const before = seen.length;
  const u = client({ host: `127.0.0.1:${s.address().port}`, key: 'SECRET-KEY', pin: undefined });
  await assert.rejects(u.get('network', '/info'), /never recorded/);
  assert.equal(seen.length, before);
  await stop(s);
});
