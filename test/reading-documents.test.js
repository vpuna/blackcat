// A document that arrives in a collected chat is read when it arrives: its text is taken
// out on this machine; a page that is a picture is read as pictures are, against the level
// set for documents; and when the whole is longer than a reader of the message can be shown,
// the model writes a note of it. The whole text is kept for searching.
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

// Stand-ins, as plugins of the owner's own. A "document" here is a small JSON file saying
// what its parts are; a part that is a picture carries what a reading of that picture comes to.
fs.mkdirSync(path.join(dir, 'user-plugins/pages'), { recursive: true });
fs.writeFileSync(
  path.join(dir, 'user-plugins/pages/plugin.js'),
  `import fs from 'node:fs';
import path from 'node:path';
export default {
  api: 1, name: 'pages', title: 'Pages', description: 'reads documents and pictures, for the tests',
  commands: { hello: { summary: 'says hello', access: 'allow', run: () => 'hello' } },
  fileReaders: [
    {
      kind: 'documents',
      read: async (_ctx, { file, tmp, name }) => {
        const is = fs.readFileSync(file, 'utf8');
        fs.appendFileSync(process.env.BLACKCAT_HOME + '/opened.log', name + '\\n');
        if (is === 'BROKEN') return { error: 'the document could not be opened' };
        const doc = JSON.parse(is);
        return { ...doc, parts: doc.parts.map((p, i) => {
          if (!p.picture) return p;
          const f = path.join(tmp, 'p' + i + '.png');
          fs.writeFileSync(f, JSON.stringify(p.picture));
          return { ...p, picture: f };
        }) };
      },
    },
    { kind: 'pictures', read: async (_ctx, { file }) => JSON.parse(fs.readFileSync(file, 'utf8')) },
  ],
};
`,
);
await setUp({ bot: { allow: [{ id: 42, name: 'me' }] }, plugins: { enabled: ['pages'], disabled: ['voice', 'ocr', 'docs'] } });
const { load, save } = await import('../src/config.js');
const nowS = Math.floor(Date.now() / 1000);
save({
  ...load(),
  archive: { reading: { documents: { mode: 'both', since: nowS - 3600 }, pictures: { mode: 'both', since: nowS - 3600 } } },
});
const { openWrite } = await import('../src/archive/db.js');
const { MEDIA_DIR } = await import('../src/archive/files.js');
const { openWatchDb, addWatch, getWatch } = await import('../src/watch/db.js');
const { collect } = await import('../src/watch/collect.js');
const { loadPlugins } = await import('../src/plugins/registry.js');
await loadPlugins();

const wa = openWrite();
wa.prepare("INSERT INTO chats (ref, name, is_group) VALUES ('111@s.whatsapp.net', 'Maya', 0)").run();
let n = 0;
// A document: its row, and the file as if it had been fetched already.
const document = (doc, { name = 'notice.pdf', mimetype = 'application/pdf', caption = null } = {}) => {
  const id = `D${++n}`;
  const r = wa
    .prepare(
      "INSERT INTO messages (chat_ref, id, sender_ref, from_me, ts, type, text) VALUES ('111@s.whatsapp.net', ?, '111@s.whatsapp.net', 0, ?, 'document', ?)",
    )
    .run(id, nowS - 300 + n, caption);
  wa.prepare("INSERT INTO media (msg_rowid, dl_type, mimetype, file_name) VALUES (?, 'document', ?, ?)").run(
    r.lastInsertRowid,
    mimetype,
    name,
  );
  fs.mkdirSync(path.join(MEDIA_DIR, id), { recursive: true });
  fs.writeFileSync(path.join(MEDIA_DIR, id, name), typeof doc === 'string' ? doc : JSON.stringify(doc));
  return id;
};
const db = openWatchDb();
const watch = addWatch(db, {
  chatId: 42,
  name: 'From Maya',
  lookFor: 'plans',
  sources: { chats: [{ ref: '111@s.whatsapp.net', name: 'Maya' }] },
  mode: 'briefing',
});
const look = () => collect(db, getWatch(db, watch.id));
const { readNow } = await import('../src/archive/reading.js');
const { openNotesDb } = await import('../src/archive/attachments.js');
const { withDb } = await import('../src/db.js');
const { recent } = await import('../src/activity/log.js');
const kept = (id) =>
  withDb(openNotesDb, (d) => d.prepare('SELECT status, note, by, score, kind, level FROM attachment_notes WHERE msg_id = ?').get(id));
