// What a check finds wrong is kept one row an outage: found again meanwhile, the row is brought
// up to date; once it works again the row is history. The owner is told as the check says (at
// once, after a few looks, only in the briefing), not in its quiet time, again when a snooze
// runs out or a reminder is due, and when it works again if they were told it did not.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { home, setUp } from './helpers.js';

const dir = home();
const root = new URL('..', import.meta.url).pathname;
const plain = () => {
  const { FORCE_COLOR: _f, CLAUDECODE: _c, ...env } = process.env;
  return { ...env, NO_COLOR: '1' };
};
const bc = (...args) => {
  const r = spawnSync(process.execPath, [`${root}bin/bc.js`, ...args], { encoding: 'utf8', env: plain() });
  return { ...r, said: r.stdout + r.stderr, json: () => JSON.parse(r.stdout) };
};
const flag = path.join(dir, 'up.flag');
const up = () => fs.writeFileSync(flag, 'x');
const down = () => fs.rmSync(flag, { force: true });
const now = () => Math.floor(Date.now() / 1000);

test('what was kept before (incidents) becomes findings: the open one stays open, the rest are over', async () => {
  await setUp({ bot: { allow: [{ id: 42, name: 'me' }] } });
  const { openAgentDb } = await import('../src/agentdb.js');
  const db = openAgentDb();
  // a database as an earlier blackcat left it: checks at step 2, with incidents
  db.exec(`CREATE TABLE IF NOT EXISTS shapes (part TEXT PRIMARY KEY, step INTEGER NOT NULL);
    INSERT INTO shapes VALUES ('checks', 2);
    CREATE TABLE checks (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER, name TEXT NOT NULL, look_for TEXT NOT NULL DEFAULT '',
      command TEXT, file TEXT, max_age TEXT, fix TEXT, tries INTEGER, wait TEXT, every TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
      state TEXT, last_run INTEGER, created_ts INTEGER NOT NULL);
    CREATE TABLE check_incidents (id INTEGER PRIMARY KEY AUTOINCREMENT, check_id INTEGER NOT NULL, ts INTEGER NOT NULL, title TEXT NOT NULL,
      summary TEXT, open INTEGER NOT NULL DEFAULT 0);`);
  db.prepare(
    `INSERT INTO checks (chat_id, name, command, every, state, created_ts) VALUES (42, 'Old', 'true', '["*/30 * * * *"]', ?, 1)`,
  ).run(JSON.stringify({ status: 'failing', since: 1000, checked: 3000, reason: 'still down', incident: 3 }));
  const inc = db.prepare('INSERT INTO check_incidents (check_id, ts, title, summary, open) VALUES (1, ?, ?, ?, ?)');
  inc.run(1000, 'Not working: it fell over', '1000: it fell over.', 0);
  inc.run(2000, 'Fixed: it fell over again', '2000: restarted.', 0);
  inc.run(3000, 'Not working: still down', '3000: still down.', 1);
  db.close();

  const { currentFindings, getCheck, openChecksDb, pastFindings } = await import('../src/checks/db.js');
  const cdb = openChecksDb();
  assert.deepEqual(
    pastFindings(cdb, 1).map((f) => [f.title, f.state, f.first_seen, f.fix_note, f.alerted]),
    [
      ['still down', 'open', 3000, null, 1],
      ['it fell over again', 'resolved', 2000, 'its fix worked', 1],
      ['it fell over', 'resolved', 1000, null, 1],
    ],
  );
  assert.equal(currentFindings(cdb, 1).length, 1);
  assert.deepEqual(getCheck(cdb, 1).state, { ok: false, checked: 3000, reason: 'still down' });
  assert.equal(getCheck(cdb, 1).wrong.open, 1);
  assert.equal(cdb.prepare("SELECT COUNT(*) FROM sqlite_master WHERE name = 'check_incidents'").pluck().get(), 0, 'the old table is gone');
  cdb.prepare('DELETE FROM check_findings').run();
  cdb.prepare('DELETE FROM checks').run();
  cdb.close();
});

// A check as the tests want it: looks at the flag file.
async function made(extra = {}) {
  const { addCheck, openChecksDb } = await import('../src/checks/db.js');
  const db = openChecksDb();
  const c = addCheck(db, { chatId: 42, name: `Web ${Math.random().toString(36).slice(2, 6)}`, command: `test -f ${flag}`, ...extra });
  return { db, id: c.id };
}
const look = async (db, id) => {
  const { getCheck } = await import('../src/checks/db.js');
  const { runCheck } = await import('../src/checks/check.js');
  const r = await runCheck(db, getCheck(db, id));
  return r.notices.map((n) => n.text);
};

test('--alert "after 3": told only when three looks in a row found it; over before that, nothing is said', async () => {
  const { db, id } = await made({ alert: { after: 3 } });
  down();
  assert.deepEqual(await look(db, id), []);
  assert.deepEqual(await look(db, id), []);
  assert.match((await look(db, id))[0], /^⚠️ Web \w+: not working\./);
  up();
  assert.match((await look(db, id))[0], /working again/, 'told it was down, so told it is up');
  // a short blip, some time later: never told, either way
  db.prepare('UPDATE check_findings SET resolved_ts = ? WHERE check_id = ?').run(now() - 3600, id);
  down();
  assert.deepEqual(await look(db, id), []);
  up();
  assert.deepEqual(await look(db, id), [], 'never told it was down: nothing to say');
  db.close();
});

