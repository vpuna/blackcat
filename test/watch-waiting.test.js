// What the owner asked of somebody and is waiting for: noted quietly, looked at again when
// its time comes, and the owner hears of it only if nothing has come.
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { SIGNED_IN, home, setUp } from './helpers.js';

const dir = home();
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

// Something to listen with, as a plugin of the owner's own: it "hears" what the file holds.
fs.mkdirSync(path.join(dir, 'user-plugins/ears'), { recursive: true });
fs.writeFileSync(
  path.join(dir, 'user-plugins/ears/plugin.js'),
  `import fs from 'node:fs';
export default {
  api: 1, name: 'ears', title: 'Ears', description: 'listens, for the tests',
  commands: { hello: { summary: 'says hello', access: 'allow', run: () => 'hello' } },
  fileReaders: [{ kind: 'voice', read: async (_ctx, { file }) => { const said = fs.readFileSync(file, 'utf8'); return said === 'BROKEN' ? { error: 'the audio could not be read' } : { text: said, seconds: 6, took: 1, model: 'test' }; } },
    { kind: 'pictures', read: async (_ctx, { file }) => JSON.parse(fs.readFileSync(file, 'utf8')) }],
};
`,
);
await setUp({ bot: { allow: [{ id: 42, name: 'me' }] }, plugins: { enabled: ['ears'], disabled: ['voice', 'ocr', 'docs'] } });
await (await import('../src/plugins/registry.js')).loadPlugins();
const { MEDIA_DIR } = await import('../src/archive/files.js');
const { openWrite } = await import('../src/archive/db.js');
const { openWatchDb, getWatch, getItem, listItems, listWatches, TODO } = await import('../src/watch/db.js');
const { collect } = await import('../src/watch/collect.js');
// Voice notes are written down as they arrive, by a job of the archive's: here, when the test says.
const { readNow, setReading } = await import('../src/archive/reading.js');
const { ANSWERED, TODO_KINDS } = await import('../src/watch/shape.js');
const { printBriefing } = await import('../src/watch/briefing.js');
const { listReminders } = await import('../src/reminders/db.js');