const whole = (id) => wa.prepare('SELECT heard FROM messages WHERE id = ?').pluck().get(id);
const asks = () => (fs.existsSync(asked) ? calls().length : 0);
const lineFor = (id) =>
  calls()
    .at(-1)
    .input.split('\n')
    .find((l) => l.startsWith(`[${id}]`));
const text = (...a) => bc('msg', 'reading', ...a).stdout;
const lastEvent = () => recent({ kind: 'event', category: 'attachments', limit: 1 })[0];

test('a short document has its text taken out on this machine; a search finds it and a watch reads it, with no model', async () => {
  const d = document(
    { parts: [{ label: null, text: 'Parents evening is on Thursday 22 October at 17:00 in the main hall.' }] },
    { name: 'evening.pdf' },
  );
  const before = asks();
  const tally = {};
  assert.deepEqual(await readNow({ tally }), { done: 1, failed: 0, left: 0 });
  assert.deepEqual(tally, { documents: { done: 1, failed: 0 } });
  assert.equal(asks(), before);
  assert.deepEqual(kept(d), {
    status: 'ok',
    note: '(a document, its text taken out by a machine) Parents evening is on Thursday 22 October at 17:00 in the main hall.',
    by: 'local',
    score: null,
    kind: 'documents',
    level: 90,
  });
  assert.equal(whole(d), 'Parents evening is on Thursday 22 October at 17:00 in the main hall.');
  assert.match(bc('msg', 'search', 'Parents evening').stdout, /\[document[^\]]*\] 📄 “«Parents» «evening» is on Thursday/);
  queue({ data: { items: [] } });
  await look();
  assert.match(
    lineFor(d),
    /\(no text\) \| attachment: document "evening\.pdf", which says: \(a document, its text taken out by a machine\) Parents evening is on Thursday 22 October/,
  );
  assert.equal(lastEvent().summary, 'read a document: on this machine');
  assert.deepEqual([lastEvent().data.id, lastEvent().data.file, lastEvent().data.pictures], [d, 'document', 0]);
  assert.doesNotMatch(JSON.stringify(lastEvent()), /Parents/, 'the record never holds the words');
});

test('a page that is a picture is read as pictures are, against the level for documents; under it, the model reads that page', async () => {
  // sure enough of the scanned page (95, the level being 90): no model
  const sure = document({
    parts: [
      { label: 'page 1', text: 'Week ahead: maths, factors and multiples.' },
      { label: 'page 2', text: '', picture: { text: 'Clubs timetable\nChess on Tuesday', extra: [], score: 95 }, whole: true },
    ],
    pages: 2,
  });
  const before = asks();
  await readNow();
  assert.equal(asks(), before);
  assert.equal(whole(sure), '[page 1]\nWeek ahead: maths, factors and multiples.\n\n[page 2]\nClubs timetable\nChess on Tuesday');
  assert.deepEqual([kept(sure).by, kept(sure).score], ['local', 95]);
  // a spelling list as a page: 86, under 90, so the model is given that page (and only that)
  const list = document({
    parts: [
      { label: 'page 1', text: 'Week ahead: science assessment.' },
      { label: 'page 2', text: '', picture: { text: 'Statutory words\nLmmediate harass', extra: [], score: 86 }, whole: true },
    ],
    pages: 2,
  });
  queue({ text: 'Week 6 spelling list: immediate, harass, profession.' });
  await readNow();
  assert.equal(asks(), before + 1);
  assert.equal(calls().at(-1).input[0].type, 'image');
  assert.equal(
    whole(list),
    '[page 1]\nWeek ahead: science assessment.\n\n[page 2]\n(a picture, as a model read it) Week 6 spelling list: immediate, harass, profession.',
  );
  assert.deepEqual([kept(list).by, kept(list).score], ['both', 86]);
  assert.equal(lastEvent().summary, 'read a document: on this machine, with the model for 1 of its 1 picture');
  // moved down, the same page is kept as this machine read it
  assert.match(text('--document-level', '80'), /one read less surely than 80 of 100 is given to the model/);
  const again = document({ parts: [{ label: null, text: '', picture: { text: 'Lmmediate harass', extra: [], score: 86 }, whole: true }] });
  await readNow();
  assert.equal(asks(), before + 1);
  assert.equal(whole(again), 'Lmmediate harass');
  text('--document-level', '90');
});