test('briefing only: nothing is sent, and it is in the briefing', async () => {
  const { db, id } = await made({ alert: { at: 'briefing' } });
  down();
  assert.deepEqual(await look(db, id), []);
  const { forBriefing } = await import('../src/checks/chat.js');
  assert.ok(forBriefing().problems.some((p) => /not working since/.test(p)));
  up();
  assert.deepEqual(await look(db, id), []);
  db.close();
});

test('in the quiet time nothing is said; after it, what is still wrong is', async () => {
  const d = new Date();
  const hm = (ms) => {
    const x = new Date(ms);
    return `${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`;
  };
  const { inQuiet, parseQuiet } = await import('../src/checks/check.js');
  const around = `${hm(d - 10 * 60_000)}-${hm(+d + 10 * 60_000)}`;
  assert.equal(inQuiet(parseQuiet(around)), true);
  assert.equal(inQuiet('23:00-01:00', Math.floor(new Date('2026-10-15T00:30:00').getTime() / 1000)), true, 'past midnight');
  assert.equal(inQuiet('23:00-01:00', Math.floor(new Date('2026-10-15T12:30:00').getTime() / 1000)), false);
  assert.throws(() => parseQuiet('25:00-01:00'), /--quiet is a time of day/);

  const { db, id } = await made({ quiet: around });
  down();
  assert.deepEqual(await look(db, id), []);
  const { updateCheck } = await import('../src/checks/db.js');
  updateCheck(db, id, { quiet: null });
  assert.match((await look(db, id))[0], /not working/);
  up();
  await look(db, id);
  db.close();
});

test('--remind: told again while it stays wrong; a snooze stops that, and when it runs out it is said again', async () => {
  const { db, id } = await made({ remind: '1h' });
  const { currentFindings, snoozeFinding } = await import('../src/checks/db.js');
  down();
  assert.equal((await look(db, id)).length, 1);
  assert.deepEqual(await look(db, id), [], 'not yet');
  const f = currentFindings(db, id)[0];
  db.prepare('UPDATE check_findings SET told_ts = ? WHERE id = ?').run(now() - 3700, f.id);
  assert.match((await look(db, id))[0], /^⚠️ Web \w+: still not working, since /);
  // snoozed until it works: nothing, reminder or not
  snoozeFinding(db, f.id, null);
  db.prepare('UPDATE check_findings SET told_ts = ? WHERE id = ?').run(now() - 3700, f.id);
  assert.deepEqual(await look(db, id), []);
  // snoozed until a time that has passed: woken, and said again
  snoozeFinding(db, f.id, now() - 1);
  assert.match((await look(db, id))[0], /still not working/);
  assert.equal(currentFindings(db, id)[0].state, 'open');
  up();
  assert.match((await look(db, id))[0], /working again/);
  db.close();
});

test('back within a few minutes of working again: the same outage, opened again; later: a new one', async () => {
  const { db, id } = await made();
  const { pastFindings } = await import('../src/checks/db.js');
  down();
  await look(db, id);
  up();
  await look(db, id);
  down();
  assert.match((await look(db, id))[0], /not working/, 'said again: it was said to be working');
  const rows = pastFindings(db, id);
  assert.deepEqual(
    rows.map((f) => [f.state, f.times]),
    [['open', 2]],
  );
  up();
  await look(db, id);
  db.prepare('UPDATE check_findings SET resolved_ts = ? WHERE check_id = ?').run(now() - 3600, id);
  down();
  await look(db, id);
  assert.deepEqual(
    pastFindings(db, id).map((f) => f.state),
    ['open', 'resolved'],
  );
  up();
  await look(db, id);
  db.close();
});

