// The activity record as an audit: everything blackcat does is a piece of work with an id,
// every entry made for it carries the id, and one entry stands for the whole with how long
// it took. Who set it off is kept: the owner, the agent, blackcat itself, or a developer
// session, which is on the record like everything else and left out of what is shown.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { home, setUp } from './helpers.js';

const dir = home();
const root = new URL('..', import.meta.url).pathname;
await setUp({ bot: { allow: [{ id: 42, name: 'me' }] } });
const log = await import('../src/activity/log.js');
const { record, recent, totals, clear, work, came, ofWork, split, slowest, timings, processWho, askedBy, asAsked } = log;
const { FORCE_COLOR: _f, BLACKCAT_CALLER: _c, CLAUDECODE: _d, BLACKCAT_WORK: _w, ...base } = process.env;
const bc = (args, extra = {}) =>
  spawnSync(process.execPath, [`${root}bin/bc.js`, ...args], {
    encoding: 'utf8',
    env: { ...base, NO_COLOR: '1', ...extra },
    timeout: 60_000,
    input: '',
  });
const json = (args, extra) => JSON.parse(bc([...args, '--json'], extra).stdout);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withEnv = (env, fn) => {
  const was = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(was)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
};

test('who set it off: the owner, the agent, blackcat itself, or a developer session', () => {
  assert.equal(processWho({}), 'owner');
  assert.equal(processWho({ CLAUDECODE: '1' }), 'dev');
  assert.equal(processWho({ BLACKCAT_JOB: '1' }), 'blackcat');
  assert.equal(processWho({ BLACKCAT_SERVICE: 'wa' }), 'blackcat');
  // What the agent runs is the agent's, whatever else its environment says: its engine may
  // be the same program a developer session is.
  assert.equal(processWho({ BLACKCAT_CALLER: 'agent', CLAUDECODE: '1' }), 'agent');
  // A service or a job started from a developer's terminal is still blackcat's own.
  assert.equal(processWho({ BLACKCAT_SERVICE: 'agent', CLAUDECODE: '1' }), 'blackcat');
  assert.equal(processWho({ BLACKCAT_JOB: '1', CLAUDECODE: '1' }), 'blackcat');
});

test('a piece of work: every entry made while it goes on carries its id, and one entry stands for the whole', async () => {
  clear();
  const r = await work({ kind: 'event', category: 'a look', summary: 'looked' }, async () => {
    record({ kind: 'model', category: 'a look', ms: 300, model: 'm', tokensIn: 10, tokensOut: 5, cost: 0.01 });
    record({ kind: 'command', category: 'blackcat msg', ms: 200, summary: 'blackcat msg find …', data: { waitedForYouMs: 50 } });
    await sleep(30);
    return 'handed back as it is';
  });
  assert.equal(r, 'handed back as it is');
  const all = recent({}).reverse();
  assert.equal(all.length, 3);
  assert.equal(new Set(all.map((e) => e.work)).size, 1, 'one id for all of it');
  assert.deepEqual(
    all.map((e) => [e.kind, e.lead]),
    [
      ['model', 0],
      ['command', 0],
      ['event', 1],
    ],
  );
  const whole = all[2];
  assert.ok(whole.ms >= 30);
  // read back by its id, or by the number of any entry in it
  assert.equal(ofWork(whole.work).entries.length, 3);
  assert.equal(ofWork(all[0].id).id, whole.work);
  assert.equal(ofWork(999999), null);
  // where the time went
  const sp = split(ofWork(whole.work).entries);
  assert.deepEqual([sp.modelMs, sp.commandMs, sp.waitedMs, sp.calls, sp.commands], [300, 200, 50, 1, 1]);
  assert.equal(sp.ms, whole.ms);
  assert.equal(sp.cost, 0.01);
});

