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
  chat: {
    voice: async (file) => {
      const said = fs.readFileSync(file, 'utf8');
      fs.appendFileSync(process.env.BLACKCAT_HOME + '/heard.log', file + '\\n');
      return said === 'BROKEN' ? { error: 'the audio could not be read' } : { text: said === 'SILENCE' ? '' : said, seconds: 7, took: 1, model: 'test' };
    },
    stop: async () => fs.appendFileSync(process.env.BLACKCAT_HOME + '/heard.log', 'stopped\\n'),
  },
};
`,
);
await setUp({ bot: { allow: [{ id: 42, name: 'me' }] }, plugins: { enabled: ['ears'], disabled: ['voice'] } });
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
const lineFor = (id) =>
  calls()
    .at(-1)
    .input.split('\n')
    .find((l) => l.startsWith(`[${id}]`));
const item = (id, title) => ({ message_id: id, title, category: 'plan', summary: 'she said so', confidence: 0.9 });

test('a voice note is listened to, and what was heard is judged as the message; the helper is let go afterwards', async () => {
  const v = send('voice', 'ptt', 'audio/ogg; codecs=opus', 'lets talk to him tonight about the school trip');
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
  // one the listener could not read waits for the next look, with the messages after it
  const broken = send('voice', 'ptt', 'audio/ogg', 'BROKEN');
  const later = say('and bring the tickets');
  const asks = calls().length;
  await look();
  assert.equal(calls().length, asks, 'nothing was asked of the reader: the look stops at the one that may work next time');
  fs.writeFileSync(path.join(MEDIA_DIR, broken, 'voice.bin'), 'the gate code is the usual one');
  queue({ data: { items: [] } });
  await look();
  assert.match(lineFor(broken), /which says: \(7 s of speech[^)]*\) the gate code is the usual one$/);
  assert.ok(lineFor(later));
});

test('it can be switched off for a watch, and is off where nothing can listen', async () => {
  const text = (...a) => bc('watch', ...a).said;
  assert.doesNotMatch(text('show', String(watch.id)), /voice notes/);
  assert.match(text('edit', String(watch.id), '--no-voice-notes'), /does not listen to voice notes/);
  assert.equal(getWatch(db, watch.id).sources.voice, false);
  const before = heard().length;
  send('voice', 'ptt', 'audio/ogg', 'not for the list');
  const m = say('ok then');
  queue({ data: { items: [] } });
  await look();
  assert.equal(heard().length, before, 'not listened to');
  assert.match(lineFor(m), /ok then \| said just before: .*: \(a voice note\)$/);
  // on again: only "off" is written down
  bc('watch', 'edit', String(watch.id), '--voice-notes');
  assert.equal('voice' in getWatch(db, watch.id).sources, false);
  // a watch made with it off
  assert.match(text('add', 'Quiet', '--look-for', 'plans', '--chat', 'Maya', '--no-voice-notes'), /does not listen to voice notes/);
  // links only: a voice note has no link
  updateWatch(db, watch.id, { sources: { ...getWatch(db, watch.id).sources, linksOnly: true } });
  send('voice', 'ptt', 'audio/ogg', 'nothing with a link');
  await look();
  assert.equal(heard().length, before);
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
