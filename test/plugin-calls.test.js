// One plugin may use another by its commands, and only by them: declared in the manifest,
// judged by the called command's own rules, and never a way round what the agent may not do.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { home } from './helpers.js';

const dir = home();
const root = new URL('..', import.meta.url).pathname;
const plugin = (name, body) => {
  fs.mkdirSync(path.join(dir, 'user-plugins', name), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'user-plugins', name, 'plugin.js'),
    `export default { api: 1, name: '${name}', title: '${name}', description: 'a test plugin', ${body} };\n`,
  );
};
// What is used: commands of each kind.
plugin(
  'lamp',
  `commands: {
  state: { summary: 'x', access: 'allow', untrusted: false, run: (ctx) => ({ text: 'the lamp is on', data: { on: true, askedBy: ctx.caller, secret: ctx.secrets.get('token') ?? null } }) },
  set: { summary: 'x', access: 'ask', usage: '<level> [room]', run: (ctx, i) => 'set to ' + i.level + (i.room ? ' in ' + i.room : '') },
  wire: { summary: 'x', access: 'owner', run: () => ({ rewired: true }) },
  say: { summary: 'x', raw: true, access: (ctx, t) => (t[0] === 'quietly' ? 'allow' : 'owner'), run: (ctx, i) => i._.join(' ') },
  pair: { summary: 'x', access: 'owner', interactive: true, run: () => 'paired' },
  setup: { summary: 'x', access: 'owner', form: [{ id: 'address', type: 'text', message: 'Where is it?' }], run: (ctx, a) => 'at ' + a.address },
  quiet: { summary: 'x', access: 'allow', run: () => {} },
  broken: { summary: 'x', access: 'allow', run: (ctx) => ctx.fail('the lamp is unplugged') },
}`,
);
// What uses it.
plugin(
  'evening',
  `uses: ['lamp'], commands: {
  go: { summary: 'x', access: 'allow', untrusted: false, usage: '<what> [rest...]', run: async (ctx, i) => {
    const input = i.what === 'say' ? { _: i.rest ?? [] } : i.what === 'set' ? { level: i.rest?.[0], room: i.rest?.[1] } : i.what === 'setup' ? (i.rest?.[0] ? { address: i.rest[0] } : {}) : {};
    return { data: await ctx.command('lamp', i.what, input) };
  } },
  other: { summary: 'x', access: 'allow', run: async (ctx) => ctx.command('ghost', 'boo') },
  mine: { summary: 'x', access: 'allow', untrusted: false, run: (ctx) => ({ data: { names: ctx.secrets.names() } }) },
}`,
);
plugin('nosy', `commands: { go: { summary: 'x', access: 'allow', run: async (ctx) => ctx.command('lamp', 'state') } }`);
const { save } = await import('../src/config.js');
save({ plugins: { enabled: ['lamp', 'evening', 'nosy'] } });
fs.mkdirSync(path.join(dir, 'data/plugins/lamp'), { recursive: true });
fs.writeFileSync(path.join(dir, 'data/plugins/lamp/secrets.json'), JSON.stringify({ token: 'lamp-token' }));
const { FORCE_COLOR: _f, BLACKCAT_CALLER: _c, ...env } = process.env;
const bc = (as, ...a) => {
  const r = spawnSync(process.execPath, [`${root}bin/bc.js`, ...a, '--json'], {
    encoding: 'utf8',
    env: { ...env, ...(as === 'agent' ? { BLACKCAT_CALLER: 'agent', BLACKCAT_SLOW: '1' } : {}) },
    timeout: 60_000,
  });
  let out = null;
  try {
    out = JSON.parse(r.stdout);
  } catch {}
  return { ...r, out, said: (out?.error ?? '') + r.stderr };
};

