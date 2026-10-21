// A picture that arrives in a collected chat is read for its text when it arrives: on this
// machine first, and by the model when that reading is not sure enough. The words are kept
// with the message, so a search finds them and every watch reads them; a photo with no text
// in it says nothing to anyone.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { SIGNED_IN, home, setUp } from './helpers.js';

const dir = home();
const root = new URL('..', import.meta.url).pathname;
// A stand-in for `claude` that notes how it was asked and gives the answer the test queued up.
const asked = path.join(dir, 'asked.jsonl');
const answers = path.join(dir, 'answers.json');
fs.writeFileSync(answers, '[]');
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
  fs.appendFileSync(${JSON.stringify(asked)}, JSON.stringify({ system: after('--append-system-prompt'), schema: after('--json-schema'), input: JSON.parse(input).message.content }) + '\\n');
  const queue = JSON.parse(fs.readFileSync(${JSON.stringify(answers)}, 'utf8'));
  const next = { data: {}, ...(queue.shift() ?? { data: { items: [], groups: [] } }) };
  fs.writeFileSync(${JSON.stringify(answers)}, JSON.stringify(queue));
  const want = JSON.parse(after('--json-schema') ?? '{}').required ?? [];
  const data = Object.fromEntries(Object.entries(next.data).filter(([k]) => want.includes(k)));
  // ("__PID__" in an answer becomes this process's own number, so two readers asked at once answer differently.)
  console.log(JSON.stringify({ type: 'result', is_error: false, result: next.text ?? '', structured_output: data }).replace(/__PID__/g, String(process.pid)));
});
`,
);
const queue = (...a) => fs.writeFileSync(answers, JSON.stringify(a));
const calls = () =>
  fs
    .readFileSync(asked, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
const plain = () => {
  const { FORCE_COLOR: _f, ...env } = process.env;
  return { ...env, NO_COLOR: '1' };
};
const bc = (...args) => {
  const r = spawnSync(process.execPath, [`${root}bin/bc.js`, ...args], { encoding: 'utf8', env: plain() });
  return { ...r, said: r.stdout + r.stderr };
};

// Something that reads pictures on this machine, as a plugin of the owner's own: the "picture"
// is a small JSON file saying what a reading of it would come to.
fs.mkdirSync(path.join(dir, 'user-plugins/eyes'), { recursive: true });
fs.writeFileSync(
  path.join(dir, 'user-plugins/eyes/plugin.js'),
  `import fs from 'node:fs';