test('a page with text and a large picture: the text is taken as it is, and only what the picture adds is put after it', async () => {
  const d = document({
    parts: [
      {
        label: null,
        text: 'Spelling test on Friday. Learn the words in the box.',
        picture: {
          text: 'Spelling test on Friday. Learn the words in the box.\nexaggerate occur correspond',
          extra: ['interrupt'],
          score: 93,
        },
        whole: true,
      },
    ],
  });
  await readNow();
  assert.equal(
    whole(d),
    'Spelling test on Friday. Learn the words in the box.\n(also on this page, in a picture: exaggerate occur correspond interrupt)',
  );
});

test('the pictures in a document are read where they stand: text, the picture there, the text after it', async () => {
  const d = document(
    {
      parts: [
        { label: null, text: 'Dear parents, the timetable for the trip is below.' },
        { label: 'a picture in the document', text: '', picture: { text: 'Coach leaves 08:30\nBack by 16:00', extra: [], score: 96 } },
        { label: null, text: 'Please sign and return the slip.' },
        { label: 'a picture in the document', text: '', picture: { text: 'Bring: lunch, water', extra: [], score: 94 } },
        { label: null, text: 'Thank you.' },
      ],
    },
    { name: 'trip.docx', mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  );
  // an old Word file is a document like the others
  const old = document(
    { parts: [{ label: null, text: 'Minutes of the meeting of 3 October.' }] },
    { name: 'minutes.doc', mimetype: 'application/msword' },
  );
  assert.deepEqual(await readNow(), { done: 2, failed: 0, left: 0 });
  assert.equal(
    whole(d),
    'Dear parents, the timetable for the trip is below.\n\n[a picture in the document]\nCoach leaves 08:30\nBack by 16:00\n\nPlease sign and return the slip.\n\n[a picture in the document]\nBring: lunch, water\n\nThank you.',
  );
  assert.equal(whole(old), 'Minutes of the meeting of 3 October.');
  assert.match(bc('msg', 'search', 'Minutes').stdout, /📄/);
});

test('a document longer than can be shown is noted by the model for whoever reads the message; the whole text is kept for searching', async () => {
  const long = Array.from(
    { length: 60 },
    (_, i) => `Item ${i + 1}: the club meets in room ${100 + i} on the first Monday of the month.`,
  ).join('\n');
  const d = document({ parts: [{ label: null, text: `${long}\nThe very last line mentions a pineapple.` }] }, { name: 'handbook.pdf' });
  queue({ text: 'Club handbook: 60 clubs, each meeting on the first Monday of the month, rooms 100 to 159.' });
  const before = asks();
  await readNow();
  assert.equal(asks(), before + 1);
  assert.match(calls().at(-1).input, /The attachment's text:\nItem 1: the club meets/, 'the text was given to it, not the file');
  assert.equal(
    kept(d).note,
    '(a document, as a model noted what it says) Club handbook: 60 clubs, each meeting on the first Monday of the month, rooms 100 to 159.',
  );
  assert.equal(kept(d).by, 'both');
  assert.match(whole(d), /pineapple\.$/);
  assert.match(bc('msg', 'search', 'pineapple').stdout, /📄/);
  assert.equal(lastEvent().summary, 'read a document: on this machine, and a note of it by the model');
  queue({ data: { items: [] } });
  await look();
  assert.match(lineFor(d), /attachment: document "handbook\.pdf", which says: \(a document, as a model noted what it says\) Club handbook/);
  // on this machine only: the beginning, and it says that it was cut
  assert.match(text('--documents', 'local'), /^Documents: their text is taken out as they arrive, on this machine only\./m);
  const local = document({ parts: [{ label: null, text: long }] });
  await readNow();
  assert.equal(asks(), before + 2, 'only the watch asked: no model for the document');
  assert.match(
    kept(local).note,
    /^\(a document, its text taken out by a machine\) Item 1: [\s\S]+\n\(the document goes on from here: a search covers all of it\)$/,
  );
  assert.ok(kept(local).note.length <= 2500);
  text('--documents', 'both');
});

test('by the model only, the file is given to it whole; with nothing in it, or not to be opened, it is said so', async () => {
  assert.match(text('--documents', 'model'), /^Documents: every one is given to the model whole\./m);
  const opened = () =>
    fs.existsSync(path.join(dir, 'opened.log')) ? fs.readFileSync(path.join(dir, 'opened.log'), 'utf8').trim().split('\n').length : 0;
  const was = opened();
  const d = document('%PDF-1.4 as it came', { name: 'ticket.pdf' });
  queue({ text: 'A ticket for the concert on Friday at 20:00, row 4 seat 12.' });
  await readNow();
  assert.equal(opened(), was, 'this machine did not open it');
  assert.equal(calls().at(-1).input[0].type, 'document');
  assert.deepEqual(
    [kept(d).by, kept(d).note],
    ['model', '(a document, as a model read it) A ticket for the concert on Friday at 20:00, row 4 seat 12.'],
  );
  text('--documents', 'both');
  const empty = document({ parts: [] });
  const broken = document('BROKEN');
  assert.deepEqual(await readNow(), { done: 1, failed: 1, left: 0 });
  assert.deepEqual([kept(empty).status, kept(empty).note], ['empty', 'there is no text in it']);
  assert.equal(kept(broken).status, 'error');
  queue({ data: { items: [] } });
  const before = asks();
  await look();
  assert.equal(lineFor(empty), undefined, 'an empty one is passed over');
  assert.ok(asks() >= before);
  // switched off: nothing is read
  assert.match(text('--documents', 'off'), /^Documents: not read \(switched off\)/m);
  const off = document({ parts: [{ label: null, text: 'not to be read' }] });
  await readNow();
  assert.equal(kept(off), undefined);
  text('--documents', 'both');
});

test('looking back counts documents too, and the one page of settings sets all three kinds', async () => {
  const st = JSON.parse(bc('msg', 'reading', '--stats', '--since', '1d', '--json').stdout);
  assert.ok(st.documents.local >= 3 && st.documents.model >= 3, JSON.stringify(st.documents));
  assert.equal(st.documents.empty, 1);
  assert.match(
    bc('msg', 'reading', '--stats').stdout,
    /^Documents, the last 7 days: \d+ documents dealt with: \d+ read on this machine alone, \d+ with the model/m,
  );
  const set = bc('msg', 'setup', '--voice', 'off', '--pictures', 'local', '--documents', 'both', '--document-level', '85');
  assert.equal(set.status, 0, set.said);
  assert.match(set.stdout, /^Voice notes: not read\. Pictures: this machine only\. Documents: this machine first, the model when unsure\./);
  const r = load().archive.reading;
  assert.deepEqual([r.voice.mode, r.pictures.mode, r.documents.mode, r.documents.level], ['off', 'local', 'both', 85]);
  // one given without the others leaves them as they are
  bc('msg', 'setup', '--pictures', 'both');
  assert.deepEqual(
    [load().archive.reading.voice.mode, load().archive.reading.pictures.mode, load().archive.reading.documents.level],
    ['off', 'both', 85],
  );
  assert.notEqual(bc('msg', 'setup', '--documents', 'sometimes').status, 0);
  assert.notEqual(bc('msg', 'setup', '--document-level', '900').status, 0);
});
