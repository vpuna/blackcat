// A voice note in a watched chat is listened to on this machine, by whichever plugin can,
// and its words are judged like any other message. A message with no words is shown as
// what it was where it is background.
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
  const next = queue.shift() ?? { data: { items: [], groups: [] } };
  fs.writeFileSync(${JSON.stringify(answers)}, JSON.stringify(queue));
  const want = JSON.parse(after('--json-schema') ?? '{}').required ?? [];
  const data = Object.fromEntries(Object.entries(next.data).filter(([k]) => want.includes(k)));
  // ("__PID__" in an answer becomes this process's own number, so two readers asked at once answer differently.)
  console.log(JSON.stringify({ type: 'result', is_error: false, result: '', structured_output: data }).replace(/__PID__/g, String(process.pid)));
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

// Something to listen with, as a plugin of the owner's own: it "hears" what the file holds.
fs.mkdirSync(path.join(dir, 'user-plugins/ears'), { recursive: true });
fs.writeFileSync(
  path.join(dir, 'user-plugins/ears/plugin.js'),
  `import fs from 'node:fs';
export default {
  api: 1, name: 'ears', title: 'Ears', description: 'listens, for the tests',
  commands: { hello: { summary: 'says hello', access: 'allow', run: () => 'hello' } },
  fileReaders: [{
    kind: 'voice',
    read: async (_ctx, { file }) => {
      const said = fs.readFileSync(file, 'utf8');
      fs.appendFileSync(process.env.BLACKCAT_HOME + '/heard.log', file + '\\n');
      if (said.startsWith('SURE ')) return { text: said.slice(5), seconds: 7, took: 1, model: 'test', score: 73.4 };
      return said === 'BROKEN' ? { error: 'the audio could not be read' } : { text: said === 'SILENCE' ? '' : said, seconds: 7, took: 1, model: 'test' };
    },
    stop: async () => fs.appendFileSync(process.env.BLACKCAT_HOME + '/heard.log', 'stopped\\n'),
  }],
};
`,
);
await setUp({ bot: { allow: [{ id: 42, name: 'me' }] }, plugins: { enabled: ['ears'], disabled: ['voice', 'ocr', 'docs'] } });
const { openWrite } = await import('../src/archive/db.js');
const { MEDIA_DIR } = await import('../src/archive/files.js');
const { openWatchDb, addWatch, getWatch, listItems, updateWatch } = await import('../src/watch/db.js');
const { collect } = await import('../src/watch/collect.js');
const { loadPlugins } = await import('../src/plugins/registry.js');
await loadPlugins();
const heard = () =>
  fs.existsSync(path.join(dir, 'heard.log')) ? fs.readFileSync(path.join(dir, 'heard.log'), 'utf8').trim().split('\n') : [];