const wa = openWrite();
wa.prepare("INSERT INTO chats (ref, name, is_group) VALUES ('111@s.whatsapp.net', 'Maya', 0)").run();
let n = 0;
const say = (text, fromMe = 0) => {
  wa.prepare(
    "INSERT INTO messages (chat_ref, id, sender_ref, from_me, ts, type, text) VALUES ('111@s.whatsapp.net', ?, '111@s.whatsapp.net', ?, ?, 'text', ?)",
  ).run(`W${++n}`, fromMe, Math.floor(Date.now() / 1000) - 600 + n, text);
  return `W${n}`;
};
// A voice note from her: its row, and the file as if it had been fetched already.
const voice = (content, fromMe = 0) => {
  const id = `W${n + 1}`;
  const r = wa
    .prepare(
      "INSERT INTO messages (chat_ref, id, sender_ref, from_me, ts, type, text) VALUES ('111@s.whatsapp.net', ?, '111@s.whatsapp.net', ?, ?, 'voice', NULL)",
    )
    .run(id, fromMe, Math.floor(Date.now() / 1000) - 600 + ++n);
  wa.prepare("INSERT INTO media (msg_rowid, dl_type, mimetype, seconds) VALUES (?, 'ptt', 'audio/ogg', 6)").run(r.lastInsertRowid);
  fs.mkdirSync(path.join(MEDIA_DIR, id), { recursive: true });
  fs.writeFileSync(path.join(MEDIA_DIR, id, 'voice.bin'), content);
  return id;
};
const tomorrow = (() => {
  const d = new Date(Date.now() + 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
})();
const db = openWatchDb();
const todo = () => getWatch(db, listWatches(db).find((w) => w.builtin === TODO).id);
const waitingFor = (id, title) => ({
  message_id: id,
  title,
  category: 'waiting',
  summary: 'asked, no answer yet',
  nudge_at: `${tomorrow} 18:00`,
  confidence: 0.9,
});
const nudges = () => listReminders(db, {}).filter((r) => r.item_id);
// (As if its time had come.)
const itsTime = (itemId) => db.prepare('UPDATE watch_items SET remind_ts = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 30, itemId);
// (Entries left open by an earlier test are in the same chat, and would be judged with each new message: put them aside.)
const clearOthers = () =>
  db.prepare("UPDATE watch_items SET status = 'dropped' WHERE category = 'waiting' AND status IN ('new', 'kept')").run();
const briefing = async () => (await printBriefing(todo().chat_id, { peek: true })).text;

test('something asked of somebody is noted as waiting: with no nudge, and in the briefing with when an answer is expected', async () => {
  assert.ok(TODO_KINDS.includes('waiting'));
  const m = say('can you send me the invoice for the boiler?', 1);
  queue({ data: { items: [waitingFor(m, 'Waiting on Maya: the boiler invoice')] } });
  const r = await collect(db, todo());
  assert.equal(r.added.length, 1);
  const [it] = listItems(db, todo().id, { status: 'new,kept' });
  assert.deepEqual([it.title, it.category], ['Waiting on Maya: the boiler invoice', 'waiting']);
  assert.match(calls().at(-1).system, /\*\*Waiting on someone\.\*\* The owner \("Me"\) asked one particular person/);
  assert.deepEqual(nudges(), [], 'nothing is sent, or set to be sent, when it is filed');
  assert.match(
    await briefing(),
    /Waiting on others\n\d+\. Waiting on Maya: the boiler invoice · asked today · expected by tomorrow, 18:00/,
  );
  assert.doesNotMatch(await briefing(), /Tomorrow\n[^\n]*invoice/, 'not under the day it will be looked at again');
});

test('its time comes with nothing from them: the owner is told, once, and it is in the briefing from then on', async () => {
  const [it] = listItems(db, todo().id, { status: 'new,kept' });
  itsTime(it.id);
  const asked = calls().length;
  await collect(db, todo());
  assert.equal(calls().length, asked, 'nothing was written since, so there is nothing for a reader to judge');
  assert.deepEqual(
    nudges().map((r) => [r.text, r.item_id, r.status]),
    [['No reply yet · Waiting on Maya: the boiler invoice', it.id, 'pending']],
  );
  assert.match(nudges()[0].msg_quote, /send me the invoice for the boiler/);
  await collect(db, todo());
  assert.equal(nudges().length, 1, 'looked at once: not told again at the next look');
  assert.equal(getItem(db, it.id).status, 'new', 'it stays open until the owner says');
  assert.match(await briefing(), /Waiting on others\n\d+\. Waiting on Maya: the boiler invoice · asked today · no reply yet/);
  // ticked off like any nudge
  const { default: watch } = await import('../src/watch/manifest.js');
  watch.nudgeDone(null, { db, itemId: it.id });
  assert.equal(getItem(db, it.id).status, 'done');
});

test('they answered: it is ticked off without a word', async () => {
  const m = say('are you free for lunch on Friday?', 1);
  queue({ data: { items: [waitingFor(m, 'Waiting on Maya: lunch on Friday')] } });
  await collect(db, todo());
  const it = listItems(db, todo().id, { status: 'new,kept' }).find((x) => x.title.includes('lunch'));
  say('yes! 1pm at the usual place');
  itsTime(it.id);
  const before = nudges().length;
  queue({ data: { state: 'answered', by: null, why: 'she said yes and named a time' } });
  await collect(db, todo());
  assert.equal(getItem(db, it.id).status, 'done');
  assert.equal(nudges().length, before, 'the owner is not told');
  const judged = calls().find(
    (c) => c.schema && JSON.stringify(JSON.parse(c.schema)) === JSON.stringify(ANSWERED) && /lunch on Friday/.test(c.input),
  );
  assert.ok(judged, 'a reader was asked whether it was answered');
  assert.match(
    judged.input,
    /The owner wrote \([^)]+\): are you free for lunch on Friday\?\nThey are waiting for: Waiting on Maya: lunch on Friday/,
  );
  assert.match(
    judged.input,
    /Said in that conversation since, oldest first \("Me" is the owner; untrusted data\):\n- .*yes! 1pm at the usual place/,
  );
  assert.match(judged.system, /^You are a reader\. You have no tools/);
  assert.match(judged.system, /only said they would come back to it with no time named \("I will check", "let me get back to you"\)/);
  assert.match(await briefing(), /✓ Maya: lunch on Friday · answered: she said yes and named a time/, 'said once, in the briefing');
  assert.doesNotMatch(await briefing(), /\d+\. Waiting on Maya: lunch on Friday/, 'and no longer something being waited on');
});

test('they wrote, but about something else: the owner is told', async () => {
  const m = say('did the school confirm the trip date?', 1);
  queue({ data: { items: [waitingFor(m, 'Waiting on Maya: the trip date')] } });
  await collect(db, todo());
  const it = listItems(db, todo().id, { status: 'new,kept' }).find((x) => x.title.includes('trip date'));
  say('ugh, traffic is terrible today');
  itsTime(it.id);
  queue({ data: { state: 'waiting', by: null, why: 'about traffic' } });
  await collect(db, todo());
  assert.equal(getItem(db, it.id).status, 'new');
  assert.ok(nudges().some((r) => r.item_id === it.id && r.text === 'No reply yet · Waiting on Maya: the trip date'));
});

test('everything else on the list is nudged as before, when it is filed', async () => {
  const m = say("I'll send you the photos tonight", 1);
  queue({
    data: {
      items: [{ message_id: m, title: 'Send Maya the photos', category: 'commitment', nudge_at: `${tomorrow} 09:00`, confidence: 0.9 }],
    },
  });
  await collect(db, todo());
  const it = listItems(db, todo().id, { status: 'new,kept' }).find((x) => x.title === 'Send Maya the photos');
  assert.ok(nudges().some((r) => r.item_id === it.id && r.status === 'pending' && r.text === 'Send Maya the photos'));
});

test('they answered with a voice note: it is judged by what was said', async () => {
  const m = say('shall we keep the kitchen order, or cancel it? let me know by tomorrow', 1);
  queue({ data: { items: [waitingFor(m, 'Waiting on Maya: keep the kitchen order or cancel it')] } });
  await collect(db, todo());
  const it = listItems(db, todo().id, { status: 'new,kept' }).find((x) => x.title.includes('kitchen order'));
  const v = voice('yes lets go ahead with the order, I will confirm the chairs on Monday');
  await readNow();
  itsTime(it.id);
  const before = nudges().length;
  queue({ data: { state: 'answered', by: null, why: 'she said to go ahead' } });
  await collect(db, todo());
  assert.equal(getItem(db, it.id).status, 'done', 'answered, by voice');
  assert.equal(nudges().length, before, 'the owner is not told');
  const judged = calls().find((c) => /kitchen order/.test(c.input) && /Said in that conversation since/.test(c.input));
  assert.match(
    judged.input,
    /- .*: \(a voice note, written down by a machine\) yes lets go ahead with the order, I will confirm the chairs on Monday/,
  );
  // and what was said is kept with the message, like any voice note that has been listened to
  assert.equal(
    wa.prepare('SELECT heard FROM messages WHERE id = ?').get(v).heard,
    'yes lets go ahead with the order, I will confirm the chairs on Monday',
  );
});

test('a voice note that cannot be listened to is not taken for silence: the owner is told there is one', async () => {
  const m = say('can you confirm the delivery date?', 1);
  queue({ data: { items: [waitingFor(m, 'Waiting on Maya: the delivery date')] } });
  await collect(db, todo());
  const it = listItems(db, todo().id, { status: 'new,kept' }).find((x) => x.title.includes('delivery date'));
  voice('BROKEN');
  itsTime(it.id);
  const asked = calls().length;
  queue({ data: { items: [] } });
  await collect(db, todo());
  assert.ok(
    nudges().some(
      (r) =>
        r.item_id === it.id &&
        r.text === 'No reply I could read · Waiting on Maya: the delivery date (they sent a voice note: listen to it)',
    ),
    JSON.stringify(nudges().map((r) => r.text)),
  );
  assert.ok(
    !calls()
      .slice(asked)
      .some((c) => /Said in that conversation since/.test(c.input)),
    'with nothing to read, no reader is asked whether it was answered',
  );
  assert.equal(getItem(db, it.id).status, 'new');
});

test('every look judges what has come since: an answer before its time ticks it off at once', async () => {
  const m = say('what time does the match start on Saturday?', 1);
  queue({ data: { items: [waitingFor(m, 'Waiting on Maya: when the match starts')] } });
  await collect(db, todo());
  const it = listItems(db, todo().id, { status: 'new,kept' }).find((x) => x.title.includes('match starts'));
  // she writes, but not the answer: it goes on waiting, and nothing is said (its time has not come)
  say('running late, talk later');
  const before = nudges().length;
  queue({ data: { state: 'waiting', by: null, why: 'not about the match' } }, { data: { items: [] } });
  await collect(db, todo());
  assert.equal(getItem(db, it.id).status, 'new');
  assert.equal(nudges().length, before);
  assert.ok(getItem(db, it.id).checked_ts > 0, 'how far it has been looked at is kept');
  // a look with nothing new from her asks no reader again
  const asked = calls().length;
  await collect(db, todo());
  assert.equal(calls().length, asked, 'what was judged before is not judged again');
  // then she answers, still before its time: ticked off at the next look, without a word
  say('kick-off is at 3');
  queue({ data: { state: 'answered', by: null, why: 'she gave the time' } }, { data: { items: [] } });
  await collect(db, todo());
  assert.equal(getItem(db, it.id).status, 'done');
  assert.equal(nudges().length, before, 'the owner was never told anything about it');
  assert.doesNotMatch(await briefing(), /\d+\. Waiting on Maya: when the match starts/);
});

test('judged before and no answer, then its time comes with nothing new: the owner is told, with no reader asked again', async () => {
  const m = say('did you book the table?', 1);
  queue({ data: { items: [waitingFor(m, 'Waiting on Maya: whether the table is booked')] } });
  await collect(db, todo());
  const it = listItems(db, todo().id, { status: 'new,kept' }).find((x) => x.title.includes('table is booked'));
  say('one sec, on a call');
  queue({ data: { state: 'waiting', by: null, why: 'not an answer' } }, { data: { items: [] } });
  await collect(db, todo());
  itsTime(it.id);
  const asked = calls().length;
  await collect(db, todo());
  assert.equal(calls().length, asked);
  assert.ok(nudges().some((r) => r.item_id === it.id && r.text === 'No reply yet · Waiting on Maya: whether the table is booked'));
});

test('a back-and-forth in text and voice notes from both of them is read as one conversation, and what it came to is kept', async () => {
  clearOthers();
  const m = say('are we going ahead with the joinery, or cancelling the order?', 1);
  queue({ data: { items: [waitingFor(m, 'Waiting on Maya: go ahead with the joinery or cancel')] } });
  await collect(db, todo());
  const it = listItems(db, todo().id, { status: 'new,kept' }).find((x) => x.title.includes('joinery'));
  // she asks back by voice, the owner answers by voice and by text, she settles it by voice
  voice('before I decide, can the doors be done in oak instead of walnut');
  voice('yes oak is fine, same price', 1);
  say('and delivery stays the 20th', 1);
  voice('ok then lets go ahead, keep the order');
  await readNow();
  queue({ data: { state: 'answered', by: null, why: 'she will go ahead, in oak, order kept' } }, { data: { items: [] } });
  await collect(db, todo());
  const judged = calls().find((c) => /joinery/.test(c.input) && /Said in that conversation since/.test(c.input));
  const lines = judged.input.split('\n').filter((l) => l.startsWith('- '));
  assert.deepEqual(
    lines.map((l) => l.replace(/^- \S+ \S+ /, '')),
    [
      '+111: (a voice note, written down by a machine) before I decide, can the doors be done in oak instead of walnut',
      'Me: (a voice note, written down by a machine) yes oak is fine, same price',
      'Me: and delivery stays the 20th',
      '+111: (a voice note, written down by a machine) ok then lets go ahead, keep the order',
    ],
    'both sides, in order, voice notes as their words',
  );
  assert.match(judged.system, /Read it as one conversation and say where it stands at the end/);
  assert.match(judged.system, /something agreed and then changed is judged by the change/);
  const done = getItem(db, it.id);
  assert.deepEqual([done.status, done.summary], ['done', 'Answered: she will go ahead, in oak, order kept']);
});

test("the owner's own follow-up alone is not something new to judge", async () => {
  clearOthers();
  const m = say('can you send the measurements?', 1);
  queue({ data: { items: [waitingFor(m, 'Waiting on Maya: the measurements')] } });
  await collect(db, todo());
  say('whenever you get a minute', 1);
  const asked = calls().filter((c) => /Said in that conversation since/.test(c.input)).length;
  queue({ data: { items: [] } });
  await collect(db, todo());
  assert.equal(calls().filter((c) => /Said in that conversation since/.test(c.input)).length, asked);
});

test('put off, or promised, for a later day: the owner goes on waiting until then, and the briefing says what was said', async () => {
  clearOthers();
  const m = say('please tell me by tomorrow: does the sofa ship this week, or do we cancel?', 1);
  queue({ data: { items: [waitingFor(m, 'Waiting on Maya: whether the sofa ships or is cancelled')] } });
  await collect(db, todo());
  const it = listItems(db, todo().id, { status: 'new,kept' }).find((x) => x.title.includes('sofa ships'));
  const first = it.remind_ts;
  voice('give me until Tuesday, I will have an answer by then, otherwise I cancel the order for you');
  voice('fine, Tuesday is the limit, no more extensions', 1);
  say('no worries, cancelled by Tuesday if it has not shipped');
  await readNow();
  const d = new Date(Date.now() + 3 * 86400000);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const before = nudges().length;
  queue(
    { data: { state: 'later', by: `${day} 18:00`, why: 'put off to Tuesday: cancelled by then if it has not shipped' } },
    { data: { items: [] } },
  );
  await collect(db, todo());
  const now = getItem(db, it.id);
  assert.equal(now.status, 'new', 'still open');
  assert.ok(now.remind_ts > first, 'expected later than it was');
  assert.equal(new Date(now.remind_ts * 1000).getHours(), 18);
  assert.equal(now.summary, 'Since then: put off to Tuesday: cancelled by then if it has not shipped');
  assert.equal(nudges().length, before, 'and nothing is said: it is not late');
  const judged = calls().find((c) => /sofa ships/.test(c.input) && /Said in that conversation since/.test(c.input));
  assert.match(judged.input, /^now: \d{4}-\d\d-\d\d \d\d:\d\d \(\w+\)\n/, 'it is told the time, to work out "Tuesday"');
  assert.match(judged.system, /A promise of the thing is not the thing/);
  assert.match(
    judged.system,
    /is read by the owner themselves\. Write it to them: "you" and "your", never "the owner"/,
    'told to say "you"',
  );
  assert.match(
    await briefing(),
    /Waiting on Maya: whether the sofa ships or is cancelled · asked today · expected by [A-Z][a-z]{2} \d+ [A-Z][a-z]{2}, 18:00 · put off to Tuesday: cancelled by then if it has not shipped/,
  );
  // the day it was first expected comes and goes: it is not late, so nothing is said
  await collect(db, todo());
  assert.equal(nudges().length, before);
  // a time that cannot be read changes nothing
  say('actually maybe Wednesday');
  queue({ data: { state: 'later', by: 'sometime', why: 'vague' } }, { data: { items: [] } });
  await collect(db, todo());
  assert.equal(getItem(db, it.id).remind_ts, now.remind_ts);
});

test('what was answered is said once in the briefing, since nothing else says it', async () => {
  clearOthers();
  const m = say('any update on the curtains?', 1);
  queue({ data: { items: [waitingFor(m, 'Waiting on Maya: update on the curtains')] } });
  await collect(db, todo());
  const it = listItems(db, todo().id, { status: 'new,kept' }).find((x) => x.title.includes('curtains'));
  say('they are in the van, dropping them off in an hour');
  queue({ data: { state: 'answered', by: null, why: 'she is dropping them off within the hour' } }, { data: { items: [] } });
  await collect(db, todo());
  assert.equal(getItem(db, it.id).status, 'done');
  assert.match(await briefing(), /✓ Maya: update on the curtains · answered: she is dropping them off within the hour/);
});

test('an answer from the reader that cannot be used stops only that entry, not the look', async () => {
  clearOthers();
  const m = say('did the cheque clear?', 1);
  queue({ data: { items: [waitingFor(m, 'Waiting on Maya: whether the cheque cleared')] } });
  await collect(db, todo());
  const it = listItems(db, todo().id, { status: 'new,kept' }).find((x) => x.title.includes('cheque'));
  const reply = say('yes, this morning');
  // (the stand-in gives nothing that fits, twice: the reader gives up on it)
  queue({ data: { nonsense: true } }, { data: { nonsense: true } }, { data: { items: [] } });
  const r = await collect(db, todo());
  assert.equal(r.looked > 0, true, 'the rest of the look went on');
  assert.equal(getItem(db, it.id).status, 'new');
  assert.equal(getItem(db, it.id).checked_ts ?? null, null, 'and it is judged again next time');
  queue({ data: { state: 'answered', by: null, why: 'it cleared this morning' } });
  await collect(db, todo());
  assert.equal(getItem(db, it.id).status, 'done');
  assert.ok(reply);
});

test('a voice note still to be listened to is waited for: the entry is judged at the look after, not on half the conversation', async () => {
  clearOthers();
  const m = say('is the plumber coming on Friday?', 1);
  queue({ data: { items: [waitingFor(m, 'Waiting on Maya: whether the plumber comes on Friday')] } });
  await collect(db, todo());
  const it = listItems(db, todo().id, { status: 'new,kept' }).find((x) => x.title.includes('plumber'));
  voice('yes he is booked for Friday at ten');
  const answered = () => calls().filter((c) => /plumber/.test(c.input) && /Said in that conversation since/.test(c.input)).length;
  // the hourly look comes before the job has listened: nothing is judged, and nothing is marked as looked at
  await collect(db, todo());
  assert.deepEqual([answered(), getItem(db, it.id).status, getItem(db, it.id).checked_ts], [0, 'new', null]);
  await readNow();
  queue({ data: { state: 'answered', by: null, why: 'he is booked for Friday at ten' } });
  await collect(db, todo());
  assert.deepEqual([answered(), getItem(db, it.id).status], [1, 'done']);
});

test('what is asked or promised in a voice note is picked up like a written message, from either side', async () => {
  clearOthers();
  const theirs = voice('can you pick me up at six tomorrow from the station');
  const mine = voice('can you send me the signed lease by Thursday', 1);
  await readNow();
  queue({
    data: {
      items: [
        {
          message_id: theirs,
          title: 'Pick Maya up at the station at six',
          category: 'reply',
          summary: 'she asked',
          nudge_at: `${tomorrow} 17:00`,
          confidence: 0.9,
        },
        waitingFor(mine, 'Waiting on Maya: the signed lease'),
      ],
    },
  });
  await collect(db, todo());
  const asked = calls().at(-1);
  assert.match(
    asked.input,
    new RegExp(
      `\\[${theirs}\\] \\S+ \\S+ \\+111: \\(a voice note, written down by a machine\\) can you pick me up at six tomorrow from the station`,
    ),
  );
  assert.match(
    asked.input,
    new RegExp(`\\[${mine}\\] \\S+ \\S+ Me: \\(a voice note, written down by a machine\\) can you send me the signed lease by Thursday`),
  );
  assert.match(
    asked.system,
    /A message that begins "\(a voice note, written down by a machine\)" is what was said in a voice note\. It counts like any written message/,
  );
  const open = listItems(db, todo().id, { status: 'new,kept' });
  const pick = open.find((x) => x.title === 'Pick Maya up at the station at six');
  const lease = open.find((x) => x.title === 'Waiting on Maya: the signed lease');
  assert.deepEqual([pick?.msg_id, lease?.msg_id], [theirs, mine]);
  assert.ok(
    nudges().some((r) => r.item_id === pick.id && r.status === 'pending'),
    'a to-do from a voice note is nudged like any other',
  );
  // and what the owner asked by voice is followed up: the reader is told what was asked, in its words
  say('sending it tonight');
  queue({ data: { state: 'later', by: `${tomorrow} 21:00`, why: 'she will send it tonight' } });
  await collect(db, todo());
  const judged = calls().find((c) => /signed lease/.test(c.input) && /Said in that conversation since/.test(c.input));
  assert.match(judged.input, /The owner wrote \(\S+ \S+\): can you send me the signed lease by Thursday/);
});

test('a voice note that arrives just before a look is read at the look after it has been listened to, once', async () => {
  clearOthers();
  const v = voice('remember the dentist moved to Wednesday at four');
  const t = say('and bring the forms');
  // this look reads the text, and goes past the voice note, which has no words yet
  queue({ data: { items: [] } });
  await collect(db, todo());
  const first = calls().at(-1).input;
  assert.match(first, new RegExp(`\\[${t}\\]`));
  assert.doesNotMatch(first, new RegExp(`\\[${v}\\]`));
  await readNow();
  queue({
    data: {
      items: [
        {
          message_id: v,
          title: 'Dentist on Wednesday at four',
          category: 'event',
          nudge_at: `${tomorrow} 09:00`,
          event_date: tomorrow,
          confidence: 0.9,
        },
      ],
    },
  });
  const second = await collect(db, todo());
  assert.match(
    calls().at(-1).input,
    new RegExp(`\\[${v}\\] .*\\(a voice note, written down by a machine\\) remember the dentist moved to Wednesday at four`),
  );
  assert.doesNotMatch(calls().at(-1).input, new RegExp(`\\[${t}\\]`), 'what was read before is not read again');
  assert.deepEqual(
    second.added.map((a) => a.title),
    ['Dentist on Wednesday at four'],
  );
  // and never a second time
  const asks = calls().length;
  await collect(db, todo());
  assert.equal(calls().length, asks);
});

test('voice notes from before are written down for searching, and are not read by the watch: only ones it saw arrive', async () => {
  clearOthers();
  // listening is off while these arrive, and the watch reads on past them
  setReading('voice', { mode: 'off' });
  voice('you owe me fifty for the tickets, pay me back this week');
  say('see you there');
  queue({ data: { items: [] } });
  await collect(db, todo());
  // switched on: the old one is listened to (it can be searched for), and no look reads it
  setReading('voice', { mode: 'both' });
  assert.equal((await readNow()).done, 1);
  assert.equal(wa.prepare("SELECT COUNT(*) FROM messages WHERE heard LIKE 'you owe me fifty%'").pluck().get(), 1);
  const asks = calls().length;
  await collect(db, todo());
  assert.equal(calls().length, asks, 'nothing new to read');
});

test('the text in a picture is read like a written message too, at the look after the picture has been read', async () => {
  clearOthers();
  // (Pictures are read here: a first run of the job notes from when.)
  await readNow();
  const id = `W${n + 1}`;
  const r = wa
    .prepare(
      "INSERT INTO messages (chat_ref, id, sender_ref, from_me, ts, type, text) VALUES ('111@s.whatsapp.net', ?, '111@s.whatsapp.net', 0, ?, 'image', NULL)",
    )
    .run(id, Math.floor(Date.now() / 1000) + ++n);
  wa.prepare("INSERT INTO media (msg_rowid, dl_type, mimetype) VALUES (?, 'image', 'image/jpeg')").run(r.lastInsertRowid);
  fs.mkdirSync(path.join(MEDIA_DIR, id), { recursive: true });
  fs.writeFileSync(
    path.join(MEDIA_DIR, id, 'image.jpg'),
    JSON.stringify({ text: 'School fees of 500 are due on Friday', extra: [], score: 92 }),
  );
  const after = say('did you see this?');
  // the look that sees it arrive goes on without it
  queue({ data: { items: [] } });
  await collect(db, todo());
  assert.doesNotMatch(calls().at(-1).input, new RegExp(`\\[${id}\\]`));
  assert.match(calls().at(-1).input, new RegExp(`\\[${after}\\]`));
  await readNow();
  say('ok');
  queue({
    data: {
      items: [
        {
          message_id: id,
          title: 'Pay the school fees',
          category: 'reply',
          summary: 'due Friday',
          nudge_at: `${tomorrow} 17:00`,
          confidence: 0.9,
        },
      ],
    },
  });
  await collect(db, todo());
  assert.match(
    calls().at(-1).input,
    new RegExp(`\\[${id}\\] \\S+ \\S+ \\+111: \\(text in a picture, read by a machine\\) School fees of 500 are due on Friday`),
  );
  assert.ok(listItems(db, todo().id).some((i) => i.title === 'Pay the school fees'));
});

test('what something came to is kept whole or cut at a word, never in the middle of one, and without a second lead-in', async () => {
  const { clause } = await import('../src/watch/shape.js');
  assert.equal(
    clause('Since then: he will deliver on Tuesday'),
    'he will deliver on Tuesday',
    'the lead-in is added where it is kept, once',
  );
  assert.equal(clause('Answered, he will go ahead'), 'he will go ahead');
  assert.equal(clause('  null '), null);
  const long =
    "Tom agreed to tell you by Tuesday, the limit you set, whether the sofa ships, and to cancel the order by then if it hasn't. Since then he has asked for your order number and offered 50 back now with the rest later when the factory pays him";
  const cut = clause(long);
  assert.ok(cut.length <= 200, `${cut.length} characters`);
  assert.ok(long.startsWith(cut.replace(/…$/, '')), 'nothing is changed, only left off');
  const end = cut.replace(/…$/, '');
  assert.ok(/[.;]$/.test(end) || long[end.length] === ' ', `it ends at a sentence or a whole word: "…${cut.slice(-25)}"`);
  // one long word cannot be cut at a space: it is still kept to the length
  assert.ok(clause('x'.repeat(400)).length <= 200);

  // and so it is on an entry: a reader that says too much
  clearOthers();
  const m = say('can you send the signed contract by Friday?', 1);
  queue({ data: { items: [waitingFor(m, 'Waiting on Maya: the signed contract')] } });
  await collect(db, todo());
  const it = listItems(db, todo().id, { status: 'new,kept' }).find((i) => i.title === 'Waiting on Maya: the signed contract');
  say('I will send it on Monday, the office is closed until then');
  queue({ data: { state: 'later', by: `${tomorrow} 18:00`, why: `Since then: ${long}` } });
  await collect(db, todo());
  const kept = getItem(db, it.id).summary;
  assert.match(kept, /^Since then: Tom agreed/);
  assert.doesNotMatch(kept, /Since then:.*Since then:/, 'the lead-in is there once');
  assert.ok(/[.;…]$/.test(kept), `not cut in a word: "…${kept.slice(-30)}"`);
});

test('the check for readers: a waiting entry tied to the wrong message, an answer that runs on, a promise taken for the thing', async () => {
  const { readerCases } = await import('../src/watch/checks.js');
  const [tied, brief] = readerCases();
  const item = (id) => ({
    items: [{ message_id: id, title: 'Waiting on Nina: which recipe', category: 'waiting', nudge_at: '', confidence: 0.9 }],
  });
  assert.match(
    tied.content,
    /\[m2\].* Me: .*\n\[m3\].*\n\[m4\].* Me: .*which one was it\?/,
    'the owner wrote twice; only the later message asks',
  );
  assert.equal(tied.ok(item('m4')), true);
  assert.match(tied.ok(item('m2')), /tied the question to m2/);
  assert.match(tied.ok({ items: [] }), /did not see/);
  assert.match(tied.system, /the message with the question itself/, "the reader's real instructions");
  assert.equal(brief.ok({ state: 'later', by: 'Friday 18:00', why: 'a refund by Friday if it has not shipped' }), true);
  assert.match(brief.ok({ state: 'answered', by: null, why: 'she will refund' }), /promise/);
  assert.match(brief.ok({ state: 'later', by: null, why: 'x'.repeat(260) }), /260 characters/);
  assert.match(brief.ok({ state: 'waiting', by: null, why: 'Since then: nothing new' }), /lead-in/);
});

test('a message with a long id is shown to a reader under a short label, and what the reader names by it is the right message', async () => {
  clearOthers();
  // Two of the owner's own messages whose ids differ only in the middle, as a chat service gives them.
  const put = (id, text, fromMe, back) =>
    wa
      .prepare(
        "INSERT INTO messages (chat_ref, id, sender_ref, from_me, ts, type, text) VALUES ('111@s.whatsapp.net', ?, '111@s.whatsapp.net', ?, ?, 'text', ?)",
      )
      .run(id, fromMe, Math.floor(Date.now() / 1000) - back, text);
  const earlier = 'AC7DA3ABBBF033AF9DC9EF21E3B09E35';
  const question = 'ACD22C0391A4ED0B82CDBCBDC9E48D1B';
  put(earlier, 'sure, come over now', 1, 90);
  put('A5DF528EE4B9A6F5F8E8B3F2915876F1', 'on my way', 0, 80);
  put(question, 'the recipe you mentioned the other day, which one was it?', 1, 70);
  queue({ data: { items: [] } });
  await collect(db, todo(), { dryRun: true });
  const input = calls().at(-1).input;
  const label = /^\[(m\d+)\] \S+ \S+ Me: the recipe you mentioned/m.exec(input)?.[1];
  assert.ok(label, `the question stands under a short label:\n${input.split('\n').slice(-4).join('\n')}`);
  assert.doesNotMatch(input, /AC7DA3ABBBF033AF|ACD22C0391A4ED0B/, 'the long ids are not shown at all');
  assert.notEqual(/^\[(m\d+)\] \S+ \S+ Me: sure, come over now/m.exec(input)?.[1], label);
  // the reader names it by the label: the entry is tied to the question, not to the message beside it
  // (and one named by the id itself is understood too)
  queue({
    data: {
      items: [
        waitingFor(label, 'Waiting on Maya: which recipe she meant'),
        { ...waitingFor(earlier, 'Be home when Maya drops by'), category: 'commitment' },
      ],
    },
  });
  await collect(db, todo());
  assert.ok(listItems(db, todo().id, { status: 'new,kept' }).some((i) => i.msg_id === earlier && i.category === 'commitment'));
  const it = listItems(db, todo().id, { status: 'new,kept' }).find((i) => i.title.includes('which recipe'));
  assert.equal(it.msg_id, question);
});