test('work that failed says so and why; work that found nothing to do is counted, with its time, and not listed', async () => {
  clear();
  await assert.rejects(
    work({ kind: 'job', category: 'x/broken' }, async () => {
      throw new Error('the server said no');
    }),
    /the server said no/,
  );
  const failed = recent({})[0];
  assert.deepEqual([failed.ok, failed.lead, failed.data.error], [false, 1, 'the server said no']);
  await work({ kind: 'job', category: 'x/quiet' }, async () => came({ idle: true }));
  await work({ kind: 'job', category: 'x/quiet' }, async () => came({ idle: true }));
  await work({ kind: 'job', category: 'x/quiet' }, async () => came({ did: 'fetched 2', data: { fetched: 2 } }));
  const quiet = recent({ category: 'x/quiet' });
  assert.equal(quiet.length, 1);
  assert.deepEqual([quiet[0].summary, quiet[0].data.fetched], ['fetched 2', 2]);
  assert.equal(totals({ kind: 'job' }).rows.find((x) => x.name === 'x/quiet').n, 3);
});

test('work inside other work is a part of it; something that happens by itself is a piece of work of its own', async () => {
  clear();
  await work({ kind: 'owner', who: 'owner', category: 'tapped' }, async () => {
    await work({ kind: 'event', category: 'inner' }, async () => record({ kind: 'sent', category: 'remind', summary: 'reminder 1' }));
  });
  const all = recent({});
  assert.equal(new Set(all.map((e) => e.work)).size, 1);
  assert.deepEqual(
    all.filter((e) => e.lead).map((e) => e.category),
    ['tapped'],
  );
  assert.ok(
    all.every((e) => e.who === 'owner'),
    "what the owner set off is the owner's, all the way down",
  );
  record({ kind: 'sent', category: 'remind', summary: 'reminder 2' });
  const alone = recent({})[0];
  assert.ok(alone.work && alone.lead === 1 && alone.work !== all[0].work);
});

test('work handed to another process is recorded as part of what asked for it', async () => {
  clear();
  let by;
  await work({ kind: 'owner', who: 'owner', category: 'bc wa recover' }, async () => (by = askedBy()));
  // (later, in the service that does it)
  await asAsked(JSON.parse(JSON.stringify(by)), async () => record({ kind: 'event', category: 'messages: wa', summary: 'recovered 3' }));
  const all = recent({});
  assert.equal(new Set(all.map((e) => e.work)).size, 1);
  assert.equal(all.find((e) => e.category === 'messages: wa').who, 'owner');
  // nothing kept with the request: done as work of its own
  await asAsked(undefined, async () => record({ kind: 'event', category: 'messages: wa', summary: 'recovered 0' }));
  assert.notEqual(recent({})[0].work, all[0].work);
});

test('several of the same are counted at once, and the slowest of what is counted is remembered', () => {
  clear();
  record({ kind: 'event', category: 'messages: wa', countOnly: true, count: 7 });
  record({ kind: 'event', category: 'messages: wa', countOnly: true, count: 2 });
  record({ kind: 'job', category: 'mail/sync', countOnly: true, ms: 900 });
  record({ kind: 'job', category: 'mail/sync', countOnly: true, ms: 4000 });
  record({ kind: 'job', category: 'mail/sync', countOnly: true, ms: 100 });
  assert.equal(recent({}).length, 0);
  assert.equal(totals({ kind: 'event' }).rows.find((x) => x.name === 'messages: wa').n, 9);
  const mail = totals({ kind: 'job' }).rows.find((x) => x.name === 'mail/sync');
  assert.deepEqual([mail.n, mail.ms, mail.slowest], [3, 5000, 4000]);
});