const wa = openWrite();
wa.prepare("INSERT INTO chats (ref, name, is_group) VALUES ('111@s.whatsapp.net', 'Maya', 0)").run();
let n = 0;
const at = () => Math.floor(Date.now() / 1000) - 300 + ++n;
const say = (text, fromMe = 0) => {
  const id = `V${n + 1}`;
  wa.prepare(
    "INSERT INTO messages (chat_ref, id, sender_ref, from_me, ts, type, text) VALUES ('111@s.whatsapp.net', ?, '111@s.whatsapp.net', ?, ?, 'text', ?)",
  ).run(id, fromMe, at(), text);
  return id;
};
// A message that is a file: its row, and the file as if it had been fetched already.
const send = (type, dlType, mimetype, content, { seconds = 7 } = {}) => {
  const id = `V${n + 1}`;
  const r = wa
    .prepare(
      "INSERT INTO messages (chat_ref, id, sender_ref, from_me, ts, type, text) VALUES ('111@s.whatsapp.net', ?, '111@s.whatsapp.net', 0, ?, ?, NULL)",
    )
    .run(id, at(), type);
  wa.prepare('INSERT INTO media (msg_rowid, dl_type, mimetype, seconds) VALUES (?, ?, ?, ?)').run(
    r.lastInsertRowid,
    dlType,
    mimetype,
    seconds,
  );
  if (content != null) {
    fs.mkdirSync(path.join(MEDIA_DIR, id), { recursive: true });
    fs.writeFileSync(path.join(MEDIA_DIR, id, `${type}.bin`), content);
  }
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
// Voice notes are written down as they arrive, by a job of the archive's: here, when the test says.
const { readNow } = await import('../src/archive/reading.js');
const lineFor = (id) =>
  calls()
    .at(-1)
    .input.split('\n')
    .find((l) => l.startsWith(`[${id}]`));
const item = (id, title) => ({ message_id: id, title, category: 'plan', summary: 'she said so', confidence: 0.9 });

test('a voice note is listened to when it arrives, and a watch reads what was heard as the message; the helper is let go afterwards', async () => {
  const v = send('voice', 'ptt', 'audio/ogg; codecs=opus', 'lets talk to him tonight about the school trip');
  // a look that comes before it has been listened to leaves it for the next: no watch listens itself
  const early = await look();
  assert.deepEqual([early.looked, early.added.length, heard().length], [0, 0, 0]);
  assert.deepEqual(await readNow(), { done: 1, failed: 0, left: 0 });
  queue({ data: { items: [item(v, 'Talk to him about the school trip tonight')] } });
  const r = await look();
  assert.equal(r.added.length, 1, JSON.stringify(r));
  assert.match(
    lineFor(v),
    /in Maya: \(no text\) \| attachment: voice note, which says: \(7 s of speech, written down by a machine: a word or a name may be wrong\) lets talk to him tonight about the school trip$/,
  );
  assert.deepEqual(
    heard().map((l) => path.basename(l)),
    ['voice.bin', 'stopped'],
  );
  assert.equal(listItems(db, watch.id)[0].title, 'Talk to him about the school trip tonight');
  // listened to once: its words are kept, and another look does not listen again
  const { noteFor, openNotesDb } = await import('../src/archive/attachments.js');
  const notes = openNotesDb();
  assert.equal(noteFor(notes, v).status, 'ok');
  notes.close();
  // the record says that something was listened to, and for how long: never the words
  const { recent: read } = await import('../src/activity/log.js');
  const ev = read({ kind: 'event', category: 'attachments', limit: 10 });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].summary, 'listened to 7 s of audio');
  assert.doesNotMatch(JSON.stringify(ev), /school trip/);
});

test('what was said is kept with the message: a search finds it, and the chat shows it', async () => {
  const found = bc('msg', 'search', 'school trip');
  assert.match(found.stdout, /\[voice[^\]]*\] 🎙 “lets talk to him tonight about the «school» «trip»”/, found.said);
  const json = JSON.parse(bc('msg', 'search', 'school trip', '--json').stdout);
  const hit = (json.messages ?? json.results ?? json).find((m) => m.heard);
  assert.equal(hit.heard, 'lets talk to him tonight about the school trip');
  assert.equal(hit.text ?? null, null, 'its text is still what was typed: nothing');
  assert.match(bc('msg', 'thread', 'Maya').stdout, /\[voice[^\]]*\] 🎙 “lets talk to him tonight about the school trip”/);
  // one that has not been listened to says nothing
  assert.doesNotMatch(bc('msg', 'search', 'lecture').said, /🎙/);
});

test('where a message is background, one with no words is shown as what it was, a voice note with what was heard', async () => {
  send('image', 'image', 'image/jpeg', null);
  send('video', 'video', 'video/mp4', null);
  const m = say('what do you think of this?');
  queue({ data: { items: [] } });
  await look();
  assert.match(
    lineFor(m),
    /what do you think of this\? \| said just before: \S+: \(a voice note: lets talk to him tonight about the school trip\) \/ \S+: \(a picture\) \/ \S+: \(a video\)$/,
  );
  // neither the picture nor the video is a message of its own: this watch does not read attachments
  assert.equal(
    calls()
      .at(-1)
      .input.split('\n')
      .filter((l) => /^\[V\d+\]/.test(l)).length,
    1,
  );
});

