// A check with a description of what "working" looks like: once the plain rules pass, a
// reader with no tools judges the command's output, or the picture, against the owner's words.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SIGNED_IN, home, setUp } from './helpers.js';

const dir = home();
// A stand-in for `claude` that notes how it was asked and gives the answer the test queued up.
// An answer of { fail: true } is the model not being there.
const asked = path.join(dir, 'asked.jsonl');
const answers = path.join(dir, 'answers.json');
fs.writeFileSync(answers, '[]');
fs.writeFileSync(asked, '');
fs.writeFileSync(
  path.join(dir, 'fake-bin/claude'),
  `#!/bin/sh\n${SIGNED_IN}exec ${process.execPath} ${path.join(dir, 'fake.mjs')} "$@"\n`,
  {
    mode: 0o755,
  },
);
fs.writeFileSync(
  path.join(dir, 'fake.mjs'),
  `
import fs from 'node:fs';
const args = process.argv.slice(2);
const after = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(asked)}, JSON.stringify({ system: after('--append-system-prompt'), tools: after('--tools'), input: JSON.parse(input).message.content }) + '\\n');
  const queue = JSON.parse(fs.readFileSync(${JSON.stringify(answers)}, 'utf8'));
  const next = queue.shift() ?? { data: { working: true, reason: 'nothing was queued' } };
  fs.writeFileSync(${JSON.stringify(answers)}, JSON.stringify(queue));
  if (next.fail) process.exit(1);
  console.log(JSON.stringify({ type: 'result', is_error: false, result: '', structured_output: next.data }));
});
`,
);
const queue = (...a) => fs.writeFileSync(answers, JSON.stringify(a));
const calls = () =>
  fs
    .readFileSync(asked, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const says = (working, reason, problems) => ({ data: { working, reason, ...(problems ? { problems } : {}) } });
// What one look found, without the list of what is wrong.
const short = ({ problems: _p, ...r }) => r;

await setUp({ bot: { allow: [{ id: 42, name: 'me' }] } });
const { addCheck, currentFindings, getCheck, openChecksDb } = await import('../src/checks/db.js');
const { evaluate, runCheck } = await import('../src/checks/check.js');
const { addRule } = await import('../src/agent/permissions.js');
const report = path.join(dir, 'report.txt');
const fixed = path.join(dir, 'fixed.flag');

test("a command's output is judged against the owner's words, by a reader told to prefer no alarm", async () => {
  const db = openChecksDb();
  fs.writeFileSync(report, 'queue: 3 jobs waiting\n');
  const c = addCheck(db, { chatId: 42, name: 'Print queue', look_for: 'fewer than ten jobs waiting', command: `cat ${report}` });
  queue(says(true, 'Three jobs are waiting.'));
  assert.deepEqual(await evaluate(c), { ok: true, reason: 'Three jobs are waiting.', problems: [] });
  const [q] = calls();
  assert.match(
    q.input,
    /^Local time: \d{4}-\d\d-\d\d \d\d:\d\d \(\w+day\)\.\nWorking means, in the owner's words: "fewer than ten jobs waiting"/,
  );
  assert.match(q.input, /queue: 3 jobs waiting/, 'the output is what it judges');
  assert.match(q.input, /Is it working\?$/);
  assert.match(q.system, /It is not working only when the evidence clearly shows a problem/);
  assert.match(q.system, /when it is merely unclear, say that it is working/);
  assert.match(q.system, /^You are a reader\. You have no tools/, 'the ground rules every reader is told come first');
  assert.equal(q.tools, '', 'and it is given none');
  db.close();
});

test('the plain rules come first: a command that fails is not shown to the reader at all', async () => {
  const db = openChecksDb();
  const before = calls().length;
  const c = addCheck(db, { chatId: 42, name: 'Gone', look_for: 'anything', command: 'echo broken; exit 3' });
  const r = await evaluate(c);
  assert.equal(r.ok, false);
  assert.match(r.reason, /failed \(exit 3\): broken/);
  // and so with a file that is stale, missing or empty
  const old = path.join(dir, 'old.txt');
  fs.writeFileSync(old, 'x');
  fs.utimesSync(old, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
  const stale = await evaluate(addCheck(db, { chatId: 42, name: 'Stale', look_for: 'anything', file: old, maxAge: '10m' }));
  assert.match(stale.reason, /old\.txt has not changed for .* \(limit 10m\)/);
  assert.equal(calls().length, before, 'nobody was asked');
  // one with no description is never judged
  assert.deepEqual(short(await evaluate(addCheck(db, { chatId: 42, name: 'Plain', command: 'true' }))), {
    ok: true,
    reason: 'all checks passed',
  });
  assert.equal(calls().length, before);
  db.close();
});

test('the reader says it is not working: the owner is told what it saw, and the fix is run', async () => {
  const db = openChecksDb();
  fs.writeFileSync(report, 'queue: 48 jobs waiting\n');
  const fix = `sh -c 'echo "queue: 0 jobs waiting" > ${report}; touch ${fixed}'`;
  addRule('allow', fix, { via: 'test' });
  const c = addCheck(db, {
    chatId: 42,
    name: 'Queue',
    look_for: 'fewer than ten jobs waiting',
    command: `cat ${report}`,
    fix,
    tries: 2,
    wait: '1s',
  });
  queue(says(false, 'Forty-eight jobs are waiting.'), says(true, 'No jobs are waiting.'));
  const r = await runCheck(db, getCheck(db, c.id));
  assert.ok(fs.existsSync(fixed), 'the fix ran');
  assert.match(
    r.notices[0].text,
    /^🔧 Queue: it was not working \(Forty-eight jobs are waiting\.\)\. I ran `.*` 1 time and it is working again\. No jobs are waiting\./,
  );
  assert.match(calls().at(-1).input, /queue: 0 jobs waiting/, 'it was judged again after the fix, on the new output');
  assert.equal(getCheck(db, c.id).wrong, null);

  // with no fix: told once, with the reader's sentence, and again when it recovers
  const d = addCheck(db, { chatId: 42, name: 'Queue 2', look_for: 'fewer than ten jobs waiting', command: `cat ${report}` });
  queue(says(false, 'It looks stuck.'), says(false, 'Still stuck.'), says(true, 'Moving again.'));
  let s = await runCheck(db, getCheck(db, d.id));
  assert.match(s.notices[0].text, /^⚠️ Queue 2: not working\. It looks stuck\.$/);
  assert.deepEqual(
    currentFindings(db, d.id).map((f) => [f.key, f.title]),
    [['down', 'It looks stuck.']],
  );
  s = await runCheck(db, getCheck(db, d.id));
  assert.deepEqual(s.notices, []);
  s = await runCheck(db, getCheck(db, d.id));
  assert.match(s.notices[0].text, /^✅ Queue 2: working again\. .* Moving again\.$/);
  db.close();
});

test('when the reader cannot be asked, nothing is said, changed or fixed', async () => {
  const db = openChecksDb();
  fs.rmSync(fixed, { force: true });
  fs.writeFileSync(report, 'queue: 2 jobs waiting\n');
  const fix = `touch ${fixed}`;
  addRule('allow', fix, { via: 'test' });
  const c = addCheck(db, {
    chatId: 42,
    name: 'Unsure',
    look_for: 'fewer than ten jobs waiting',
    command: `cat ${report}`,
    fix,
    wait: '1s',
  });
  queue({ fail: true });
  const r = await runCheck(db, getCheck(db, c.id));
  assert.equal(r.result.ok, null);
  assert.match(r.result.reason, /^could not judge it \(/);
  assert.deepEqual(r.notices, []);
  assert.ok(!fs.existsSync(fixed), 'the fix was not run');
  assert.deepEqual([getCheck(db, c.id).wrong, currentFindings(db, c.id).length], [null, 0]);

  // it was not working, and now cannot be judged: it is still held as not working, and no "recovered" is sent
  queue(says(false, 'Too many.'), { fail: true });
  const d = addCheck(db, { chatId: 42, name: 'Unsure 2', look_for: 'fewer than ten jobs waiting', command: `cat ${report}` });
  await runCheck(db, getCheck(db, d.id));
  const again = await runCheck(db, getCheck(db, d.id));
  assert.deepEqual([again.notices, getCheck(db, d.id).wrong?.open], [[], 1]);
  db.close();
});

test('a picture is shown to the reader; one too large to look at is not, and that is no alarm', async () => {
  const db = openChecksDb();
  // (a 1×1 PNG)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const pic = path.join(dir, 'sky.png');
  fs.writeFileSync(pic, png);
  const c = addCheck(db, { chatId: 42, name: 'Sky camera', look_for: 'a picture of the sky, not a blank frame', file: pic, maxAge: '10m' });
  queue(says(false, 'The frame is blank.'));
  assert.deepEqual(short(await evaluate(c)), { ok: false, reason: 'The frame is blank.' });
  const q = calls().at(-1).input;
  assert.equal(q[0].type, 'image');
  assert.match(q[0].source.media_type, /^image\/(png|jpeg)$/);
  assert.ok(q[0].source.data.length > 20, 'the picture itself is sent');
  assert.match(q[1].text, /Working means, in the owner's words: "a picture of the sky, not a blank frame"/);
  assert.match(q[1].text, /The image is the current content of .*sky\.png\. Is it working\?$/);

  // a file that is not a picture, with no command: there is nothing to judge by
  const before = calls().length;
  const txt = path.join(dir, 'notes.txt');
  fs.writeFileSync(txt, 'x');
  assert.deepEqual(short(await evaluate(addCheck(db, { chatId: 42, name: 'Notes', look_for: 'anything', file: txt }))), {
    ok: true,
    reason: 'all checks passed',
  });
  // too large, in a form that cannot be made smaller: undecided, and nobody is asked
  const big = path.join(dir, 'big.png');
  fs.writeFileSync(big, Buffer.alloc(4 * 1024 ** 2, 1));
  assert.deepEqual(short(await evaluate(addCheck(db, { chatId: 42, name: 'Big', look_for: 'anything', file: big }))), {
    ok: null,
    reason: 'the image is too large to look at',
  });
  assert.equal(calls().length, before);
  // and no look leaves its smaller copy of a picture behind, whether or not one could be made
  assert.deepEqual(
    fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('blackcat-look-')),
    [],
  );
  db.close();
});

test("the reader's sentence is kept short, and an empty one is given words", async () => {
  const db = openChecksDb();
  fs.writeFileSync(report, 'ok\n');
  const c = addCheck(db, { chatId: 42, name: 'Words', look_for: 'says ok', command: `cat ${report}` });
  queue(says(true, 'x'.repeat(600)), says(false, '  '), says(true, ''));
  assert.equal((await evaluate(c)).reason.length, 240);
  assert.deepEqual(short(await evaluate(c)), { ok: false, reason: 'does not look right' });
  assert.deepEqual(short(await evaluate(c)), { ok: true, reason: 'looks fine' });
  db.close();
});

test('the reader names each thing wrong with a key; told what is known, it keeps the key, and each is its own outage', async () => {
  const db = openChecksDb();
  fs.writeFileSync(report, 'log\n');
  const c = addCheck(db, { chatId: 42, name: 'Activity', look_for: 'nothing unusual', command: `cat ${report}` });
  queue(
    says(false, 'Two things.', [
      { key: 'Allsky check failing', title: 'The Allsky check failed.' },
      { key: 'ssh-nas-timeouts', title: 'Two ssh runs timed out.' },
    ]),
  );
  let r = await runCheck(db, getCheck(db, c.id));
  assert.deepEqual(
    currentFindings(db, c.id).map((f) => f.key),
    ['allsky-check-failing', 'ssh-nas-timeouts'],
    'keys are made plain',
  );
  assert.deepEqual(
    r.notices.map((n) => n.text),
    ['⚠️ Activity: The Allsky check failed.', '⚠️ Activity: Two ssh runs timed out.'],
    'each is told of, with its own buttons',
  );
  // the owner snoozes one; the next look is told both, by key, and which is snoozed
  const [allsky, ssh] = currentFindings(db, c.id);
  const { snoozeFinding } = await import('../src/checks/db.js');
  snoozeFinding(db, ssh.id, null);
  queue(says(false, 'Only the timeouts.', [{ key: 'ssh-nas-timeouts', title: 'Three ssh runs timed out.' }]));
  r = await runCheck(db, getCheck(db, c.id));
  const asked = calls().at(-1).input;
  assert.match(
    asked,
    /Problems already known .*:\n- allsky-check-failing: The Allsky check failed\.\n- ssh-nas-timeouts: Two ssh runs timed out\. \(snoozed\)/,
  );
  assert.deepEqual(
    r.notices.map((n) => n.text),
    ['✅ Activity: working again (The Allsky check failed.). It had not been since ' + r.notices[0].text.split('since ')[1]],
    'the Allsky one is over and said so; the snoozed one says nothing',
  );
  const now = currentFindings(db, c.id);
  assert.deepEqual(
    now.map((f) => [f.key, f.state, f.times, f.title]),
    [['ssh-nas-timeouts', 'snoozed', 2, 'Three ssh runs timed out.']],
  );
  assert.equal(getCheck(db, c.id).wrong.open, 0);
  void allsky;
  db.close();
});