test('messages that arrive are counted by where they came from, never one entry each', async () => {
  clear();
  const { openArchiveForWriting, archiveStatements, messageRow } = await import('../src/api.js');
  const { noteArrived } = await import('../src/archive/writer.js');
  const db = openArchiveForWriting();
  const q = archiveStatements(db);
  q.chat.run({ ref: 'tg:7', name: 'A', isGroup: 0, ts: 1700000000 });
  for (const n of [1, 2, 3]) q.msg.run(messageRow({ chat: 'tg:7', id: `tg7_${n}`, ts: 1700000000 + n, text: 'PRIVATE WORDS' }));
  q.msg.run(messageRow({ chat: 'tg:7', id: 'tg7_3', ts: 1700000003, text: 'the same one again' })); // not stored twice, not counted twice
  // WhatsApp writes with the statement that fills in what a second sending adds: that is not a second message.
  const wa = '447700900000@s.whatsapp.net';
  q.chat.run({ ref: wa, name: 'B', isGroup: 0, ts: 1700000000 });
  q.msgFill.run(messageRow({ chat: wa, id: 'W1', ts: 1700000001, text: 'x' }));
  q.msgFill.run(messageRow({ chat: wa, id: 'W2', ts: 1700000002, text: 'x' }));
  const again = q.msgFill.run(messageRow({ chat: wa, id: 'W2', sender: '447700900001@s.whatsapp.net', ts: 1700000002, text: 'x' }));
  assert.equal(again.changes, 1, 'the sender was filled in');
  db.close();
  noteArrived();
  assert.equal(recent({}).length, 0);
  assert.equal(totals({ kind: 'event' }).rows.find((x) => x.name === 'messages: tg').n, 3);
  assert.equal(totals({ kind: 'event' }).rows.find((x) => x.name === 'messages: wa').n, 2);
});