test('one that is too long, silent or cannot be read is not listened to twice over, and says why', async () => {
  const before = heard().length;
  const long = send('audio', 'audio', 'audio/mpeg', 'a lecture', { seconds: 1200 });
  const silent = send('voice', 'ptt', 'audio/ogg', 'SILENCE');
  const m = say('see you at 8');
  assert.deepEqual(await readNow(), { done: 0, failed: 2, left: 0 });
  assert.deepEqual(await readNow(), { done: 0, failed: 0, left: 0 }, 'neither is tried again');
  queue({ data: { items: [] } });
  await look();
  const shown = calls().at(-1).input;
  assert.match(
    shown,
    new RegExp(`\\[${long}\\] .*\\(no text\\) .*\\| attachment: audio \\(not read: it is 20 minutes long, too long to listen to\\)`),
  );
  assert.match(shown, new RegExp(`\\[${silent}\\] .*attachment: voice note \\(not read: no words could be made out\\)`));
  assert.match(shown, new RegExp(`\\[${m}\\] .*see you at 8`));
  // the long one was never given to the listener
  assert.deepEqual(
    heard()
      .slice(before)
      .map((l) => path.basename(l)),
    ['voice.bin', 'stopped'],
  );
  // one the listener could not read this time waits for a later look; what came after it is read now
  const broken = send('voice', 'ptt', 'audio/ogg', 'BROKEN');
  const later = say('and bring the tickets');
  assert.deepEqual(await readNow(), { done: 0, failed: 1, left: 0 });
  queue({ data: { items: [] } });
  await look();
  assert.ok(lineFor(later), 'the message after it is not held up');
  assert.equal(lineFor(broken), undefined, 'and it is not read without its words');
  fs.writeFileSync(path.join(MEDIA_DIR, broken, 'voice.bin'), 'the gate code is the usual one');
  // it is not tried again straight away (a few minutes without a network must not use up its tries), but later
  assert.deepEqual(await readNow(), { done: 0, failed: 0, left: 0 });
  const notesDb = (await import('../src/archive/attachments.js')).openNotesDb();
  notesDb.prepare('UPDATE attachment_notes SET created_ts = created_ts - 900 WHERE msg_id = ?').run(broken);
  notesDb.close();
  assert.deepEqual(await readNow(), { done: 1, failed: 0, left: 0 });
  queue({ data: { items: [] } });
  await look();
  assert.match(lineFor(broken), /which says: \(7 s of speech[^)]*\) the gate code is the usual one$/);
  assert.equal(lineFor(later), undefined, 'what was read before is not read again');
});

test('it can be switched off for a watch, and is off where nothing can listen', async () => {
  const text = (...a) => bc('watch', ...a).said;
  assert.doesNotMatch(text('show', String(watch.id)), /voice notes/);
  assert.match(text('edit', String(watch.id), '--no-voice-notes'), /does not listen to voice notes/);
  assert.equal(getWatch(db, watch.id).sources.voice, false);
  // (the voice note is still written down, for searching and for other watches: this one does not read it)
  const off = send('voice', 'ptt', 'audio/ogg', 'not for the list');
  const m = say('ok then');
  assert.equal((await readNow()).done, 1);
  queue({ data: { items: [] } });
  await look();
  assert.equal(lineFor(off), undefined);
  assert.match(lineFor(m), /ok then \| said just before: .*: \(a voice note\)$/);
  assert.match(bc('msg', 'search', 'not for the list').stdout, /🎙/);
  // on again: only "off" is written down
  bc('watch', 'edit', String(watch.id), '--voice-notes');
  assert.equal('voice' in getWatch(db, watch.id).sources, false);
  // a watch made with it off
  assert.match(text('add', 'Quiet', '--look-for', 'plans', '--chat', 'Maya', '--no-voice-notes'), /does not listen to voice notes/);
  // links only: a voice note has no link
  updateWatch(db, watch.id, { sources: { ...getWatch(db, watch.id).sources, linksOnly: true } });
  const asks = calls().length;
  send('voice', 'ptt', 'audio/ogg', 'nothing with a link');
  await readNow();
  await look();
  assert.equal(calls().length, asks);
  updateWatch(db, watch.id, { sources: { ...getWatch(db, watch.id).sources, linksOnly: false } });
});