export default {
  api: 1, name: 'eyes', title: 'Eyes', description: 'reads pictures, for the tests',
  commands: { hello: { summary: 'says hello', access: 'allow', run: () => 'hello' } },
  fileReaders: [{
    kind: 'pictures',
    read: async (_ctx, { file }) => {
      const is = fs.readFileSync(file, 'utf8');
      fs.appendFileSync(process.env.BLACKCAT_HOME + '/seen.log', file + '\\n');
      return is === 'BROKEN' ? { error: 'the picture could not be opened' } : JSON.parse(is);
    },
  }],
};
`,
);
await setUp({ bot: { allow: [{ id: 42, name: 'me' }] }, plugins: { enabled: ['eyes'], disabled: ['voice', 'ocr', 'docs'] } });
const { load, save } = await import('../src/config.js');
const nowS = Math.floor(Date.now() / 1000);
// (Pictures have been read here for the last hour: what came before that is not news to a watch.)
save({ ...load(), archive: { reading: { pictures: { mode: 'both', since: nowS - 3600 } } } });
const { openWrite } = await import('../src/archive/db.js');
const { MEDIA_DIR } = await import('../src/archive/files.js');
const { openWatchDb, addWatch, getWatch, listItems } = await import('../src/watch/db.js');
const { collect } = await import('../src/watch/collect.js');
const { loadPlugins } = await import('../src/plugins/registry.js');
await loadPlugins();
const seen = () =>
  fs.existsSync(path.join(dir, 'seen.log')) ? fs.readFileSync(path.join(dir, 'seen.log'), 'utf8').trim().split('\n') : [];

const wa = openWrite();
wa.prepare("INSERT INTO chats (ref, name, is_group) VALUES ('wa:111@s.whatsapp.net', 'Maya', 0)").run();
let n = 0;
const at = () => nowS - 300 + ++n;
const say = (text) => {
  const id = `P${n + 1}`;
  wa.prepare(
    "INSERT INTO messages (chat_ref, id, sender_ref, from_me, ts, type, text) VALUES ('wa:111@s.whatsapp.net', ?, 'wa:111@s.whatsapp.net', 0, ?, 'text', ?)",
  ).run(id, at(), text);
  return id;
};
// A picture: its row, and the file as if it had been fetched already. `reading` is what the stand-in reads in it.
const picture = (reading, { caption = null, ts = null } = {}) => {
  const id = `P${n + 1}`;
  const r = wa
    .prepare(
      "INSERT INTO messages (chat_ref, id, sender_ref, from_me, ts, type, text) VALUES ('wa:111@s.whatsapp.net', ?, 'wa:111@s.whatsapp.net', 0, ?, 'image', ?)",
    )
    .run(id, ts ?? at(), caption);
  if (ts) n++;
  wa.prepare("INSERT INTO media (msg_rowid, dl_type, mimetype) VALUES (?, 'image', 'image/jpeg')").run(r.lastInsertRowid);
  fs.mkdirSync(path.join(MEDIA_DIR, id), { recursive: true });
  fs.writeFileSync(path.join(MEDIA_DIR, id, 'image.jpg'), typeof reading === 'string' ? reading : JSON.stringify(reading));
  return id;
};
const db = openWatchDb();
const watch = addWatch(db, {
  chatId: 42,
  name: 'From Maya',
  lookFor: 'plans',
  sources: { chats: [{ ref: 'wa:111@s.whatsapp.net', name: 'Maya' }] },
  mode: 'briefing',
});
const look = () => collect(db, getWatch(db, watch.id));
const { readNow } = await import('../src/archive/reading.js');
const { noteFor, openNotesDb } = await import('../src/archive/attachments.js');
const { withDb } = await import('../src/db.js');
const note = (id) => withDb(openNotesDb, (d) => noteFor(d, id));
const asks = () => (fs.existsSync(asked) ? calls().length : 0);
const lineFor = (id) =>
  calls()
    .at(-1)
    .input.split('\n')
    .find((l) => l.startsWith(`[${id}]`));
const item = (id, title) => ({ message_id: id, title, category: 'plan', summary: 'she said so', confidence: 0.9 });
const text = (...a) => bc('msg', 'reading', ...a).stdout;

test('a picture with clear text is read on this machine when it arrives; a search finds it and a watch reads it as the message', async () => {
  const p = picture({ text: 'Appointment at the clinic\nMonday 12.10 at 16:20 with Dr Lee', extra: [], score: 91 });
  // a look that comes before it has been read leaves it for the next
  queue({ data: { items: [] } });
  const before = asks();
  assert.equal((await look()).looked, 0);
  assert.equal(asks(), before, 'no reader was asked about a picture nobody has read yet');
  const tally = {};
  assert.deepEqual(await readNow({ tally }), { done: 1, failed: 0, left: 0 });
  assert.deepEqual(tally, { pictures: { done: 1, failed: 0 } });
  assert.equal(asks(), before, 'sure enough of it: the model was not asked');
  assert.deepEqual(note(p), {
    status: 'ok',
    note: '(text in a picture, read by a machine: a word may be wrong) Appointment at the clinic\nMonday 12.10 at 16:20 with Dr Lee',
    attempts: 1,
    by: 'local',
    score: 91,
  });
  assert.match(bc('msg', 'search', 'clinic').stdout, /\[image\] 🔤 “Appointment at the «clinic»/);
  queue({ data: { items: [item(p, 'Clinic on Monday 16:20')] } });
  const r = await look();
  assert.deepEqual(
    r.added.map((i) => i.title),
    ['Clinic on Monday 16:20'],
  );
  assert.match(
    lineFor(p),
    /\+111 in Maya: \(no text\) \| attachment: image, which says: \(text in a picture, read by a machine: a word may be wrong\) Appointment at the clinic \/ Monday 12\.10 at 16:20 with Dr Lee$/,
  );
  assert.match(
    text('--show', p),
    new RegExp(
      `^${p}: read · on this machine · this machine was sure to 91 of 100 \\(the level was 60\\) · [\\d.]+ s here\\n\\(text in a picture`,
    ),
  );
});

test('one this machine is not sure of is given to the model, and what the model read is kept', async () => {
  const p = picture({ text: 'Statutory words 1\nequipped harass', extra: ['exaggerate', 'occur'], score: 29 });
  queue({ text: 'A spelling list, "Statutory words 1": exaggerate, occur, correspond, equipped, harass.' });
  const before = asks();
  assert.deepEqual(await readNow(), { done: 1, failed: 0, left: 0 });
  assert.equal(asks(), before + 1);
  const asking = calls().at(-1).input;
  assert.equal(asking[0].type, 'image', 'the picture itself was given to it');
  assert.equal(note(p).by, 'both');
  assert.equal(note(p).score, 29);
  assert.equal(
    note(p).note,
    '(a picture, as a model read it) A spelling list, "Statutory words 1": exaggerate, occur, correspond, equipped, harass.',
  );
  assert.match(text('--show', p), /read · by the model, after this machine was not sure enough · this machine was sure to 29 of 100/);
  assert.match(bc('msg', 'search', 'correspond').stdout, /🔤/);
});

test('a photo with no text in it says nothing: no model is asked, and no watch is shown it', async () => {
  const photo = picture({ text: '', extra: [], score: 100, words: 0 });
  const m = say('look at this view');
  const before = asks();
  assert.deepEqual(await readNow(), { done: 1, failed: 0, left: 0 });
  assert.equal(asks(), before);
  assert.deepEqual(note(photo), { status: 'empty', note: 'there is no text in it', attempts: 1, by: 'local', score: 100 });
  queue({ data: { items: [] } });
  await look();
  assert.equal(lineFor(photo), undefined, 'not among what the reader was shown');
  assert.match(lineFor(m), /look at this view \| said just before: .*\+111: \(a picture\)$/, 'but still there as what came before');
  // and it is done with: another look does not come back to it
  const again = asks();
  await look();
  assert.equal(asks(), again);
  assert.match(text('--show', photo), /read: nothing in it to read · on this machine · this machine was sure to 100 of 100/);
});

test('the level decides, and can be moved; on this machine only, an unsure one is kept and said to be unsure', async () => {
  assert.match(
    text(),
    /^Pictures: the text in them is read as they arrive, on this machine; one it is sure of to less than 60 of 100 is given to the model\. None is waiting\.$/m,
  );
  assert.match(text('--picture-level', '20'), /less than 20 of 100/);
  const low = picture({ text: 'a poster for the fair', extra: ['Saturday'], score: 45 });
  const before = asks();
  await readNow();
  assert.equal(asks(), before, 'over the level now: kept as this machine read it');
  assert.equal(
    note(low).note,
    '(text in a picture, read by a machine: a word may be wrong) a poster for the fair\n(also in the picture, read less surely: Saturday)',
  );
  assert.notEqual(bc('msg', 'reading', '--picture-level', '140').status, 0);
  text('--picture-level', '60');
  assert.match(text('--pictures', 'local'), /^Pictures: the text in them is read as they arrive, on this machine only\./m);
  const unsure = picture({ text: 'half of a menu', extra: [], score: 30 });
  await readNow();
  assert.equal(asks(), before, 'the model is never asked');
  assert.deepEqual(
    [note(unsure).by, note(unsure).note],
    ['local', '(text in a picture, read by a machine: some of it may be missing or wrong) half of a menu'],
  );
});

test('by the model only, when that is chosen: this machine does not read at all', async () => {
  assert.match(text('--pictures', 'model'), /^Pictures: every one is read by the model\./m);
  const p = picture({ text: 'never looked at', score: 99 });
  const was = seen().length;
  queue({ text: 'A ticket for the concert on Friday at 20:00.' });
  assert.deepEqual(await readNow(), { done: 1, failed: 0, left: 0 });
  assert.equal(seen().length, was);
  assert.deepEqual(
    [note(p).by, note(p).score, note(p).note],
    ['model', null, '(a picture, as a model read it) A ticket for the concert on Friday at 20:00.'],
  );
  assert.notEqual(bc('msg', 'reading', '--pictures', 'sometimes').status, 0);
  text('--pictures', 'both');
});

test('switched off, nothing is read, and a watch reads a picture as a picture', async () => {
  assert.match(text('--pictures', 'off'), /^Pictures: not read \(switched off\)/m);
  const p = picture({ text: 'the wifi password is on the fridge', score: 95 }, { caption: 'for when you come' });
  assert.deepEqual(await readNow(), { off: true });
  assert.equal(note(p), null);
  queue({ data: { items: [] } });
  await look();
  assert.match(lineFor(p), /in Maya: for when you come \| said just before/);
  assert.doesNotMatch(lineFor(p), /attachment|fridge/, 'its caption is a message like any other, with nothing said of the picture');
  // on again: it is read, and the job says what it did
  text('--pictures', 'both');
  const job = bc('plugin', 'job', 'msg', 'read');
  assert.equal(job.status, 0, job.said);
  const { recent } = await import('../src/activity/log.js');
  assert.equal(recent({ kind: 'job', category: 'msg/read', limit: 1 })[0].summary, 'read 1 picture');
  assert.match(bc('msg', 'search', 'fridge').stdout, /for when you come 🔤 “the wifi password/);
});

test('one that cannot be read is tried again later, not at once; and the pictures from before are read for searching only', async () => {
  const bad = picture('BROKEN');
  assert.deepEqual(await readNow(), { done: 0, failed: 1, left: 0 });
  assert.deepEqual(await readNow(), { done: 0, failed: 0, left: 0 }, 'not straight away');
  // (the watch is up to date with what has been read so far)
  queue({ data: { items: [] } });
  await look();
  // from two days ago, before pictures were read here: read now, so that a search finds it...
  const old = picture({ text: 'boarding pass for the flight to Lisbon', score: 90 }, { ts: nowS - 2 * 86400 });
  // ...and from two months ago: left alone
  const ancient = picture({ text: 'a receipt from the summer', score: 90 }, { ts: nowS - 60 * 86400 });
  assert.deepEqual(await readNow(), { done: 1, failed: 0, left: 0 });
  assert.match(bc('msg', 'search', 'Lisbon').stdout, /🔤/);
  assert.equal(note(ancient), null);
  // no watch goes back to it
  const before = asks();
  queue({ data: { items: [item(old, 'Flight to Lisbon')] } });
  await look();
  assert.equal(asks(), before, 'nothing new for the watch to read');
  assert.deepEqual(
    listItems(db, watch.id).filter((i) => /Lisbon/.test(i.title)),
    [],
  );
  assert.equal(note(bad), null, 'the broken one is still to be tried again');
});

test('what is kept of each reading answers how it is going: by what, how sure, how long, and what another level would do', async () => {
  const { recent } = await import('../src/activity/log.js');
  // one that goes to the model: what this machine read is kept beside what the model read
  const p = picture({ text: 'Week 7', extra: ['necessary'], score: 22, words: 2 });
  queue({ text: 'A spelling list for week 7: necessary, neighbour.' });
  await readNow();
  const raw = withDb(openNotesDb, (d) =>
    d.prepare('SELECT kind, level, by, score, local_note, local_ms, model_ms FROM attachment_notes WHERE msg_id = ?').get(p),
  );
  assert.deepEqual(
    { kind: raw.kind, level: raw.level, by: raw.by, score: raw.score, local: raw.local_note },
    { kind: 'pictures', level: 60, by: 'both', score: 22, local: 'Week 7\n(also in the picture, read less surely: necessary)' },
  );
  assert.ok(raw.local_ms >= 0 && raw.model_ms >= 0);
  const shown = text('--show', p);
  assert.match(shown, /this machine was sure to 22 of 100 \(the level was 60\) · [\d.]+ s here, [\d.]+ s by the model/);
  assert.match(shown, /\n\nWhat this machine read:\nWeek 7\n\(also in the picture, read less surely: necessary\)\n$/);
  // the record of it: which message, the level, the words counted, the time of each; never the words
  const ev = recent({ kind: 'event', category: 'attachments', limit: 1 })[0];
  assert.equal(ev.summary, 'read a picture: by the model (this machine was sure to 22 of 100)');
  assert.deepEqual(
    { id: ev.data.id, file: ev.data.file, level: ev.data.level, by: ev.data.by, score: ev.data.score, words: ev.data.words },
    { id: p, file: 'picture', level: 60, by: 'both', score: 22, words: 2 },
  );
  assert.doesNotMatch(JSON.stringify(ev), /necessary|Week 7/);
  // one whose file is gone is recorded too
  const gone = picture({ text: 'x', score: 90 });
  fs.rmSync(path.join(MEDIA_DIR, gone), { recursive: true });
  await readNow();
  const lost = recent({ kind: 'event', category: 'attachments', limit: 1 })[0];
  assert.equal(lost.summary, 'a picture could not be fetched');
  assert.equal(lost.ok, true, 'a file that is gone is no failure of anything here');
  assert.match(lost.data.gone, /./);

  // looking back over all of it
  const st = JSON.parse(bc('msg', 'reading', '--stats', '--since', '1d', '--json').stdout);
  assert.equal(st.level, 60);
  const pics = st.pictures;
  assert.equal(pics.empty, 1, 'the photo');
  assert.ok(pics.local >= 4 && pics.model >= 3, JSON.stringify(pics));
  assert.equal(pics.gone, 1);
  assert.equal(pics.failed, 1, 'the broken one, still to be tried again');
  assert.equal(pics.scores.lowest, 22);
  assert.equal(
    pics.bands.reduce((a, b) => a + b.n, 0),
    pics.local + pics.model - 1,
    'the bands hold every one this machine scored (not the one only the model read)',
  );
  const at = Object.fromEntries(pics.atLevel.map((a) => [a.level, a.model]));
  assert.ok(at[40] <= at[60] && at[60] <= at[90], 'a higher level gives the model more');
  const words = bc('msg', 'reading', '--stats').stdout;
  assert.match(words, /^Pictures, the last 7 days: \d+ pictures dealt with\n {2}no text in them +1\n/);
  assert.match(words, /given to the model +\d+/);
  assert.match(words, /The level is 60\. What another would have given the model: 40 → \d+ · 50 → \d+ · 60 → \d+/);
  assert.match(words, /Voice notes, the last 7 days: none\n$/);
  assert.notEqual(bc('msg', 'reading', '--stats', '--since', 'whenever').status, 0);
});

test('a file that cannot be fetched just now (no network) is tried again later, not counted as gone', async () => {
  const { recent } = await import('../src/activity/log.js');
  // A picture still to be downloaded, from a server that does not answer
  const id = `P${n + 1}`;
  const r = wa
    .prepare(
      "INSERT INTO messages (chat_ref, id, sender_ref, from_me, ts, type, text) VALUES ('wa:111@s.whatsapp.net', ?, 'wa:111@s.whatsapp.net', 0, ?, 'image', NULL)",
    )
    .run(id, at());
  wa.prepare(
    "INSERT INTO media (msg_rowid, dl_type, mimetype, media_key, url) VALUES (?, 'image', 'image/jpeg', ?, 'https://127.0.0.1:9/x')",
  ).run(r.lastInsertRowid, Buffer.alloc(32, 1));
  assert.deepEqual(await readNow(), { done: 0, failed: 1, left: 0 });
  const ev = recent({ kind: 'event', category: 'attachments', limit: 1 })[0];
  assert.equal(ev.summary, 'a picture could not be fetched just now');
  assert.equal(ev.data.gone, undefined);
  assert.equal(note(id), null, 'not given up on');
  // Later, when it can be had, it is read
  withDb(openNotesDb, (d) => d.prepare('UPDATE attachment_notes SET created_ts = created_ts - 3600 WHERE msg_id = ?').run(id));
  fs.mkdirSync(path.join(MEDIA_DIR, id), { recursive: true });
  fs.writeFileSync(path.join(MEDIA_DIR, id, 'image.jpg'), JSON.stringify({ text: 'the parking ticket', score: 90 }));
  assert.deepEqual(await readNow(), { done: 1, failed: 0, left: 0 });
  assert.equal(note(id).status, 'ok');
});
