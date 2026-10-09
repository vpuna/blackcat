// blackcat's own record of conversations with the agent: every turn is kept, tied to what
// the activity record says it took, and an earlier conversation can be carried on, the
// engine's way while it still can and from the record when it cannot.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SIGNED_IN, home, setUp } from './helpers.js';

const dir = home();
process.env.HOME = dir; // Claude Code's own conversation files live under the home folder
const root = new URL('..', import.meta.url).pathname;
const { save, load } = await import('../src/config.js');
await setUp({ bot: { allow: [{ id: 42, name: 'me' }] } });
fs.mkdirSync(path.join(dir, 'agent'), { recursive: true });

// A stand-in for `claude` that answers each message with what it was sent, so a test can
// see exactly what a conversation was told. Each process is one engine session.
const sent = path.join(dir, 'sent.log');
const fake = path.join(dir, 'fake-claude.mjs');
fs.writeFileSync(
  fake,
  `
import fs from 'node:fs'; import readline from 'node:readline';
const args = process.argv.slice(2);
const resumed = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null;
if (resumed === 'gone') process.exit(1); // the engine no longer has that conversation
const session = resumed ?? 'sess-' + process.pid;
let n = 0;
// Like Claude Code, it reports cost and model time as totals for the whole conversation,
// and carries them on when the conversation is picked up again by a new process.
const tally = ${JSON.stringify(path.join(dir, 'tally-'))} + session;
let total = fs.existsSync(tally) ? Number(fs.readFileSync(tally, 'utf8')) : 0;
const reader = args.includes('--tools') && args[args.indexOf('--tools') + 1] === '';
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.type !== 'user') return;
  if (reader) {
    // A reader asked to summarise: say what it was given, so a test can see what was read.
    const q = m.message.content;
    fs.appendFileSync(${JSON.stringify(path.join(dir, 'read.log'))}, JSON.stringify({ system: args[args.indexOf('--append-system-prompt') + 1].slice(0, 60), text: q }) + '\\n');
    if (process.env.READER_FAILS) { console.log(JSON.stringify({ type: 'result', is_error: true, result: 'no' })); return; }
    const nums = [...q.matchAll(/Owner: question (\\d+) /g)].map((x) => Number(x[1]));
    console.log(JSON.stringify({ type: 'result', is_error: false, result: 'Summary so far:\\n\\nSUMMARY' + (q.startsWith('Summary so far:') ? ' (added to)' : '') + ': questions ' + nums[0] + ' to ' + nums.at(-1), session_id: 'r', usage: { input_tokens: 1, output_tokens: 1 } }));
    return;
  }
  n++; total++; fs.writeFileSync(tally, String(total));
  fs.appendFileSync(${JSON.stringify(sent)}, JSON.stringify({ session, resumed: !!resumed, text: m.message.content }) + '\\n');
  if (n === 1) console.log(JSON.stringify({ type: 'system', subtype: 'init' }));
  console.log(JSON.stringify({ type: 'result', is_error: false, result: 'answer to: ' + m.message.content.split('\\n').at(-1), session_id: session, duration_ms: 50, duration_api_ms: 2 * total, num_turns: 1, total_cost_usd: 0.01 * total,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, modelUsage: { 'claude-sonnet-5-5': { costUSD: 0.01 * total } } }));
});`,
);
fs.writeFileSync(path.join(dir, 'fake-bin/claude'), `#!/bin/sh\n${SIGNED_IN}exec ${process.execPath} ${fake} "$@"\n`, { mode: 0o755 });
const told = () =>
  fs
    .readFileSync(sent, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

const brain = await import('../src/agent/brain.js');
const store = await import('../src/conversations/store.js');
const { ofTurn } = await import('../src/activity/log.js');
const CHAT = 42;
// Claude Code keeps each conversation in a file of its own; pretend it has, for a session.
const engineFile = (session) =>
  path.join(os.homedir(), '.claude/projects', path.join(dir, 'agent').replace(/[^A-Za-z0-9]/g, '-'), `${session}.jsonl`);
const keepEngineCopy = (session) => {
  fs.mkdirSync(path.dirname(engineFile(session)), { recursive: true });
  fs.writeFileSync(engineFile(session), '');
};

test('every turn is kept: question, reply, how long, and what it used', async () => {
  assert.equal(await brain.reply(CHAT, 'What is the plan for the school trip?'), 'answer to: What is the plan for the school trip?');
  await brain.reply(CHAT, 'And who is driving?');
  const [c] = store.list({ channel: 'tg-bot', chat: CHAT });
  assert.deepEqual(
    [c.title, c.turns, c.channel, c.chat, c.engine],
    ['What is the plan for the school trip?', 2, 'tg-bot', '42', 'claude-code'],
  );
  assert.match(c.engine_session, /^sess-/);
  const turns = store.turns(c.id);
  assert.deepEqual(
    turns.map((t) => [t.question, t.reply, t.ok]),
    [
      ['What is the plan for the school trip?', 'answer to: What is the plan for the school trip?', 1],
      ['And who is driving?', 'answer to: And who is driving?', 1],
    ],
  );
  assert.ok(turns[0].ms >= 0);
  // the activity record's entry for the turn is tied to it
  const used = ofTurn(turns[1].id);
  assert.deepEqual(
    used.map((e) => [e.kind, e.category, e.data.engine]),
    [['model', 'chat', 'claude-code']],
  );
  assert.equal(brain.listConversations(CHAT)[0].current, true);
});

test('a title comes from the first thing asked, without the notes blackcat puts in front', () => {
  assert.equal(
    store.titleOf('[Since your last reply, the owner asked for these directly: lights off]\n\nWhat time is the match?'),
    'What time is the match?',
  );
  assert.equal(store.titleOf('\n\n  first real line  \nsecond'), 'first real line');
  assert.equal(store.titleOf('x'.repeat(200)).length, 80);
  assert.equal(store.titleOf(''), 'Untitled');
});

test('/new starts another conversation; the earlier one can be picked and carried on as it was', async () => {
  const first = store.list({ channel: 'tg-bot', chat: CHAT })[0];
  keepEngineCopy(first.engine_session);
  brain.resetSession(CHAT);
  await brain.reply(CHAT, 'Something else entirely: how hot is it?');
  const all = brain.listConversations(CHAT);
  assert.deepEqual(
    all.map((c) => [c.title, c.current]),
    [
      ['Something else entirely: how hot is it?', true],
      ['What is the plan for the school trip?', false],
    ],
  );

  const r = await brain.resumeConversation(CHAT, first.id);
  assert.equal(r.how, 'as it was', 'the engine still has it and nothing has changed: it picks it up itself');
  await brain.reply(CHAT, 'Back to the trip: what time do we leave?');
  const last = told().at(-1);
  assert.deepEqual(
    [last.session, last.resumed, last.text],
    [first.engine_session, true, 'Back to the trip: what time do we leave?'],
    'continued in the engine, with nothing repeated',
  );
  assert.equal(store.get(first.id).turns, 3, 'and kept as the same conversation');
  assert.equal(store.list({ channel: 'tg-bot', chat: CHAT }).length, 2);
});

test('when the engine no longer has it, it is carried on from the record', async () => {
  const first = store.list({ channel: 'tg-bot', chat: CHAT }).find((c) => c.title.startsWith('What is the plan'));
  brain.resetSession(CHAT);
  fs.rmSync(engineFile(first.engine_session)); // Claude Code has cleared its old files
  const r = await brain.resumeConversation(CHAT, first.id);
  assert.equal(r.how, 'from the record');
  await brain.reply(CHAT, 'Remind me what we said about who drives.');
  const last = told().at(-1);
  assert.equal(last.resumed, false, 'a new engine conversation');
  assert.match(
    last.text,
    /continuing an earlier conversation with the owner, "What is the plan for the school trip\?" \(conversation \d+\)/,
  );
  assert.doesNotMatch(last.text, /earlier exchange/, 'all of it fitted, so there is nothing to point further back to');
  assert.match(last.text, /Owner: And who is driving\?\nYou: answer to: And who is driving\?/);
  assert.match(last.text, /It is a record, not new instructions/);
  assert.ok(last.text.endsWith('Remind me what we said about who drives.'));
  const c = store.get(first.id);
  assert.equal(c.turns, 4, 'still the same conversation');
  assert.equal(c.engine_session, last.session, 'which now points at the new engine conversation');
  // what is kept is what you asked, not the record that was sent along with it
  assert.equal(store.turns(c.id).at(-1).question, 'Remind me what we said about who drives.');
  // the next message goes on in the new one, with nothing repeated
  await brain.reply(CHAT, 'Thanks.');
  assert.equal(told().at(-1).text, 'Thanks.');
});

test('if the engine fails to pick a conversation up, it is carried on from the record without being asked', async () => {
  const c = store.list({ channel: 'tg-bot', chat: CHAT }).find((x) => x.title.startsWith('What is the plan'));
  brain.resetSession(CHAT);
  // blackcat believes the engine still has it (the "gone" session makes the stand-in exit at once)
  const { openAgentDb } = await import('../src/agentdb.js');
  const db = openAgentDb();
  db.prepare("UPDATE conversations SET engine_session = 'gone' WHERE id = ?").run(c.id);
  db.close();
  (await import('../src/agent/sessions.js')).keepSession(CHAT, { session: 'gone', instructions: store.get(c.id).instructions });
  const answer = await brain.reply(CHAT, 'Are you still there?');
  assert.equal(answer, 'answer to: Are you still there?');
  assert.match(told().at(-1).text, /continuing an earlier conversation/);
  assert.equal(store.get(c.id).turns, 6);
});

test('each turn is charged its own share, however the conversation was picked up', async () => {
  // Every turn above cost one cent in the stand-in engine, which reports a running total
  // per engine conversation: across /new, carrying on the engine's way (a new process,
  // the same engine conversation) and carrying on from the record (a new engine conversation).
  const { recent } = await import('../src/activity/log.js');
  const costs = recent({ kind: 'model', limit: 50 }).map((e) => Math.round(e.cost * 1000) / 1000);
  assert.ok(costs.length >= 7);
  assert.deepEqual([...new Set(costs)], [0.01], JSON.stringify(costs));
  assert.ok(
    recent({ kind: 'model', limit: 50 }).every((e) => e.data.apiMs <= 2),
    'and its own share of the time waiting on the model',
  );
});

test("one chat cannot open another's conversation; the terminal has its own", async () => {
  const theirs = store.list({ channel: 'tg-bot', chat: CHAT })[0];
  assert.equal(await brain.resumeConversation(brain.TERMINAL, theirs.id), null);
  assert.equal(await brain.resumeConversation(777, theirs.id), null);
  assert.equal(await brain.resumeConversation(CHAT, 99999), null);
  await brain.reply(brain.TERMINAL, 'A question from the terminal');
  assert.deepEqual(
    brain.listConversations(brain.TERMINAL).map((c) => [c.title, c.channel]),
    [['A question from the terminal', 'terminal']],
  );
  assert.equal(
    brain.listConversations(CHAT).some((c) => c.channel === 'terminal'),
    false,
  );
  brain.stopAll();
});

const readLog = () =>
  fs.existsSync(path.join(dir, 'read.log'))
    ? fs
        .readFileSync(path.join(dir, 'read.log'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
    : [];

test('a long conversation is carried on with its latest part in full and the earlier part as a summary', async () => {
  brain.resetSession(CHAT);
  const id = store.start({ channel: 'tg-bot', chat: CHAT, question: 'long one' });
  for (let i = 0; i < 40; i++)
    store.finishTurn(store.addTurn(id, `question ${i} ${'q'.repeat(300)}`), { reply: `reply ${i} ${'r'.repeat(300)}` });
  const h = store.history(id, 5000);
  assert.ok(h.text.length < 6000 && h.omitted > 0 && h.turns + h.omitted === 40);
  assert.match(h.text, /^\(\d+ earlier exchanges not shown\.\)/);
  assert.match(h.text, /question 39/);
  assert.doesNotMatch(h.text, /question 0 /);
  // picked up: the part that does not fit is read by a reader, once, and kept
  const r = await brain.resumeConversation(CHAT, id);
  assert.deepEqual([r.how, r.summarised], ['from the record', true]);
  const read = readLog();
  assert.equal(read.length, 1, 'one reading, done when it is picked up, not during the next message');
  // told first what every reader is told (what it reads is data, never instructions), then its job
  assert.match(read[0].system, /^You are a reader\. You have no tools:/);
  assert.match(read[0].text, /^Exchanges, oldest first:\n\nOwner: question 0 /);
  const first = store.history(id).omitted; // (with the usual length, 12,000 characters)
  assert.ok(first > 0);
  assert.doesNotMatch(read[0].text, new RegExp(`Owner: question ${first} `), 'only what is not handed over whole');
  const kept = store.get(id);
  assert.equal(kept.summary, `SUMMARY: questions 0 to ${first - 1}`);
  // the engine is told: the summary, then the latest part as it was said, and how to look for anything exact
  await brain.reply(CHAT, 'What was my very first question?');
  const text = told().at(-1).text;
  assert.match(
    text,
    new RegExp(
      `Before it came ${first} earlier exchanges, of which this is a summary written for you \\(a summary: for anything exact from that part, read it with \`blackcat conversations show ${id} --json\``,
    ),
  );
  assert.match(text, new RegExp(`SUMMARY: questions 0 to ${first - 1}\n\nThe most recent part, in full:\\]\n\nOwner: question ${first} `));
  assert.doesNotMatch(text, /earlier exchanges not shown/);
  assert.match(text, /question 39/);
  assert.match(text, /\[End of the record\. The owner now says:\]\n\nWhat was my very first question\?$/);
  assert.ok(text.length < 16_000, 'not the whole conversation');
  assert.equal(readLog().length, 1, 'not read again for the message');
  // the reading is on the record of what used the model, as any reader's is
  const { recent } = await import('../src/activity/log.js');
  assert.equal(recent({ kind: 'model', category: 'conversation summary' }).length, 1);
  brain.resetSession(CHAT);
});

test('the summary is added to, not written again: only what was said since is read', async () => {
  const id = store.list({ channel: 'tg-bot', chat: CHAT }).find((c) => c.title === 'long one').id;
  const before = store.get(id);
  // picked up again with nothing new: nothing is read
  await brain.resumeConversation(CHAT, id);
  assert.equal(readLog().length, 1);
  brain.resetSession(CHAT);
  // it grows by thirty exchanges; picked up again, the reader is given the summary so far and the new part only
  for (let i = 41; i < 71; i++)
    store.finishTurn(store.addTurn(id, `question ${i} ${'q'.repeat(300)}`), { reply: `reply ${i} ${'r'.repeat(300)}` });
  const r = await brain.resumeConversation(CHAT, id);
  assert.equal(r.summarised, true);
  const read = readLog();
  assert.equal(read.length, 2);
  assert.match(read[1].text, new RegExp(`^Summary so far:\n${before.summary}\n\nExchanges, oldest first:\n\nOwner: question `));
  assert.doesNotMatch(read[1].text, /Owner: question 0 /, 'what was summarised before is not read again');
  assert.match(store.get(id).summary, /^SUMMARY \(added to\): questions \d+ to \d+$/);
  assert.ok(store.get(id).summary_upto > before.summary_upto);
  brain.resetSession(CHAT);
});

test('a very long conversation is read a piece at a time; a reader that fails leaves it as it was', async () => {
  const id = store.start({ channel: 'tg-bot', chat: CHAT, question: 'very long one' });
  for (let i = 0; i < 80; i++)
    store.finishTurn(store.addTurn(id, `question ${i} ${'q'.repeat(1200)}`), { reply: `reply ${i} ${'r'.repeat(1200)}` });
  const n = readLog().length;
  // the reader fails: it is carried on all the same, as before there were summaries
  process.env.READER_FAILS = '1';
  let r = await brain.resumeConversation(CHAT, id);
  assert.deepEqual([r.how, r.summarised], ['from the record', false]);
  await brain.reply(CHAT, 'carry on');
  assert.match(told().at(-1).text, /\d+ earlier exchanges are not in it\. If the owner refers to something from before it, read it with/);
  assert.equal(store.get(id).summary, null);
  brain.resetSession(CHAT);
  delete process.env.READER_FAILS;
  // and when it works: more than one piece, each given the summary of the ones before
  r = await brain.resumeConversation(CHAT, id);
  assert.equal(r.summarised, true);
  const pieces = readLog().slice(n + 1);
  assert.ok(pieces.length >= 3, `${pieces.length} pieces`);
  for (const p of pieces) assert.ok(p.text.length < 45_000, 'no piece is more than a reader is given at once');
  assert.match(pieces[0].text, /^Exchanges, oldest first:/);
  assert.match(pieces[1].text, /^Summary so far:\nSUMMARY: questions 0 to \d+\n\nExchanges/);
  assert.match(store.get(id).summary, /^SUMMARY \(added to\): questions \d+ to \d+$/);
  brain.resetSession(CHAT);
});

test('summaries can be switched off: then only the latest part is handed over, as before', async () => {
  const { update } = await import('../src/config.js');
  update((c) => {
    c.conversations = { ...c.conversations, summary: false };
  });
  const id = store.start({ channel: 'tg-bot', chat: CHAT, question: 'unsummarised' });
  for (let i = 0; i < 40; i++)
    store.finishTurn(store.addTurn(id, `question ${i} ${'q'.repeat(300)}`), { reply: `reply ${i} ${'r'.repeat(300)}` });
  const n = readLog().length;
  const r = await brain.resumeConversation(CHAT, id);
  assert.equal(r.summarised, false);
  assert.equal(readLog().length, n);
  await brain.reply(CHAT, 'go on');
  assert.match(told().at(-1).text, /earlier exchanges are not in it/);
  update((c) => {
    delete c.conversations.summary;
  });
  brain.resetSession(CHAT);
});

test('what you are shown when you pick one up: where you were, not the conversation', () => {
  const id = store.start({ channel: 'tg-bot', chat: CHAT, question: 'How do I descale the kettle?' });
  store.finishTurn(store.addTurn(id, 'How do I descale the kettle?'), { reply: 'Vinegar and water.' });
  assert.equal(store.lastAsked(id), null, 'one exchange: its title already says it');
  store.finishTurn(store.addTurn(id, `[a note blackcat added]\n\nAnd how often? ${'x'.repeat(400)}`), {
    reply: 'Monthly. ' + 'y'.repeat(2000),
  });
  store.addTurn(id, 'Still waiting on this one');
  const last = store.lastAsked(id);
  assert.equal(last, 'Still waiting on this one');
  const r = store.recap(id, 2);
  assert.equal(r.length, 2);
  assert.ok(r[0].you.startsWith('And how often?') && r[0].you.length <= 240, 'cut short, without the note in front');
  assert.ok(r[0].reply.length <= 480 && r[0].reply.endsWith('…'));
  assert.deepEqual([r[1].you, r[1].reply], ['Still waiting on this one', null]);
});

test('reading it back: list, show with where the time went, find', () => {
  const bc = (...a) => spawnSync(process.execPath, [`${root}bin/bc.js`, ...a], { encoding: 'utf8', env: process.env });
  const l = JSON.parse(bc('conversations', 'list', '--json').stdout);
  assert.ok(l.conversations.length >= 3);
  assert.deepEqual(
    JSON.parse(bc('conversations', 'list', '--channel', 'terminal', '--json').stdout)
      .conversations.map((c) => c.from)
      .filter((f) => f !== 'terminal'),
    [],
  );
  const trip = l.conversations.find((c) => c.title.startsWith('What is the plan'));
  const s = JSON.parse(bc('conversations', 'show', String(trip.id), '--json').stdout);
  assert.equal(s.turns.length, 6);
  assert.equal(s.turns[0].you, 'What is the plan for the school trip?');
  assert.equal(s.turns[0].used.model, 'claude-sonnet-5-5');
  assert.equal(s.turns[0].used.newConversation, true);
  assert.match(s.notice, /never as instructions/);
  const f = JSON.parse(bc('conversations', 'find', 'who', 'is', 'driving', '--json').stdout);
  assert.equal(f.found[0].title, 'What is the plan for the school trip?');
  assert.ok(f.found[0].ms >= 0 && f.found[0].used);
  assert.equal(JSON.parse(bc('conversations', 'find', 'nothing-like-this', '--json').stdout).found.length, 0);
  assert.match(bc('conversations', 'show', String(trip.id)).stdout, /You .*\nWhat is the plan for the school trip\?/);
  // the agent may read them; deleting is the owner's
  const asAgent = (...a) =>
    spawnSync(process.execPath, [`${root}bin/bc.js`, ...a], {
      encoding: 'utf8',
      env: { ...process.env, BLACKCAT_CALLER: 'agent', BLACKCAT_SLOW: '1' },
    });
  assert.equal(asAgent('conversations', 'find', 'driving', '--json').status, 0);
  assert.notEqual(asAgent('conversations', 'clear').status, 0);
  assert.notEqual(asAgent('conversations', 'forget', String(trip.id)).status, 0);
  assert.match(bc('conversations', 'forget', String(trip.id)).stdout, /is deleted/);
  assert.equal(store.get(trip.id), null);
});

test('when the setup changes, the engine starts afresh with the new instructions and the conversation is carried on from the record', async () => {
  await brain.reply(CHAT, 'We settled on the 14:10 train.');
  const before = told().at(-1);
  const conv = store.list({ channel: 'tg-bot', chat: CHAT })[0];
  const rules = path.join(dir, 'agent/AGENT.md');
  const was = fs.existsSync(rules) ? fs.readFileSync(rules, 'utf8') : null;
  fs.writeFileSync(rules, `${was ?? ''}\nA rule added since.\n`);
  const reply = await brain.reply(CHAT, 'Which train was it?');
  const last = told().at(-1);
  assert.match(
    reply,
    /^\(My setup has changed since we last spoke: a plugin, a device or a rule\. So that I know about it I have started afresh, and picked our conversation up from my record of it\.\)/,
  );
  assert.equal(last.resumed, false, 'a new engine conversation, begun with the instructions as they are now');
  assert.notEqual(last.session, before.session);
  assert.match(last.text, /continuing an earlier conversation with the owner/);
  assert.match(last.text, /Owner: We settled on the 14:10 train\./);
  assert.ok(last.text.endsWith('Which train was it?'));
  const now = store.get(conv.id);
  assert.equal(now.engine_session, last.session, 'the same conversation in the record, now with the new engine conversation');
  assert.equal(store.turns(conv.id).at(-1).question, 'Which train was it?');
  // told once: the next message is just the next message
  const next = await brain.reply(CHAT, 'Thanks.');
  assert.doesNotMatch(next, /My setup has changed/);
  assert.equal(told().at(-1).text, 'Thanks.');
  if (was == null) fs.rmSync(rules);
  else fs.writeFileSync(rules, was);
  await brain.reply(CHAT, 'ok');
});

test('switched off, nothing new is kept and the conversation still works; old ones age out', async () => {
  save({ ...load(), conversations: { on: false } });
  const before = store.counts().turns;
  brain.resetSession(CHAT);
  assert.equal(await brain.reply(CHAT, 'Not to be kept'), 'answer to: Not to be kept');
  brain.stopAll();
  assert.equal(store.counts().turns, before);
  save({ ...load(), conversations: { on: true, days: 30 } });
  const { openAgentDb } = await import('../src/agentdb.js');
  const db = openAgentDb();
  const old = store.start({ channel: 'terminal', chat: 'terminal', question: 'an old one' });
  store.finishTurn(store.addTurn(old, 'an old one'), { reply: 'yes' });
  db.prepare('UPDATE conversations SET last_ts = last_ts - 40 * 86400 WHERE id = ?').run(old);
  db.prepare("DELETE FROM meta WHERE key = 'conversations_pruned'").run();
  db.close();
  const fresh = store.start({ channel: 'terminal', chat: 'terminal', question: 'a new one' });
  store.addTurn(fresh, 'a new one');
  assert.equal(store.get(old), null, 'not used for 40 days, kept for 30');
  assert.ok(store.get(fresh));
});