test('the commands: snooze, unsnooze, fixed, fix; and the options that say when to tell', async () => {
  const { db, id } = await made({ fix: `touch ${flag}`, wait: '1s' });
  const { getCheck, updateCheck } = await import('../src/checks/db.js');
  const name = getCheck(db, id).name;
  updateCheck(db, id, { fix: 'false' }); // a fix that does not help
  const { addRule } = await import('../src/agent/permissions.js');
  addRule('allow', 'false', { via: `check ${id}` });
  down();
  assert.match((await look(db, id))[0], /not working\..* I ran `false` 2 times; it did not help\./);
  assert.match(bc('check', 'snooze', name, '--for', '4h').stdout, /^Snoozed until .*: `test -f .*` failed \(exit 1\)\./);
  assert.match(bc('check', 'list').stdout, /not working since .*, snoozed: /);
  assert.match(bc('check', 'show', name).stdout, /snoozed until /);
  const probe = JSON.parse(bc('selftest', 'check', '--json').stdout).parts[0].results.find((x) => x.name === name);
  assert.deepEqual([probe.outcome, /^not working, snoozed: /.test(probe.detail)], ['skipped', true], 'snoozed: known, not a failure');
  assert.match(bc('check', 'snooze', name, '--for', '5m').said, /at least 10m/);
  assert.match(bc('check', 'unsnooze', name).stdout, /^Not snoozed any more/);
  assert.match(bc('check', 'snooze', name, '-n', '2').said, /give a number from 1 to 1/);
  assert.match(bc('check', 'snooze', name, '--until-fixed').stdout, /^Snoozed until it works again/);
  // "I fixed it", when it is not: said so (here without waiting)
  assert.match(bc('check', 'fixed', name, '--no-wait').stdout, /still not working/);
  // its fix again, a working one this time
  updateCheck(db, id, { fix: `touch ${flag}` });
  addRule('allow', `touch ${flag}`, { via: `check ${id}` });
  assert.match(bc('check', 'fix', name).stdout, /working again/);
  assert.match(bc('check', 'fixed', name, '--no-wait').said, /working/);
  assert.match(bc('check', 'snooze', name).said, /Nothing is wrong with/);
  // changed so that it works: the look made then closes what was wrong
  updateCheck(db, id, { fix: null });
  down();
  await look(db, id);
  assert.equal(getCheck(db, id).wrong.open, 1);
  up();
  assert.match(
    bc('check', 'edit', name, '--run', `test -f ${flag}`).stdout,
    /Tested now: working\. all checks passed \(what was wrong is now over\)/,
  );
  assert.equal(getCheck(db, id).wrong, null);
  // the options
  const e = bc('check', 'edit', name, '--alert', 'after 2', '--quiet', '3:00-3:30', '--remind', '2h', '--json').json();
  assert.deepEqual([e.alert, e.quiet, e.remind], ['after 2 looks in a row find it', '03:00-03:30', '2h']);
  assert.equal(bc('check', 'edit', name, '--alert', 'after 15m', '--json').json().alert, 'once it has lasted 15m');
  assert.match(bc('check', 'edit', name, '--alert', 'sometimes').said, /--alert is one of/);
  const off = bc('check', 'edit', name, '--no-quiet', '--no-remind', '--alert', 'now', '--json').json();
  assert.deepEqual([off.alert, off.quiet, off.remind], ['at once', null, null]);
  db.close();
});

test('snoozed until tomorrow morning, when no time is given', async () => {
  const { snoozeEnd } = await import('../src/checks/commands.js');
  const at = new Date('2026-10-15T14:00:00').getTime();
  assert.equal(new Date(snoozeEnd({}, at) * 1000).toString(), new Date('2026-10-16T08:00:00').toString());
  const early = new Date('2026-10-15T06:00:00').getTime();
  assert.equal(new Date(snoozeEnd({}, early) * 1000).toString(), new Date('2026-10-15T08:00:00').toString());
  assert.equal(snoozeEnd({ untilFixed: true }, at), null);
});

test('in the bot: an alert has buttons; snooze offers how long; "I fixed it" looks and says so', async () => {
  const { desk, resetDesk, setCarrier, ui } = await import('../src/channels/desk.js');
  const { installChecks, findingButtons } = await import('../src/checks/chat.js');
  const { currentFindings, getCheck, pastFindings } = await import('../src/checks/db.js');
  // (a fix it may not run: the finding stays open)
  const { db, id } = await made({ fix: 'echo not permitted' });
  down();
  await look(db, id);
  const f = currentFindings(db, id)[0];
  assert.deepEqual(
    findingButtons(f.id, true)
      .rows.flat()
      .map((b) => b.label),
    ['😴 Snooze', '🛠 I fixed it', '🔁 Try the fix again'],
  );
  assert.deepEqual(
    findingButtons(f.id, false)
      .rows.flat()
      .map((b) => b.label),
    ['😴 Snooze', '🛠 I fixed it'],
  );
  resetDesk();
  const said = [];
  setCarrier({
    can: { buttons: true, edit: true },
    label: 'a test',
    send: async (_chat, m) => (said.push({ text: m.text, buttons: m.actions?.flat().map((a) => a.label) ?? [] }), said.length),
    edit: async (_chat, _ref, m) => void said.push({ text: m.text, edited: true }),
    setActions: async () => {},
    remove: async () => {},
    toast: async () => {},
  });
  installChecks(ui);
  const tap = (code) => desk.action({ chat: 42, who: 'me', id: `cf:${f.id}:${code}`, ref: said.length });
  await tap('s');
  assert.deepEqual(said.at(-1).buttons, ['1 hour', '4 hours', 'Until tomorrow morning', 'Until it works again']);
  await tap('s4');
  assert.match(said.at(-1).text, /snoozed until .*\. I'll tell you when it works again\./);
  assert.equal(currentFindings(db, id)[0].state, 'snoozed');
  up();
  await tap('x');
  assert.match(said.at(-1).text, /^✅ Web \w+: working again\./);
  assert.equal(getCheck(db, id).wrong, null);
  assert.equal(pastFindings(db, id)[0].state, 'resolved');
  db.close();
});
