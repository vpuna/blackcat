// What a reader gives a watch lands on its list under the list's own names: one shape for an
// entry, whichever reader fills it in. And what "Things I need to do" picks up can be added
// to, or kept from, in the owner's words.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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

await setUp({ bot: { allow: [{ id: 42, name: 'me' }] } });
const { openWrite } = await import('../src/archive/db.js');
const { openWatchDb, addWatch, getWatch, listItems, listWatches, updateWatch, TODO } = await import('../src/watch/db.js');
const { collect, tidy } = await import('../src/watch/collect.js');
const { LIST, TIDY, TODO_KINDS, todoShape } = await import('../src/watch/shape.js');
const { misfit } = await import('../src/readers.js');

const wa = openWrite();
wa.prepare("INSERT INTO chats (ref, name, is_group) VALUES ('111@s.whatsapp.net', 'Maya', 0)").run();
let n = 0;
const say = (text, fromMe = 0) => {
  wa.prepare(
    "INSERT INTO messages (chat_ref, id, sender_ref, from_me, ts, type, text) VALUES ('111@s.whatsapp.net', ?, '111@s.whatsapp.net', ?, ?, 'text', ?)",
  ).run(`M${++n}`, fromMe, Math.floor(Date.now() / 1000) - 60 + n, text);
  return `M${n}`;
};
const tomorrow = (() => {
  const d = new Date(Date.now() + 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
})();

test("one shape for an entry: each reader asks for the fields it needs, under the list's own names", () => {
  const fields = (s) => Object.keys(s.properties.items.items.properties).sort();
  assert.deepEqual(fields(LIST), [
    'area',
    'category',
    'changed',
    'confidence',
    'event_date',
    'existing_id',
    'message_id',
    'place',
    'summary',
    'title',
  ]);
  assert.deepEqual(fields(todoShape(5)), ['category', 'confidence', 'event_date', 'message_id', 'nudge_at', 'place', 'summary', 'title']);
  assert.deepEqual(todoShape(5).properties.items.items.properties.category.enum, TODO_KINDS);
  assert.equal(todoShape(5).properties.items.maxItems, 5);
  // every field says what it is, where the model sees it with the shape
  for (const s of [LIST, todoShape(5)])
    for (const [k, f] of Object.entries(s.properties.items.items.properties)) assert.ok(f.description?.length > 10, k);
  assert.equal(
    misfit(todoShape(5), {
      items: [{ message_id: 'M1', title: 'Call the bank', category: 'note to self', nudge_at: '2026-10-07 09:00', confidence: 0.95 }],
    }),
    null,
  );
  assert.match(
    misfit(todoShape(5), { items: [{ message_id: 'M1', title: 'x', category: 'chore', nudge_at: '2026-10-07 09:00', confidence: 1 }] }),
    /category is not one of/,
  );
  assert.match(
    misfit(todoShape(5), { items: [{ message_id: 'M1', title: 'x', category: 'event', nudge_at: 'tomorrow morning', confidence: 1 }] }),
    /nudge_at is not written as expected/,
  );
  assert.match(misfit(LIST, { items: [{ title: 'no message' }] }), /has no "message_id"/);
  assert.equal(misfit(TIDY, { groups: [{ ids: [1, 2], summary: 'one thing' }] }), null);
});

test('"Things I need to do": what the reader picks out goes on the list, with its nudge', async () => {
  const db = openWatchDb();
  const todo = listWatches(db).find((w) => w.builtin === TODO);
  updateWatch(db, todo.id, { active: 1, sources: { everywhere: 'all', mine: true, calendar: false } });
  const m1 = say('can you pick up Leo on Thursday at 5?');
  const m2 = say('lol look at this');
  queue({
    data: {
      items: [
        {
          message_id: m1,
          title: 'Reply to Maya about picking up Leo',
          category: 'reply',
          summary: 'she asked and has no answer',
          nudge_at: `${tomorrow} 09:00`,
          confidence: 0.9,
        },
        {
          message_id: m2,
          title: 'Not sure about this one',
          category: 'other',
          summary: 'unclear',
          nudge_at: `${tomorrow} 09:00`,
          confidence: 0.3,
        }, // too unsure: left out
        {
          message_id: 'NOPE',
          title: 'From a message that was never given',
          category: 'event',
          summary: 'x',
          nudge_at: `${tomorrow} 09:00`,
          confidence: 1,
        }, // not one it was shown: left out
      ],
    },
  });
  const r = await collect(db, getWatch(db, todo.id));
  assert.equal(r.added.length, 1);
  const [it] = listItems(db, todo.id, { status: 'new,kept' });
  assert.deepEqual(
    [it.title, it.category, it.summary, it.msg_id, it.msg_chat],
    ['Reply to Maya about picking up Leo', 'reply', 'she asked and has no answer', m1, 'Maya'],
  );
  assert.equal(new Date(it.remind_ts * 1000).getHours(), 9);
  const c = calls().at(-1);
  assert.deepEqual(JSON.parse(c.schema), todoShape(8));
  assert.match(c.system, /^You are a reader\. You have no tools[\s\S]*\n\nYou pick out what the owner needs to do or answer/);
  assert.doesNotMatch(c.system, /The owner has asked/, 'nothing added, nothing kept out: neither is mentioned');
  assert.match(c.input, new RegExp(`\\[${m1}\\] .* can you pick up Leo on Thursday at 5\\?`));
  db.close();
});

test('"Things I need to do": an event carries its day and its place; the other kinds do not', async () => {
  const db = openWatchDb();
  const todo = listWatches(db).find((w) => w.builtin === TODO);
  const e = say("dinner at Luigi's tomorrow at 8?");
  const d = say('the school fee is due tomorrow');
  const old = say('the fair was last week');
  queue({
    data: {
      items: [
        {
          message_id: e,
          title: "Dinner with Maya at Luigi's, 8pm",
          category: 'event',
          summary: 'she proposed it',
          nudge_at: `${tomorrow} 18:00`,
          event_date: tomorrow,
          place: "Luigi's",
          confidence: 0.9,
        },
        {
          message_id: d,
          title: 'Pay the school fee',
          category: 'deadline',
          summary: 'due tomorrow',
          nudge_at: `${tomorrow} 09:00`,
          event_date: tomorrow,
          place: 'School office',
          confidence: 0.9,
        },
        {
          message_id: old,
          title: 'The fair',
          category: 'event',
          summary: 'x',
          nudge_at: `${tomorrow} 09:00`,
          event_date: '2020-01-01',
          place: null,
          confidence: 0.9,
        },
      ],
    },
  });
  await collect(db, getWatch(db, todo.id));
  const by = Object.fromEntries(listItems(db, todo.id, { status: 'new,kept' }).map((i) => [i.title, i]));
  assert.deepEqual(
    [by["Dinner with Maya at Luigi's, 8pm"].event_date, by["Dinner with Maya at Luigi's, 8pm"].place],
    [tomorrow, "Luigi's"],
  );
  assert.deepEqual(
    [by['Pay the school fee'].event_date, by['Pay the school fee'].place],
    [null, null],
    'a deadline stays until it is dealt with: it has no day to pass',
  );
  assert.equal(by['The fair'].event_date, null, 'a day already past is not taken');
  // in the briefing the event is under its day, with where it is
  assert.match(bc('watch', 'briefing', '--print').stdout, /Dinner with Maya at Luigi's, 8pm · Luigi's/);
  db.close();
});

test("what it picks up can be added to, or kept from, in the owner's words; the rest of what it is told stands", async () => {
  assert.match(
    bc('watch', 'edit', 'todo', '--also', 'payment requests from the school, even in groups', '--never', 'delivery notifications').stdout,
    /updated/,
  );
  const listed = bc('watch', 'list').stdout;
  assert.match(listed, /also: {6}payment requests from the school, even in groups\n\s+never: {5}delivery notifications\n/);
  say('your parcel is out for delivery');
  queue({ data: { items: [] } });
  const db = openWatchDb();
  const todo = listWatches(db).find((w) => w.builtin === TODO);
  await collect(db, getWatch(db, todo.id));
  const told = calls().at(-1).system;
  assert.match(
    told,
    /Pick out at most 8\. With nothing to pick out, the list is empty\.\n\nThe owner has asked for these to be picked up as well, in their own words:\npayment requests from the school, even in groups\n\nThe owner has asked that these are never picked up, whatever is said above:\ndelivery notifications/,
  );
  assert.match(told, /^You are a reader\. You have no tools/, 'the ground rules are still said first');
  // one taken away again; the other stays
  bc('watch', 'edit', 'todo', '--never', '');
  assert.deepEqual(
    [getWatch(db, todo.id).sources.also, getWatch(db, todo.id).sources.never],
    ['payment requests from the school, even in groups', undefined],
  );
  // setting it up again without saying keeps it
  assert.match(bc('watch', 'setup', '--auto', '--scan', '2h', '--chats', 'all').stdout, /^Saved/);
  assert.equal(getWatch(db, todo.id).sources.also, 'payment requests from the school, even in groups');
  // its built-in description is not what decides, and saying so points to what does
  assert.match(
    bc('watch', 'edit', 'todo', '--look-for', 'only bills').said,
    /is built in\. Add to it with --also "…", or keep something out with --never "…"\./,
  );
  // only this watch has them
  const other = addWatch(db, {
    chatId: 42,
    name: 'Ideas',
    lookFor: 'ideas',
    sources: { chats: [{ ref: '111@s.whatsapp.net', name: 'Maya' }] },
    mode: 'briefing',
  });
  assert.match(bc('watch', 'edit', String(other.id), '--also', 'x').said, /--also and --never are for "Things I need to do"/);
  // the agent may change what is picked up only with the owner's say
  await (await import('../src/plugins/registry.js')).loadPlugins();
  const { decide } = await import('../src/agent/policy.js');
  assert.equal(decide('Bash', { command: 'blackcat watch edit todo --never "delivery notifications" --json' }).action, 'ask');
  assert.equal(decide('Bash', { command: 'blackcat watch edit todo --scan 2h --json' }).action, 'allow');
  db.close();
});

test("a watch's own list: a new entry, an update to one already there, and tidying", async () => {
  const db = openWatchDb();
  const w = listWatches(db).find((x) => x.name === 'Ideas');
  const m = say('there is a concert on Saturday at the marina');
  queue({
    data: {
      items: [
        {
          message_id: m,
          title: 'Concert at the marina',
          category: 'event',
          place: 'Marina stage',
          area: 'Marina',
          event_date: tomorrow,
          summary: 'An open-air concert.',
          confidence: 0.9,
        },
      ],
    },
  });
  let r = await collect(db, getWatch(db, w.id));
  assert.equal(r.added.length, 1);
  const [it] = listItems(db, w.id, { status: 'new,kept' });
  assert.deepEqual(
    [it.title, it.category, it.place, it.area, it.event_date, it.summary],
    ['Concert at the marina', 'event', 'Marina stage', 'Marina', tomorrow, 'An open-air concert.'],
  );
  assert.deepEqual(JSON.parse(calls().at(-1).schema), LIST);
  assert.match(calls().at(-1).system, /The list is called "Ideas"\. What belongs on it, in the owner's words:\n"ideas"/);
  // a later message about the same thing: the entry is filled in, not doubled
  const m2 = say('the concert starts at 8, tickets at the door');
  queue({
    data: { items: [{ message_id: m2, existing_id: it.id, summary: 'An open-air concert at 8pm, tickets at the door.', changed: false }] },
  });
  r = await collect(db, getWatch(db, w.id));
  assert.deepEqual([r.added.length, r.updated.length], [0, 1]);
  assert.equal(listItems(db, w.id, { status: 'new,kept' })[0].summary, 'An open-air concert at 8pm, tickets at the door.');
  // tidying: two entries that are the same thing become one
  const m3 = say('marina gig on Saturday!!');
  queue({ data: { items: [{ message_id: m3, title: 'Marina gig', category: 'event', confidence: 0.8 }] } });
  await collect(db, getWatch(db, w.id));
  const two = listItems(db, w.id, { status: 'new,kept' });
  assert.equal(two.length, 2);
  queue({ data: { groups: [{ ids: two.map((x) => x.id), summary: 'An open-air concert at the marina at 8pm.' }] } });
  const merged = await tidy(db, getWatch(db, w.id));
  assert.equal(merged.length, 1);
  assert.deepEqual(JSON.parse(calls().at(-1).schema), TIDY);
  assert.deepEqual(
    listItems(db, w.id, { status: 'new,kept' }).map((x) => x.summary),
    ['An open-air concert at the marina at 8pm.'],
  );
  db.close();
});

test('a chat message is shown to the reader with what was said just before it, whoever said it, as background only', async () => {
  const db = openWatchDb();
  const w = listWatches(db).find((x) => x.name === 'Ideas');
  updateWatch(db, w.id, { sources: { ...getWatch(db, w.id).sources, mine: false } }); // (a watch told to leave the owner's own messages out)
  say('Skippy chewed the sofa again', 1);
  say('naughty boy');
  const m = say("please let's talk to him tonight");
  queue({ data: { items: [] } });
  await collect(db, getWatch(db, w.id));
  const asked = calls().at(-1);
  const line = asked.input.split('\n').find((l) => l.startsWith(`[${m}]`));
  assert.match(line, /talk to him tonight \| said just before: .*Me: Skippy chewed the sofa again \/ \+111: naughty boy/);
  assert.doesNotMatch(asked.input, /^\[[^\]]+\][^\n]* Me in /m, 'what the owner wrote is background, never a message to judge');
  // and the reader is told what that is for, and to leave out what it cannot make sense of
  assert.match(asked.system, /"said just before": the few lines that came before it in the chat/);
  assert.match(asked.system, /If you cannot tell who "him", "it" or "that" is, leave the message out/);
  db.close();
});

test("a watch reads the owner's own messages in its chats too, unless told not to; one already running reads them from then on", async () => {
  // a new watch: on, with nothing said
  let r = bc('watch', 'add', 'Plans', '--look-for', 'plans we make', '--chat', 'Maya', '--history', 'none', '--json');
  assert.equal(r.status, 0, r.said);
  const id = JSON.parse(r.stdout).id ?? JSON.parse(r.stdout).watch?.id;
  const db = openWatchDb();
  assert.equal(getWatch(db, id).sources.mine, true);
  const mine = say("let's have the party on the 4th", 1);
  const hers = say('ok');
  queue({
    data: {
      items: [{ message_id: hers, title: 'Party on the 4th', category: 'plan', event_date: tomorrow, summary: 'Agreed.', confidence: 0.9 }],
    },
  });
  r = await collect(db, getWatch(db, id));
  const asked = calls().at(-1);
  assert.match(
    asked.input,
    new RegExp(`^\\[${mine}\\] [^\\n]* Me in Maya: let's have the party on the 4th`, 'm'),
    "the owner's own message is one of those judged",
  );
  assert.match(asked.input, new RegExp(`^\\[${hers}\\] [^\\n]*: ok \\| said just before: .*Me: let's have the party on the 4th`, 'm'));
  assert.match(asked.system, /A message from "Me" is the owner's own/);
  assert.match(
    asked.system,
    /A short reply that agrees to what was said just before \("ok", "yes", "sure, let's"\) makes that thing a plan/,
  );
  assert.deepEqual(
    r.added.map((a) => a.title),
    ['Party on the 4th'],
  );
  db.close();

  // switched off: the owner's messages are no longer judged, and it is said
  assert.equal(bc('watch', 'edit', String(id), '--no-also-mine').status, 0);
  assert.match(bc('watch', 'list').said, /Plans[\s\S]*?watching: +Maya \(not your own messages there\)/);
  const db2 = openWatchDb();
  const quiet = say('and I will bring the cake', 1);
  queue({ data: { items: [] } });
  await collect(db2, getWatch(db2, id));
  assert.doesNotMatch(calls().at(-1)?.input ?? '', new RegExp(`^\\[${quiet}\\]`, 'm'));
  // switched on again: from now on only, not everything written while it was off
  assert.equal(bc('watch', 'edit', String(id), '--also-mine').status, 0);
  const again = getWatch(db2, id).sources;
  assert.equal(again.mine, true);
  assert.ok(again.mineSince >= Math.floor(Date.now() / 1000) - 5);
  db2.close();
  assert.equal(bc('watch', 'add', 'Quiet', '--look-for', 'x', '--chat', 'Maya', '--no-also-mine', '--json').status, 0);
  const db3 = openWatchDb();
  assert.equal(listWatches(db3).find((x) => x.name === 'Quiet').sources.mine, false);
  db3.close();
});

test("a watch that was already there starts reading the owner's own messages from the day this came in, not their whole history", async () => {
  const { openSqlite } = await import('../src/db.js');
  const old = path.join(dir, 'older');
  fs.mkdirSync(path.join(old, 'data'), { recursive: true, mode: 0o700 });
  fs.copyFileSync(path.join(dir, 'data/agent.db'), path.join(old, 'data/agent.db'));
  const raw = openSqlite(path.join(old, 'data/agent.db'));
  raw.pragma('wal_checkpoint(TRUNCATE)');
  // as it was before: at step 4, one watch that never asked for the owner's messages, one that did, and the built-in one
  raw.prepare("UPDATE shapes SET step = 4 WHERE part = 'watch'").run();
  raw
    .prepare("UPDATE watches SET sources = ? WHERE name = 'Ideas'")
    .run(JSON.stringify({ chats: [{ ref: '111@s.whatsapp.net', name: 'Maya' }], mine: false }));
  raw
    .prepare("UPDATE watches SET sources = ? WHERE name = 'Plans'")
    .run(JSON.stringify({ chats: [{ ref: '111@s.whatsapp.net', name: 'Maya' }], mine: true }));
  const todoBefore = raw.prepare('SELECT sources FROM watches WHERE builtin IS NOT NULL').pluck().get();
  raw.close();
  const r = spawnSync(process.execPath, [`${root}bin/bc.js`, 'watch', 'list', '--json'], {
    encoding: 'utf8',
    env: { ...plain(), BLACKCAT_HOME: old },
  });
  assert.equal(r.status, 0, r.stderr);
  const after = openSqlite(path.join(old, 'data/agent.db'));
  const src = (name) => JSON.parse(after.prepare('SELECT sources FROM watches WHERE name = ?').pluck().get(name));
  assert.equal(src('Ideas').mine, true);
  assert.ok(src('Ideas').mineSince >= Math.floor(Date.now() / 1000) - 10, 'from now on');
  assert.deepEqual(src('Ideas').chats, [{ ref: '111@s.whatsapp.net', name: 'Maya' }], 'and nothing else about it changed');
  assert.deepEqual(
    src('Plans'),
    { chats: [{ ref: '111@s.whatsapp.net', name: 'Maya' }], mine: true },
    'one that already read them is left as it was',
  );
  assert.equal(
    after.prepare('SELECT sources FROM watches WHERE builtin IS NOT NULL').pluck().get(),
    todoBefore,
    'and so is the built-in one',
  );
  assert.equal(after.prepare("SELECT step FROM shapes WHERE part = 'watch'").pluck().get(), 5);
  after.close();
});

test('an entry is changed where it is: it keeps its number, its link, the message it came from and how it stood', async () => {
  let r = bc('watch', 'add', 'Outings', '--look-for', 'things to do', '--chat', 'Maya', '--history', 'none', '--json');
  const id = JSON.parse(r.stdout).id ?? JSON.parse(r.stdout).watch?.id;
  const m = say('lunch at the fish place, 12:30 Saturday? https://example.org/reel/1');
  queue({
    data: {
      items: [
        {
          message_id: m,
          title: 'Fish place lunch 12:30',
          category: 'restaurant',
          place: 'The fish place',
          event_date: tomorrow,
          summary: 'Lunch at 12:30.',
          confidence: 0.9,
        },
      ],
    },
  });
  const made = JSON.parse(bc('watch', 'scan', String(id), '--json').stdout).watches[0].added[0];
  const db = openWatchDb();
  db.prepare("UPDATE watch_items SET url = 'https://example.org/reel/1' WHERE id = ?").run(made.id);
  const before = db.prepare('SELECT * FROM watch_items WHERE id = ?').get(made.id);
  db.close();

  r = bc('watch', 'edit-item', String(made.id), '--title', 'Fish place lunch 14:00', '--summary', 'Lunch moved to 14:00.', '--json');
  assert.equal(r.status, 0, r.said);
  const after = (() => {
    const d = openWatchDb();
    const row = d.prepare('SELECT * FROM watch_items WHERE id = ?').get(made.id);
    const n = d.prepare('SELECT COUNT(*) FROM watch_items WHERE watch_id = ?').pluck().get(id);
    d.close();
    return { row, n };
  })();
  assert.deepEqual([after.row.title, after.row.summary], ['Fish place lunch 14:00', 'Lunch moved to 14:00.']);
  for (const k of ['id', 'url', 'msg_id', 'msg_chat', 'msg_sender', 'msg_ts', 'status', 'category', 'place', 'event_date', 'created_ts'])
    assert.equal(after.row[k], before[k], `${k} is as it was`);
  assert.equal(after.n, 1, 'still one entry, not a second one');
  // its day, moved and then taken away; the list it is on
  assert.match(
    bc('watch', 'edit-item', String(made.id), '--date', '2027-01-02').said,
    /Item \d+ changed: Fish place lunch 14:00 · 2027-01-02/,
  );
  assert.equal(bc('watch', 'edit-item', String(made.id), '--date', '').status, 0);
  assert.equal(bc('watch', 'edit-item', String(made.id), '--list', 'outings').status, 0);
  const d2 = openWatchDb();
  assert.deepEqual(d2.prepare('SELECT event_date, category, url FROM watch_items WHERE id = ?').get(made.id), {
    event_date: null,
    category: 'outing',
    url: 'https://example.org/reel/1',
  });
  d2.close();
  // what is refused, and nothing changes
  assert.match(bc('watch', 'edit-item', String(made.id)).said, /Say what to change/);
  assert.match(bc('watch', 'edit-item', String(made.id), '--title', ' ').said, /An entry needs a title/);
  assert.match(bc('watch', 'edit-item', String(made.id), '--date', 'Saturday').said, /--date is YYYY-MM-DD/);
  assert.match(bc('watch', 'edit-item', '99999', '--title', 'x').said, /No item 99999/);
  // and the agent is told to change an entry, not to drop it and add another
  const { loadPlugins, findLoaded, makeCtx } = await import('../src/plugins/registry.js');
  await loadPlugins();
  const { notesOf } = await import('../src/plugins/notes.js');
  assert.match(
    notesOf(findLoaded('watch'), makeCtx(findLoaded('watch'))) ?? '',
    /change that entry with `edit-item`\. Never drop it and add another/,
  );
});

test('two looks at the same moment file a message once, however differently each reader put it', async () => {
  const db = openWatchDb();
  const w = listWatches(db).find((x) => x.name === 'Ideas');
  const m = say('will you be able to help me with the garden tonight');
  db.close();
  const answer = {
    data: {
      items: [
        {
          message_id: m,
          title: 'Help with the garden __PID__',
          category: 'request',
          summary: 'She asked for help tonight.',
          confidence: 0.9,
        },
      ],
    },
  };
  queue(answer, answer, answer, answer);
  const scan = () =>
    new Promise((resolve) => {
      const c = spawn(process.execPath, [`${root}bin/bc.js`, 'watch', 'scan', String(w.id), '--json'], {
        env: plain(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      c.stdout.on('data', (d) => (out += d));
      c.on('close', (code) => resolve({ code, out }));
    });
  const both = await Promise.all([scan(), scan()]);
  assert.deepEqual(
    both.map((r) => r.code),
    [0, 0],
    both.map((r) => r.out).join('\n'),
  );
  const after = openWatchDb();
  const mine = listItems(after, w.id, { status: 'new,kept' }).filter((i) => i.msg_id === m);
  assert.equal(mine.length, 1, `filed once, not ${mine.length} times: ${mine.map((i) => i.title).join(' | ')}`);
  assert.equal(
    both.reduce((n, r) => n + JSON.parse(r.out).watches[0].added.length, 0),
    1,
    'and only one of the two says it added it',
  );
  after.close();
  wa.close();
});