test('a plugin runs a command of one it says it uses, and is given what that command would print', () => {
  const r = bc('owner', 'evening', 'go', 'state');
  assert.equal(r.status, 0, r.said);
  assert.deepEqual(r.out, { text: 'the lamp is on', data: { on: true, askedBy: 'owner', secret: 'lamp-token' } });
  assert.deepEqual(bc('owner', 'evening', 'go', 'set', '40', 'kitchen').out, { text: 'set to 40 in kitchen', data: null });
  assert.deepEqual(bc('owner', 'evening', 'go', 'wire').out, { text: '', data: { rewired: true } });
  assert.deepEqual(bc('owner', 'evening', 'go', 'say', 'good', 'night').out, { text: 'good night', data: null });
  assert.deepEqual(bc('owner', 'evening', 'go', 'quiet').out, { text: '', data: null });
  assert.deepEqual(bc('owner', 'evening', 'go', 'setup', 'shelf').out, { text: 'at shelf', data: null });
});

test("it reaches the other's commands only: the secret came from the lamp's own command, and its own secrets are its own", () => {
  assert.deepEqual(bc('owner', 'evening', 'mine').out, { names: [] });
});

test('what the agent set going is judged as the agent: no way round an owner-only command, or one it must ask about', () => {
  assert.equal(bc('agent', 'evening', 'go', 'state').out?.data.askedBy, 'agent');
  for (const [what, why] of [
    ['wire', /for the owner only/],
    ['set', /needs the owner to approve it/],
    ['say', /for the owner only/],
  ]) {
    const r = bc('agent', 'evening', 'go', what, 'loudly');
    assert.notEqual(r.status, 0, what);
    assert.match(r.said, why, what);
  }
  assert.deepEqual(
    bc('agent', 'evening', 'go', 'say', 'quietly', 'now').out,
    { text: 'quietly now', data: null },
    'a command that judges by its words is given them',
  );
});

test('what cannot be run this way says why', () => {
  assert.match(bc('owner', 'evening', 'go', 'pair').said, /asks questions as it goes, so only a person can run it/);
  assert.match(bc('owner', 'evening', 'go', 'setup').said, /still needs: address/);
  assert.match(bc('owner', 'evening', 'go', 'nothing').said, /lamp has no "nothing" command/);
  assert.match(bc('owner', 'evening', 'go', 'broken').said, /the lamp is unplugged/);
  assert.match(bc('owner', 'nosy', 'go').said, /nosy does not say it uses "lamp": add uses: \['lamp'\] to its manifest/);
  assert.match(bc('owner', 'evening', 'other').said, /evening does not say it uses "ghost"/);
});

test('a plugin that is used and not switched on is said at once, and again by what needs it', () => {
  save({ plugins: { enabled: ['evening'] } });
  const r = bc('owner', 'evening', 'go', 'state');
  assert.match(r.stderr, /plugin "evening" uses "lamp", which is not switched on/);
  assert.match(r.said, /evening needs the lamp plugin, which is not switched on \(bc plugin enable lamp\)/);
  assert.equal(bc('owner', 'evening', 'mine').status, 0, 'the rest of it still works');
});

test('uses is a list of names; a plugin cannot use itself; a circle is said', async () => {
  const { problems } = await import('../src/plugins/registry.js');
  const { usesProblems } = await import('../src/plugins/call.js');
  const base = {
    api: 1,
    name: 'demo',
    title: 'Demo',
    description: 'x',
    commands: { go: { summary: 'x', access: 'allow', run: () => 'x' } },
  };
  assert.deepEqual(problems({ ...base, uses: ['ssh', 'ha'] }, 'demo'), []);
  assert.match(problems({ ...base, uses: 'ssh' }, 'demo').join('; '), /uses must be a list/);
  assert.match(problems({ ...base, uses: ['Not A Name'] }, 'demo').join('; '), /uses is a list of plugin names/);
  const p = (name, uses) => ({ name, manifest: { uses } });
  assert.deepEqual(usesProblems([p('a', ['b']), p('b', [])]), []);
  assert.match(usesProblems([p('a', ['a'])]).join('; '), /"a": it cannot use itself/);
  assert.deepEqual(usesProblems([p('a', ['b']), p('b', ['c']), p('c', ['a'])]), ['plugins use each other in a circle: a → b → c → a']);
});
