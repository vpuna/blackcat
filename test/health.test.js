// `bc health`: one line for each thing blackcat reaches, what only looks at this machine counted
// on one line, and since when a thing has not been working. The check "Connections" runs it:
// each thing not working is one of its findings, told only once it has lasted half an hour.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { home } from './helpers.js';

const dir = home();
const root = new URL('..', import.meta.url).pathname;
const { FORCE_COLOR: _f, BLACKCAT_CALLER: _c, ...env } = process.env;
const bc = (...a) => spawnSync(process.execPath, [`${root}bin/bc.js`, ...a], { env, encoding: 'utf8' });
const json = (...a) => {
  const r = bc(...a, '--json');
  if (!r.stdout.trim()) throw new Error(`nothing printed: ${r.stderr.slice(0, 400)}`);
  return { ...JSON.parse(r.stdout), status: r.status };
};

// A plugin of the owner's: two kettles it reaches (the garden one as `garden` says), and its
// descaling, which it only looks at here. Asking the hall one writes to the log, which is never
// part of what --json gives.
const garden = path.join(dir, 'garden');
fs.writeFileSync(garden, 'fine');
fs.mkdirSync(path.join(dir, 'user-plugins/kettle'), { recursive: true });
fs.writeFileSync(
  path.join(dir, 'user-plugins/kettle/plugin.js'),
  `import fs from 'node:fs';
export default { api: 1, name: 'kettle', title: 'Kettle', description: 'x', commands: { hello: { summary: 'x', access: 'allow', run: () => 'x' } },
  selftest: (ctx) => [
    { name: 'hall', run: () => { ctx.log('hall: asked'); return 'warm'; } },
    { name: 'garden (out the back)', run: () => { if (fs.readFileSync(${JSON.stringify(garden)}, 'utf8') !== 'fine') throw new Error('it does not answer'); return 'warm'; } },
    { name: 'descaled', local: true, run: () => 'last week' },
    { name: 'boiler', local: true, timeoutMs: 90_000, run: () => new Promise((r) => setTimeout(() => r('hot'), 300)) },
  ] };\n`,
);
const { save } = await import('../src/config.js');
save({ plugins: { enabled: ['kettle'], disabled: ['backup'] } });

test('one line for each thing reached; what only looks here is counted; the checks are left out', () => {
  const h = json('health');
  assert.equal(h.status, 0);
  assert.equal(h.ok, true);
  const line = (label) => h.lines.find((l) => l.label === label);
  assert.equal(line('Kettle: hall').detail, 'warm');
  assert.equal(line('Kettle: garden').outcome, 'ok', 'an address in brackets is left out of the name');
  assert.ok(!line('Kettle: descaled'), 'only looked at here: counted, not listed');
  assert.ok(h.local.fine >= 1 && h.local.parts.includes('Kettle'));
  assert.ok(!h.lines.some((l) => /^Checks/.test(l.label)), 'a check tells of itself');
  assert.deepEqual(h.problems, []);
  assert.match(
    bc('health').stdout,
    /\nHealth at \d\d:\d\d: all working\n(.*\n)*✓ Kettle: hall · warm\n(.*\n)*✓ On this machine: \d+ more working \([^)]*Kettle/,
  );
});

test('one that stops working: said so, and since when, the same from one look to the next', async () => {
  fs.writeFileSync(garden, 'broken');
  const first = json('health');
  assert.equal(first.status, 1, 'something is not working, so it says so to whatever ran it');
  assert.deepEqual(
    first.problems.map((p) => [p.key, p.title]),
    [['kettle-garden', 'Kettle: garden: it does not answer']],
  );
  await new Promise((r) => setTimeout(r, 1100));
  const again = json('health');
  assert.equal(again.problems[0].since, first.problems[0].since, 'not working since the first look that found it');
  assert.ok(again.checked > first.checked);
  assert.match(
    bc('health').stdout,
    /\nHealth at \d\d:\d\d: 1 not working\n(.*\n)*✗ Kettle: garden · it does not answer · since today \d\d:\d\d\n/,
  );
  fs.writeFileSync(garden, 'fine');
  assert.equal(json('health').lines.find((l) => l.label === 'Kettle: garden').outcome, 'ok');
});

test('the check "Connections": each thing not working is a finding, told only once it has lasted half an hour', async () => {
  fs.writeFileSync(garden, 'broken');
  assert.equal(bc('check', 'run', 'Connections').status, 0);
  const { openChecksDb } = await import('../src/checks/db.js');
  const db = openChecksDb();
  const c = db.prepare("SELECT * FROM checks WHERE builtin = 'connections'").get();
  assert.equal(c.command, 'blackcat health --json');
  assert.deepEqual(JSON.parse(c.alert), { afterS: 1800 });
  const found = db.prepare("SELECT key, title, alerted FROM check_findings WHERE check_id = ? AND state = 'open'").all(c.id);
  db.close();
  assert.deepEqual(found, [{ key: 'kettle-garden', title: 'Kettle: garden: it does not answer', alerted: 0 }]);
  fs.writeFileSync(garden, 'fine');
});

// A mail server may be given a minute and a half; bc health waits for no probe longer than its
// cap, so that the whole answers within the minute its check is given.
test('no probe is waited for longer than the cap, whatever time it asks for', async () => {
  const { selftest } = await import('../src/selftest.js');
  const r = await selftest({ only: ['kettle'], together: true, capMs: 100 });
  const boiler = r.parts[0].results.find((x) => x.name === 'boiler');
  assert.deepEqual([boiler.outcome, boiler.detail], ['failed', 'no answer within 0.1 s']);
  assert.equal((await selftest({ only: ['kettle'], together: true })).parts[0].results.find((x) => x.name === 'boiler').outcome, 'ok');
});
