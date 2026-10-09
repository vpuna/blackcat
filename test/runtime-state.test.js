// What changes with use is kept in agent.db, not in files written in place: standing
// permissions, the engine check's results, and what a plugin last fetched. Secrets stay
// in their file, which is written whole or not at all.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { home } from './helpers.js';

const dir = home();
const data = path.join(dir, 'data');
const root = new URL('..', import.meta.url).pathname;
const { save } = await import('../src/config.js');
save({});
const perms = await import('../src/agent/permissions.js');
const { storeFor } = await import('../src/store.js');
const many = (script, n, ...args) =>
  Promise.all(
    Array.from({ length: n }, (_, i) => new Promise((r) => fork(script, [String(i), ...args], { stdio: 'ignore' }).on('exit', r))),
  );

test('a standing permission is found by its exact command; a new answer replaces the old one and takes the next id', () => {
  const a = perms.addRule('allow', 'blackcat ssh run nas "docker ps"', { via: 'chat' });
  const b = perms.addRule('deny', '  sudo reboot ', { via: 'terminal' });
  assert.deepEqual([a.id, b.id, b.command], [1, 2, 'sudo reboot']);
  assert.equal(perms.ruleFor('  sudo reboot ').effect, 'deny', 'found by the exact command, spaces at the ends aside');
  assert.equal(perms.ruleFor('sudo reboot now'), null);
  const r = perms.addRule('allow', 'sudo reboot', { via: 'chat' });
  assert.deepEqual([r.id, r.effect, r.via], [2, 'allow', 'chat']);
  assert.deepEqual(
    perms.listRules().map((x) => x.id),
    [1, 2],
  );
  assert.equal(perms.removeRule('1').command, 'blackcat ssh run nas "docker ps"');
  assert.equal(perms.removeRule(1), null);
  assert.throws(() => perms.addRule('maybe', 'ls'), /allow or deny/);
  assert.throws(() => perms.addRule('allow', '  '), /a command/);
});

test('answers given by several processes at the same moment are all kept', async () => {
  const script = path.join(dir, 'answer.mjs');
  fs.writeFileSync(
    script,
    `const { addRule } = await import(${JSON.stringify(`${root}src/agent/permissions.js`)}); addRule('allow', 'echo ' + process.argv[2], { via: 'terminal' });`,
  );
  assert.deepEqual(await many(script, 8), Array(8).fill(0));
  const mine = perms.listRules().filter((r) => r.command.startsWith('echo '));
  assert.equal(mine.length, 8);
  assert.equal(new Set(mine.map((r) => r.id)).size, 8, 'each with an id of its own');
  assert.equal(perms.clearRules(), 9);
  assert.deepEqual(perms.listRules(), []);
});

test('the store: a value under a key, per part; changed in one step', async () => {
  const a = storeFor('alpha');
  const b = storeFor('beta');
  assert.equal(a.get('seen'), undefined);
  a.set('seen', { n: 1, list: ['x'] });
  b.set('seen', 'something else');
  assert.deepEqual(a.get('seen'), { n: 1, list: ['x'] });
  assert.equal(b.get('seen'), 'something else');
  assert.deepEqual(
    a.update('seen', (was) => ({ ...was, n: was.n + 1 })),
    { n: 2, list: ['x'] },
  );
  a.set('zero', 0);
  a.set('nothing', null);
  assert.deepEqual([a.get('zero'), a.get('nothing'), a.keys()], [0, null, ['nothing', 'seen', 'zero']]);
  assert.equal(a.delete('zero'), true);
  assert.equal(a.delete('zero'), false);
  a.set('nothing', undefined);
  assert.deepEqual(a.keys(), ['seen']);

  // several processes adding one to the same number: none is lost
  const script = path.join(dir, 'count.mjs');
  fs.writeFileSync(
    script,
    `const { storeFor } = await import(${JSON.stringify(`${root}src/store.js`)}); storeFor('alpha').update('count', (n) => (n ?? 0) + 1);`,
  );
  assert.deepEqual(await many(script, 8), Array(8).fill(0));
  assert.equal(a.get('count'), 8);
});

test("a plugin's secrets: written whole or not at all, both of two written at once kept, and a damaged file never taken for empty", async () => {
  const { makeCtx } = await import('../src/plugins/registry.js');
  const ctx = makeCtx({ name: 'vault' });
  const file = path.join(data, 'plugins/vault/secrets.json');
  assert.deepEqual([ctx.secrets.get('token'), ctx.secrets.has('token'), ctx.secrets.names()], [undefined, false, []]);
  ctx.secrets.set('token', 'abc');
  ctx.secrets.set('password:home', 'p w');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { token: 'abc', 'password:home': 'p w' });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['secrets.json'], 'nothing left beside it');
  ctx.secrets.delete('token');
  assert.deepEqual(ctx.secrets.names(), ['password:home']);

  const script = path.join(dir, 'secret.mjs');
  fs.writeFileSync(
    script,
    `const { makeCtx } = await import(${JSON.stringify(`${root}src/plugins/registry.js`)}); makeCtx({ name: 'vault' }).secrets.set('k' + process.argv[2], process.argv[2]);`,
  );
  assert.deepEqual(await many(script, 8), Array(8).fill(0));
  assert.deepEqual(ctx.secrets.names().sort(), ['k0', 'k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'password:home']);

  fs.writeFileSync(file, '{ "token": "abc", "pass');
  assert.throws(() => ctx.secrets.get('token'), /secrets of vault cannot be read: .*is damaged/);
  assert.throws(() => ctx.secrets.set('new', 'x'), /is damaged/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ "token": "abc", "pass', 'and it is not written over');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['secrets.json'], 'no lock left behind');
});

test("the engine check's results: what was accepted, and what awaits a decision", async () => {
  const waiting = { stamp: 'S2', result: { role: 'chat', engine: 'x', accuracy: [{ ok: true }], security: [] } };
  const report = await import('../src/engines/check/report.js');
  assert.equal(report.lastAccepted('chat'), null);
  report.keepPending('chat', waiting.stamp, waiting.result);
  assert.deepEqual(report.pending().chat, waiting);
  report.keepPending('readers', 'S4', { role: 'readers', n: 2 });
  assert.deepEqual(report.pending().readers, { stamp: 'S4', result: { role: 'readers', n: 2 } });
  const now = report.accept('chat', waiting);
  assert.deepEqual([now.stamp, now.summary.accuracy, now.withBroken], ['S2', { ok: 1, of: 1 }, false]);
  assert.deepEqual(Object.keys(report.pending()), ['readers'], 'what was accepted no longer awaits a decision');
  assert.deepEqual(report.lastAccepted('chat').stamp, 'S2');
});

test('what a plugin last fetched is kept in its own store', async () => {
  const { makeCtx } = await import('../src/plugins/registry.js');
  const ha = makeCtx({ name: 'ha' });
  const cat = {
    synced: 1700000000,
    version: '2026.1',
    location: 'Home',
    areas: [{ id: 'kitchen', name: 'Kitchen' }],
    entities: [{ id: 'light.kitchen', domain: 'light', name: 'Kitchen light', area: 'kitchen', available: true }],
  };
  ha.store.set('catalogue', cat);
  const { readCatalogue } = await import('../plugins/ha/catalogue.js');
  assert.deepEqual(readCatalogue(ha), cat);
  assert.deepEqual(ha.store.keys(), ['catalogue']);
  assert.equal(readCatalogue(makeCtx({ name: 'calendar' })), null, "another plugin's store is its own");
});