test('listening can be switched off altogether: nothing is written down, and watches read voice notes as wordless', async () => {
  const text = (...a) => bc('msg', 'reading', ...a).stdout;
  // (The model that reads here cannot take audio: "both" is this machine, and what it heard stands.)
  assert.match(
    text(),
    /^Voice notes: listened to as they arrive, on this machine \(the model in use cannot take audio, so one that was hard to make out stays as it was heard\)\. None is waiting\./,
  );
  const quiet = send('voice', 'ptt', 'audio/ogg', 'said while it was off');
  assert.match(text(), /1 waiting\./);
  assert.match(text('--voice', 'off'), /Voice notes: not read \(switched off\)\. Switch it on: bc msg reading --voice both/);
  assert.deepEqual(await readNow(), { off: true });
  const m = say('did you get that?');
  queue({ data: { items: [] } });
  await look();
  assert.equal(lineFor(quiet), undefined);
  assert.match(lineFor(m), /did you get that\? \| said just before: .*\(a voice note\)$/);
  // on again, and told to listen now rather than at the next minute
  assert.match(
    text('--voice', 'local', '--now'),
    /^Listened to 1 voice note\.\nVoice notes: listened to as they arrive, on this machine\. None is waiting\.$/m,
  );
  // by the model only: it cannot take audio, so nothing listens, and that is said
  const later = send('voice', 'ptt', 'audio/ogg', 'said while only the model was asked');
  assert.match(text('--voice', 'model'), /set to be read by the model, but the model in use cannot take audio, so they are not read/);
  assert.deepEqual(await readNow(), { off: true });
  assert.notEqual(bc('msg', 'reading', '--voice', 'sometimes').status, 0, 'not a mode');
  assert.match(text('--voice', 'both', '--now'), /^Listened to 1 voice note\./);
  // how one was read
  assert.match(
    text('--show', later),
    new RegExp(
      `^${later}: read · on this machine · [\\d.]+ s here\\n\\(7 s of speech, written down by a machine: a word or a name may be wrong\\) said while only the model was asked`,
    ),
  );
  assert.match(text('--show', 'NOSUCH'), /Nothing has been read for NOSUCH/);
  assert.match(bc('msg', 'search', 'said while it was off').stdout, /🎙/);
  // the job that does it every minute says what it did, and nothing when there was nothing
  send('voice', 'ptt', 'audio/ogg', 'one for the job');
  const job = bc('plugin', 'job', 'msg', 'read');
  assert.equal(job.status, 0, job.said);
  const { recent } = await import('../src/activity/log.js');
  assert.equal(recent({ kind: 'job', category: 'msg/read', limit: 1 })[0].summary, 'listened to 1 voice note');
  assert.match(bc('msg', 'search', 'one for the job').stdout, /🎙/);
});

test('a voice note that was forwarded is the same recording: it is listened to once, and both messages have its words', async () => {
  const first = send('voice', 'ptt', 'audio/ogg', 'the plumber is coming on friday at ten');
  const again = send('audio', 'audio', 'audio/ogg', 'the plumber is coming on friday at ten');
  wa.prepare("UPDATE media SET file_sha256 = x'AB12CD' WHERE msg_rowid IN (SELECT rowid FROM messages WHERE id IN (?, ?))").run(
    first,
    again,
  );
  const before = heard().filter((l) => !l.endsWith('stopped')).length;
  assert.deepEqual(await readNow(), { done: 2, failed: 0, left: 0 });
  assert.equal(heard().filter((l) => !l.endsWith('stopped')).length, before + 1, 'the listener was given one of them');
  assert.deepEqual(wa.prepare('SELECT heard FROM messages WHERE id IN (?, ?)').pluck().all(first, again), [
    'the plumber is coming on friday at ten',
    'the plumber is coming on friday at ten',
  ]);
});

test('what a scheduled job logs goes beside its answer, never into it (a helper starting up must not spoil the answer)', () => {
  const run = (env) =>
    spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `import { log } from '${root}src/log.js'; log('helper started'); console.log('{"watches":[]}');`],
      {
        encoding: 'utf8',
        env: { ...plain(), ...env },
      },
    );
  const job = run({ BLACKCAT_JOB: '1' });
  assert.deepEqual(JSON.parse(job.stdout), { watches: [] });
  assert.match(job.stderr, /helper started/);
  // a service's own log is what it prints
  assert.match(run({}).stdout, /helper started/);
});

test('how sure the listening was is kept with the note, when what listens says so', async () => {
  const { openNotesDb } = await import('../src/archive/attachments.js');
  const { withDb } = await import('../src/db.js');
  const { recent } = await import('../src/activity/log.js');
  const scored = send('voice', 'ptt', 'audio/ogg', 'SURE the keys are under the mat');
  const plain = send('voice', 'ptt', 'audio/ogg', 'nothing is said of this one');
  await readNow();
  const row = (id) => withDb(openNotesDb, (d) => d.prepare('SELECT kind, by, score FROM attachment_notes WHERE msg_id = ?').get(id));
  assert.deepEqual(row(scored), { kind: 'voice', by: 'local', score: 73 });
  assert.deepEqual(row(plain), { kind: 'voice', by: 'local', score: null }, 'none given: none kept');
  const ev = recent({ kind: 'event', category: 'attachments', limit: 5 }).find((e) => e.data.id === scored);
  assert.deepEqual([ev.data.file, ev.data.score], ['voice', 73]);
  assert.match(bc('msg', 'reading', '--show', scored).stdout, /read · on this machine · this machine was sure to 73 of 100/);
});
