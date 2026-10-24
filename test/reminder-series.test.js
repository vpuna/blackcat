// A reminder that repeats is one series: each time it comes round is a reminder of its own,
// and one left unanswered when the next comes is missed, not still to do ("time to go walking"
// three days running was three entries in the briefing). Done and cancel are for that time;
// stop ends the series. A real case: the briefing listed one walk for each weekday it went.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { home, setUp } from './helpers.js';

const dir = home();
await setUp({ bot: { allow: [{ id: 42, name: 'me' }] } });
const { withDb } = await import('../src/db.js');
const { addNextRepeat, addReminder, answer, getReminder, listReminders, oneEach, openRemindersDb, stopSeries } =
  await import('../src/reminders/db.js');
const { takeDue } = await import('../src/reminders/local.js');
const now = () => Math.floor(Date.now() / 1000);
const DAILY = '25 17 * * *';
const status = (db, ids) => ids.map((id) => getReminder(db, id).status);

test('reminders made before series: each gets the series of the first, and all but the last unanswered time are missed', () => {
  // (the table as it was at step 1, in a database of its own)
  const p = `${dir}/old.db`;
  const old = new Database(p);
  old.exec(`CREATE TABLE shapes (part TEXT PRIMARY KEY, step INTEGER NOT NULL); INSERT INTO shapes VALUES ('reminders', 2);
    CREATE TABLE reminders (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, text TEXT NOT NULL, due_ts INTEGER NOT NULL,
      created_ts INTEGER NOT NULL, source TEXT NOT NULL DEFAULT 'user', repeat TEXT, status TEXT NOT NULL DEFAULT 'pending', sent_ts INTEGER,
      note TEXT, msg_id TEXT, msg_chat TEXT, msg_sender TEXT, msg_quote TEXT, msg_ts INTEGER, item_id INTEGER, file TEXT)`);
  const add = old.prepare('INSERT INTO reminders (id, chat_id, text, due_ts, created_ts, repeat, status) VALUES (?, 1, ?, ?, 0, ?, ?)');
  add.run(74, 'Walk', 100, DAILY, 'sent');
  add.run(80, 'Walk', 200, DAILY, 'done');
  add.run(119, 'Walk', 300, DAILY, 'sent');
  add.run(127, 'Walk', 400, DAILY, 'sent');
  add.run(133, 'Walk', 500, DAILY, 'pending');
  add.run(90, 'Walk', 150, '0 9 * * 1', 'sent'); // the same words on another schedule: another series
  add.run(91, 'Pay the bill', 150, null, 'sent'); // one that does not repeat is still to do
  old.close();
  const db = new Database(p);
  return import('../src/reminders/db.js').then(({ upgradeReminders }) => {
    upgradeReminders(db);
    const rows = db.prepare('SELECT id, series, status FROM reminders ORDER BY id').all();
    assert.deepEqual(rows, [
      { id: 74, series: 74, status: 'missed' },
      { id: 80, series: 74, status: 'done' },
      { id: 90, series: 90, status: 'sent' },
      { id: 91, series: null, status: 'sent' },
      { id: 119, series: 74, status: 'missed' },
      { id: 127, series: 74, status: 'sent' },
      { id: 133, series: 74, status: 'pending' },
    ]);
    db.close();
  });
});

test('when the next time goes, the time before it left unanswered is missed; one answered stays as it was', () => {
  const [a, b] = withDb(openRemindersDb, (db) => {
    const a = addReminder(db, { chatId: 1, text: 'Go walking', dueTs: now() - 2 * 86400, repeat: DAILY });
    const b = addReminder(db, { chatId: 1, text: 'Water the plants', dueTs: now() - 2 * 86400, repeat: DAILY });
    assert.equal(a.series, a.id, 'the first of a series is the series');
    return [a, b];
  });
  takeDue();
  // Done with the plants that time; the walk not answered. Both come round again.
  const [a2, b2] = withDb(openRemindersDb, (db) => {
    answer(db, getReminder(db, b.id), 'done');
    const next = listReminders(db, { chatId: 1 }).filter((r) => r.status === 'pending');
    assert.deepEqual(next.map((r) => r.series).sort(), [a.id, b.id].sort(), 'the next of each, in the same series');
    // (brought forward, to go now)
    for (const r of next) db.prepare('UPDATE reminders SET due_ts = ? WHERE id = ?').run(now() - 60, r.id);
    return [a, b].map((x) => next.find((r) => r.series === x.id));
  });
  takeDue();
  withDb(openRemindersDb, (db) => {
    assert.deepEqual(status(db, [a.id, b.id, a2.id, b2.id]), ['missed', 'done', 'sent', 'sent']);
    const open = listReminders(db, { chatId: 1 });
    assert.equal(oneEach(open).filter((r) => r.series === a.id).length, 1, 'one of each series is shown');
    assert.equal(oneEach(open).find((r) => r.series === a.id).id, a2.id, 'the time that went, not the next');
    assert.equal(listReminders(db, { chatId: 1, all: true }).find((r) => r.id === a.id).status, 'missed', 'kept, as missed');
  });
});