test('a developer session is on the record, kept apart, and left out of what is shown unless asked for', () => {
  clear();
  assert.equal(bc(['remind', 'list']).status, 0);
  assert.equal(bc(['remind', 'list', '--all'], { CLAUDECODE: '1' }).status, 0);
  const plain = json(['activity', 'recent']).entries;
  assert.deepEqual(
    plain.map((e) => [e.category, e.who, e.summary ?? null]),
    [['bc remind list', 'owner', null]],
  );
  assert.deepEqual(
    json(['activity', 'recent', '--dev']).entries.map((e) => [e.category, e.who, e.summary]),
    [['bc remind list', 'dev', '--all']],
  );
  assert.equal(json(['activity', 'recent', '--all']).entries.length, 2);
  assert.equal(json(['activity', 'recent', '--who', 'dev']).entries.length, 1);
  assert.match(bc(['activity', 'recent', '--all']).stdout, /bc remind list: --all.*\(developer session\)/);
  // its use of the model is not added to the owner's
  record({ kind: 'model', category: 'chat', model: 'm', tokensIn: 100, tokensOut: 10, cost: 1, who: 'owner' });
  withEnv({ CLAUDECODE: '1' }, () => record({ kind: 'model', category: 'chat', model: 'm', tokensIn: 100, tokensOut: 10, cost: 5 }));
  assert.equal(totals({}).rows.find((x) => x.name === 'chat').cost, 1);
  assert.equal(totals({ dev: 'only' }).rows.find((x) => x.name === 'chat').cost, 5);
  assert.equal(totals({ dev: 'all' }).rows.find((x) => x.name === 'chat').cost, 6);
  assert.deepEqual(
    json(['activity', 'usage', '--by', 'who']).rows.map((x) => [x.who, x.cost]),
    [
      ['dev', 5],
      ['owner', 1],
    ],
  );
  assert.match(bc(['activity', 'status']).stdout, /1 call to the model \(\$1\.00/, 'today, without the developer session');
});

test('the owner can delete what developer sessions did, and nothing else, when they like; the agent cannot', () => {
  clear();
  record({ kind: 'model', category: 'chat', model: 'm', tokensIn: 100, cost: 1, who: 'owner' });
  withEnv({ CLAUDECODE: '1' }, () => {
    record({ kind: 'model', category: 'chat', model: 'm', tokensIn: 100, cost: 5 });
    record({ kind: 'event', category: 'from a developer session' });
  });
  const r = bc(['activity', 'clear', '--dev']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Deleted what developer sessions did: 2 entries/);
  assert.deepEqual(
    recent({ dev: 'all' }).map((e) => [e.category, e.who]),
    [
      ['bc activity clear', 'owner'],
      ['chat', 'owner'],
    ],
    "the owner's entries are kept, and the clearing is itself on the record",
  );
  assert.equal(totals({ dev: 'all' }).rows.find((x) => x.name === 'chat').cost, 1, 'and their part of the daily totals is gone');
  assert.equal(totals({ by: 'who' }).rows.filter((x) => x.name === 'dev').length, 0);
  // Not something the agent can do.
  withEnv({ CLAUDECODE: '1' }, () => record({ kind: 'event', category: 'kept' }));
  const a = bc(['activity', 'clear', '--dev'], { BLACKCAT_CALLER: 'agent' });
  assert.notEqual(a.status, 0);
  assert.equal(recent({ dev: 'only' }).length, 1);
});

test('the mark of a developer session cannot be taken by the agent, nor shed by a developer session', () => {
  clear();
  // The agent's engine may carry the mark (it may be the same program): its entries are the agent's, and are shown.
  withEnv({ BLACKCAT_CALLER: 'agent', CLAUDECODE: '1' }, () => {
    record({ kind: 'event', category: 'from the agent' });
    record({ kind: 'event', category: 'claims to be dev', who: 'dev' });
    record({ kind: 'event', category: 'claims to be the owner', who: 'owner' });
  });
  assert.deepEqual(
    recent({}).map((e) => e.who),
    ['agent', 'agent', 'agent'],
  );
  // Nothing a developer session records can be passed off as the owner's.
  withEnv({ CLAUDECODE: '1' }, () => record({ kind: 'owner', category: 'bc host mode', who: 'owner' }));
  assert.equal(recent({}).length, 3);
  assert.equal(recent({ dev: 'only' })[0].who, 'dev');
  // A scheduled job started from such a terminal is blackcat's own, and shown.
  bc(['remind', 'list'], { CLAUDECODE: '1', BLACKCAT_JOB: '1' });
  assert.deepEqual(
    recent({ category: 'bc remind' }).map((e) => [e.kind, e.who]),
    [['job', 'blackcat']],
  );
});

test('a command at a terminal is one piece of work: what it did is recorded with it, and read back step by step', () => {
  clear();
  // (A check that is not working when it is made is paused: this one stops working afterwards.)
  const flag = path.join(dir, 'well');
  fs.writeFileSync(flag, '');
  assert.equal(bc(['check', 'add', 'Never well', '--run', `test -e ${flag}`, '--every', '1h']).status, 0);
  assert.equal(bc(['check', 'add', 'Always well', '--run', 'true', '--every', '1h']).status, 0);
  assert.equal(bc(['check', 'edit', 'blackcat health', '--pause']).status, 0);
  fs.rmSync(flag);
  clear();
  bc(['check', 'run']);
  const all = recent({}).reverse();
  assert.deepEqual(
    all.map((e) => [e.kind, e.category, e.summary, e.ok, e.lead]),
    [
      // (what a check found wrong is what it found, not a failure of the check)
      ['event', 'check: Never well', 'not working', true, 0],
      ['owner', 'bc check run', null, true, 1],
    ],
    'the look that found all well is counted, not listed',
  );
  assert.equal(all[0].work, all[1].work);
  assert.equal(totals({ kind: 'event' }).rows.find((x) => x.name === 'check: Always well').n, 1);
  const shown = json(['activity', 'show', String(all[0].id)]);
  assert.equal(shown.what, 'owner: bc check run');
  assert.equal(shown.setOffBy, 'owner');
  assert.equal(shown.entries.length, 2);
  assert.ok(shown.where.ms >= 0 && shown.where.failed === 0);
  const text = bc(['activity', 'show', String(all[1].id)]).stdout;
  assert.match(text, /bc check run/);
  assert.match(text, /set off by you/);
  assert.match(text, /• check: Never well: not working/);
  assert.doesNotMatch(text, /✗•/);
  assert.match(bc(['activity', 'show', '424242']).stdout, /Nothing on the record with the number 424242/);
});

test('the slowest work, and how long each kind takes', async () => {
  clear();
  for (const ms of [100, 300, 9000])
    await work({ kind: 'event', category: 'watch: Things' }, async () => {
      record({ kind: 'model', category: 'watch: Things', ms: ms - 50, model: 'm' });
      return came({ did: 'read 2', data: {} });
    }).then(() => {
      // (the time of the whole is what the clock said; set here so the test does not wait nine seconds)
      const db = new Database(path.join(dir, 'data/agent.db'));
      db.prepare('UPDATE activity SET ms = ? WHERE lead = 1 AND id = (SELECT MAX(id) FROM activity WHERE lead = 1)').run(ms);
      db.close();
    });
  withEnv({ CLAUDECODE: '1' }, () => record({ kind: 'owner', category: 'bc engine check', ms: 240000 }));
  const slow = slowest({});
  assert.deepEqual(
    slow.map((e) => [e.category, e.ms, e.split.modelMs, e.split.restMs]),
    [
      ['watch: Things', 9000, 8950, 50],
      ['watch: Things', 300, 250, 50],
      ['watch: Things', 100, 50, 50],
    ],
    'slowest first, each with where its time went; the developer session left out',
  );
  assert.equal(slowest({ dev: 'all' })[0].category, 'bc engine check');
  const t = timings({});
  assert.deepEqual(t, [{ kind: 'event', category: 'watch: Things', failed: 0, n: 3, middleMs: 300, slowestMs: 9000, totalMs: 9400 }]);
  const out = bc(['activity', 'slow']).stdout;
  assert.match(out, /9\.0s {2}watch: Things: read 2\n\s+(8\.9|9\.0)s at the model \+ 50ms in blackcat/);
  assert.match(bc(['activity', 'timings']).stdout, /watch: Things\s+3\s+300ms\s+9\.0s\s+9\.4s/);
  assert.equal(json(['activity', 'slow', '--all']).work[0].what, 'owner: bc engine check');
});

test('the record is read a page at a time, and one line for each piece of work when asked', async () => {
  clear();
  for (let i = 1; i <= 7; i++)
    await work({ kind: 'event', category: `w${i}` }, async () => record({ kind: 'command', category: 'blackcat msg', ms: 1 }));
  const first = json(['activity', 'recent', '--work', '-n', '3']);
  assert.deepEqual(
    first.entries.map((e) => e.category),
    ['w7', 'w6', 'w5'],
  );
  const next = json(['activity', 'recent', '--work', '-n', '3', '--before', String(first.older.before)]);
  assert.deepEqual(
    next.entries.map((e) => e.category),
    ['w4', 'w3', 'w2'],
  );
  assert.equal(json(['activity', 'recent', '-n', '1000']).entries.length, 14, 'more than five hundred may be asked for');
});

test('a record from before who and work were kept is brought up to date with nothing lost', () => {
  clear();
  // As an earlier blackcat left it: no who, no work, daily totals without them.
  const file = path.join(dir, 'data/agent.db');
  let db = new Database(file);
  db.exec(`
    DROP INDEX activity_work;
    ALTER TABLE activity DROP COLUMN who; ALTER TABLE activity DROP COLUMN work; ALTER TABLE activity DROP COLUMN lead;
    DROP TABLE activity_daily;
    CREATE TABLE activity_daily (
      day TEXT NOT NULL, kind TEXT NOT NULL, category TEXT NOT NULL, model TEXT NOT NULL DEFAULT '',
      n INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, ms INTEGER NOT NULL DEFAULT 0,
      tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0, PRIMARY KEY (day, kind, category, model));
    UPDATE shapes SET step = 2 WHERE part = 'activity';`);
  const now = Math.floor(Date.now() / 1000);
  const day = new Date().toLocaleDateString('en-CA');
  db.prepare(
    "INSERT INTO activity (ts, kind, category, ok, ms, model, cost, turn_id, summary, data) VALUES (?, 'model', 'chat', 1, 4200, 'm', 0.5, 9, NULL, '{\"steps\":2}')",
  ).run(now);
  db.prepare("INSERT INTO activity (ts, kind, category, ok, ms, summary) VALUES (?, 'owner', 'bc restart', 1, 900, 'everything')").run(now);
  db.prepare(
    "INSERT INTO activity_daily (day, kind, category, model, n, failed, ms, tokens_in, cost) VALUES (?, 'model', 'chat', 'm', 12, 1, 50000, 3400, 6.5)",
  ).run(day);
  db.close();
  const old = recent({}).reverse();
  assert.deepEqual(
    old.map((e) => [e.kind, e.category, e.ms, e.summary, e.who, e.work, e.lead, e.turn_id]),
    [
      ['model', 'chat', 4200, null, null, null, 0, 9],
      ['owner', 'bc restart', 900, 'everything', null, null, 0, null],
    ],
  );
  assert.equal(old[0].data.steps, 2);
  const t = totals({}).rows.find((x) => x.name === 'chat');
  assert.deepEqual([t.n, t.failed, t.ms, t.tokensIn, t.cost], [12, 1, 50000, 3400, 6.5]);
  // and what is recorded from now on is added to the same day's totals
  record({ kind: 'model', category: 'chat', model: 'm', cost: 0.5, who: 'owner' });
  assert.equal(totals({ dev: 'all' }).rows.find((x) => x.name === 'chat').n, 13);
  db = new Database(file, { readonly: true });
  assert.equal(db.prepare("SELECT step FROM shapes WHERE part = 'activity'").pluck().get(), 3);
  db.close();
  // an entry from before can still be read by its number
  assert.equal(ofWork(old[1].id).entries[0].category, 'bc restart');
});

test("nothing leaves no trace: every part's commands and every scheduled job are on the record, with a time and who set them off", async () => {
  clear();
  const { loadPlugins, mountOf } = await import('../src/plugins/registry.js');
  const plugins = await loadPlugins();
  // One command of every part that has commands: how it is doing, which every part answers.
  const asked = [['status'], ['plugin', 'list'], ['permissions'], ['channel']];
  for (const p of plugins) if (p.manifest.commands?.status) asked.push([...mountOf(p.manifest), 'status']);
  assert.ok(asked.length > 15, `every part: ${asked.length}`);
  for (const words of asked) bc(words);
  const mine = recent({ kind: 'owner', limit: 500 });
  // (Reading the record is counted, and does not fill the record with itself.)
  assert.equal(totals({ kind: 'owner' }).rows.find((x) => x.name === 'bc activity status').n, 1);
  for (const words of asked.filter((w) => w[0] !== 'activity')) {
    const e = mine.find((x) => x.category === `bc ${words.join(' ')}`);
    assert.ok(e, `bc ${words.join(' ')} left no entry`);
    assert.ok(e.ms >= 0 && e.who === 'owner' && e.work && e.lead === 1, `bc ${words.join(' ')}: ${JSON.stringify(e)}`);
    assert.equal(e.data.looks, true);
  }
  // Every scheduled job, run once as the scheduler runs it: listed, or counted when it found nothing to do.
  const jobs = plugins.flatMap((p) => (p.manifest.jobs ?? []).map((j) => `${p.name}/${j.id}`));
  assert.ok(jobs.length >= 3, jobs.join(' '));
  for (const j of jobs) bc(['plugin', 'job', ...j.split('/')], { BLACKCAT_JOB: '1' });
  const counted = totals({ kind: 'job', dev: 'all' }).rows;
  for (const j of jobs) {
    const t = counted.find((x) => x.name === j);
    assert.ok(t?.n >= 1, `the job ${j} left no trace`);
  }
  assert.ok(
    recent({ kind: 'job', limit: 500 }).every((e) => e.who === 'blackcat' && e.work),
    "a job is blackcat's own, and a piece of work",
  );
});

test('a command leaves one entry, not two, also where it says more of itself than its name', () => {
  clear();
  bc(['stop', 'agent']); // (nothing runs here: it fails, and that is on the record)
  bc(['plugin', 'disable', 'host']);
  bc(['plugin', 'enable', 'host']);
  assert.deepEqual(
    recent({})
      .reverse()
      .map((e) => [e.category, e.summary, e.ok, e.lead]),
    [
      ['bc stop', 'agent', false, 1],
      ['bc plugin disable', 'host', true, 1],
      ['bc plugin enable', 'host', true, 1],
    ],
  );
});

test('how far back is read the same way by every command: a bad one is said, a day is taken', () => {
  for (const c of ['recent', 'slow', 'timings', 'usage']) {
    const r = bc(['activity', c, '--since', 'rubbish']);
    assert.equal(r.status, 0, `${c}: ${r.stderr}`);
    assert.match(r.stdout, /Can't read "rubbish" as how far back/, c);
  }
  assert.equal(bc(['activity', 'recent', '--since', '2026-01-01']).status, 0);
});