test('done or skipped before it goes, the series goes on; stopped, nothing of it is left', () => {
  withDb(openRemindersDb, (db) => {
    const r = addReminder(db, { chatId: 2, text: 'Call Dad', dueTs: now() + 3600, repeat: '0 10 * * 5' });
    answer(db, r, 'cancelled');
    const [next] = listReminders(db, { chatId: 2 });
    assert.equal(next.series, r.id, 'skipped this time: the next is there');
    assert.ok(next.due_ts > r.due_ts);
    answer(db, next, 'done');
    const [third] = listReminders(db, { chatId: 2 });
    assert.equal(third.series, r.id, 'done this time: and the next');
    // One that does not repeat ends with its answer.
    const once = addReminder(db, { chatId: 2, text: 'Once', dueTs: now() + 3600 });
    answer(db, once, 'cancelled');
    assert.deepEqual(
      listReminders(db, { chatId: 2 }).map((x) => x.id),
      [third.id],
    );
    db.prepare("UPDATE reminders SET status = 'sent' WHERE id = ?").run(third.id);
    addReminder(db, { chatId: 2, text: 'Call Dad', dueTs: now() + 7 * 86400, repeat: '0 10 * * 5', series: r.id });
    assert.equal(stopSeries(db, third), 2, 'the time that went and the next');
    assert.deepEqual(listReminders(db, { chatId: 2 }), []);
  });
});

test('bc remind: done and cancel are for this time, stop ends it, and the briefing shows it once', async () => {
  const cmd = await import('../src/reminders/commands.js');
  const { id } = withDb(openRemindersDb, (db) =>
    addReminder(db, { chatId: 42, text: 'Time to go walking', dueTs: now() - 3600, repeat: DAILY }),
  );
  const { loadPlugins } = await import('../src/plugins/registry.js');
  await loadPlugins();
  const { fireDue } = await import('../src/reminders/chat.js');
  const sent = [];
  await fireDue({ send: async (c, html, o) => sent.push({ c, html, o }), sendFile: async () => {} });
  const mine = sent.find((s) => /Time to go walking/.test(s.html));
  assert.ok(mine, 'it went');
  assert.ok(JSON.stringify(mine.o.actions).includes('Stop repeating'), 'and can be stopped from where it arrives');
  const { openWatchDb } = await import('../src/watch/db.js');
  const { composeBriefing } = await import('../src/watch/briefing.js');
  const b = await withDb(openWatchDb, (db) => composeBriefing(db, 42, { terminal: true }));
  const lines = b.html.split('\n').filter((l) => /Time to go walking/.test(l));
  assert.equal(lines.length, 1, b.html);
  assert.match(lines[0], /due earlier, not marked done.*🔁 <i>at 17:25<\/i>/);
  assert.match(lines[0], new RegExp(`\\[reminder ${id}\\]`), 'the time that went');

  const done = await cmd.done(String(id), {}, {});
  assert.match(done.text, /marked done: Time to go walking\. It comes again at 17:25 \(to stop it: bc remind stop \d+\)/);
  const next = withDb(openRemindersDb, (db) => listReminders(db, { chatId: 42 }).find((r) => r.series === id));
  assert.equal(next.status, 'pending');
  await assert.rejects(
    async () =>
      cmd.stop(String(withDb(openRemindersDb, (db) => addReminder(db, { chatId: 42, text: 'Once', dueTs: now() + 60 })).id), {}, {}),
    /does not repeat/,
  );
  const stopped = await cmd.stop(String(next.id), {}, {});
  assert.match(stopped.text, /^Stopped: "Time to go walking" will not come again \(1 cancelled\)\.$/);
  assert.equal(
    withDb(openRemindersDb, (db) => listReminders(db, { chatId: 42 }).filter((r) => r.series === id).length),
    0,
  );
});

test('snoozed after it went, a time of a series makes no second next time, and is missed once the next goes', () => {
  withDb(openRemindersDb, (db) => {
    const r = addReminder(db, { chatId: 3, text: 'Stretch', dueTs: now() - 60, repeat: DAILY });
    db.prepare("UPDATE reminders SET status = 'sent' WHERE id = ?").run(r.id);
    const next = addNextRepeat(db, getReminder(db, r.id));
    assert.ok(next, 'the next time, as it went');
    // snoozed to a minute ago, so it goes again now
    db.prepare("UPDATE reminders SET status = 'pending', due_ts = ? WHERE id = ?").run(now() - 1, r.id);
  });
  takeDue();
  withDb(openRemindersDb, (db) => {
    const open = listReminders(db, { chatId: 3 });
    assert.equal(open.filter((x) => x.status === 'pending').length, 1, 'still one next time, not two');
    // snoozed past its next time: when the next goes, the snoozed one is missed
    const [first, next] = open;
    db.prepare("UPDATE reminders SET status = 'pending', due_ts = ? WHERE id = ?").run(now() + 3 * 86400, first.id);
    db.prepare('UPDATE reminders SET due_ts = ? WHERE id = ?').run(now() - 1, next.id);
  });
  takeDue();
  withDb(openRemindersDb, (db) => {
    const all = listReminders(db, { chatId: 3, all: true });
    assert.deepEqual(all.map((x) => x.status).sort(), ['missed', 'pending', 'sent']);
  });
});
