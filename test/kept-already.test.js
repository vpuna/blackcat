// The same thing kept twice: on two lists, or on a list and as a reminder. Found by its words,
// with no model: what is added by hand is not added, and said; what a watch adds is kept, and
// marked "may be the same as". The case that started it: one school programme, kept three times.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { home, setUp } from './helpers.js';

home();
await setUp({ bot: { token: 't', allow: [{ id: 42, name: 'me' }] } });
const root = new URL('..', import.meta.url).pathname;
const bc = (args, env = {}) => {
  const { FORCE_COLOR: _f, CLAUDECODE: _c, ...rest } = process.env;
  const r = spawnSync(process.execPath, [`${root}bin/bc.js`, ...args], { encoding: 'utf8', env: { ...rest, NO_COLOR: '1', ...env } });
  return { ...r, said: r.stdout + r.stderr };
};
const { alike, commonWords, meaningWords } = await import('../src/plugins/same.js');

test('two things look the same by the words that carry their meaning, not by the words every entry has', () => {
  assert.deepEqual(
    [...meaningWords("Register Leo for the Chess Clubs today, Maya's leaflet")],
    ['register', 'leo', 'chess', 'club', 'maya', 'leaflet'],
  );
  const notice = 'Chess Club places for young players (optional)';
  assert.ok(alike(notice, 'Register Leo for the Chess Club places today'));
  assert.ok(alike(notice, 'Register Leo for the Chess Club (young players, 120 a child, closes Fri 23 Oct)'));
  assert.ok(alike('Book the car service', "Book the car's service"));
  // A name found in many entries is not enough with one other word.
  const titles = [
    ...['dentist', 'piano', 'tennis', 'swimming', 'reading', 'football'].map((t) => `Leo: ${t}`),
    ...['keys', 'umbrella', 'tea', 'gloves', 'scarf', 'bread'].map((t) => `Maya: ${t}`),
  ];
  const common = commonWords(titles);
  assert.ok(common.has('leo') && common.has('maya'));
  assert.ok(!alike('Talk to Leo tonight (with Maya)', 'Register Leo for the Chess Club, Maya sent it', common));
  assert.ok(!alike('Message the swim school: Leo cannot come today', 'Take Leo to swimming at 3:30', common));
  assert.ok(!alike('Pay the electricity bill', 'Book the dentist'));
});

test('added by hand: a reminder or a list entry that is kept already is not added, and what it looks like is said', () => {
  assert.equal(bc(['watch', 'add', 'School notices']).status, 0, 'a list to add to');
  let r = bc(['watch', 'add-item', 'School notices', '--title', 'Chess Club places for young players (optional)', '--json']);
  assert.equal(r.status, 0, r.said);
  const notice = JSON.parse(r.stdout).id;

  r = bc(['remind', 'add', 'Register Leo for the Chess Club (young players, closes Fri 23 Oct)', '--in', '1d']);
  assert.notEqual(r.status, 0);
  assert.match(r.said, /Not set: it looks like what is kept already:/);
  assert.match(r.said, new RegExp(`#${notice} on School notices: Chess Club places for young players`));
  assert.match(r.said, /add it anyway with --anyway/);
  r = bc(['remind', 'add', 'Register Leo for the Chess Club (young players, closes Fri 23 Oct)', '--in', '1d', '--anyway', '--json']);
  assert.equal(r.status, 0, r.said);
  const reminder = JSON.parse(r.stdout).id;

  r = bc(['watch', 'add-item', 'todo', '--title', 'Register Leo for the Chess Club places today']);
  assert.notEqual(r.status, 0);
  assert.match(r.said, /Not added: it looks like what is kept already:/);
  assert.match(r.said, new RegExp(`reminder ${reminder}: Register Leo`), 'a reminder counts as kept');
  assert.match(r.said, new RegExp(`#${notice} on School notices`));
  // something else altogether is added at once
  assert.equal(bc(['watch', 'add-item', 'todo', '--title', 'Renew the car insurance']).status, 0);
});

test('added by a watch: kept, and marked "may be the same as", in the list, the card and the briefing', async () => {
  const { addItem, findWatch, getItem, noteSameAs, openWatchDb } = await import('../src/watch/db.js');
  const { loadPlugins } = await import('../src/plugins/registry.js');
  await loadPlugins();
  const db = openWatchDb();
  const todo = findWatch(db, 'todo');
  const made = addItem(db, { watchId: todo.id, title: 'Register Leo for the Chess Club by Friday', msgId: 'm-chess' });
  const other = addItem(db, { watchId: todo.id, title: 'Water the plants', msgId: 'm-plants' });
  await noteSameAs(db, [made, other]);
  const marked = JSON.parse(getItem(db, made.id).same_as);
  assert.deepEqual(marked.map((k) => k.kind).sort(), ['list', 'reminder']);
  assert.equal(getItem(db, other.id).same_as, null);
  db.close();
  const shown = JSON.parse(bc(['watch', 'show', 'todo', '--json']).stdout).items.find((i) => i.id === made.id);
  assert.equal(shown.mayBeSameAs[0].where, 'School notices');
  assert.match(bc(['watch', 'show', 'todo']).stdout, /⚠ may be the same as #\d+ on School notices/);
  assert.match(bc(['watch', 'briefing', '--print', '--peek']).stdout, /may be the same as #\d+ on School notices/);
});

test('every watch is shown, with what is on the other lists, a line of what each is about and the reminders the owner set', async () => {
  const { elsewhereText } = await import('../src/watch/collect.js');
  const { findWatch, openWatchDb, updateItem, listItems } = await import('../src/watch/db.js');
  const db = openWatchDb();
  const school = findWatch(db, 'School notices');
  const it = listItems(db, school.id, { status: 'new,kept' })[0];
  updateItem(db, it.id, { summary: 'Register at chessclub.example by Friday, 120 a child.' });
  const text = elsewhereText(db, findWatch(db, 'todo'));
  assert.match(text, /\[School notices\] Chess Club places for young players \(optional\): Register at chessclub\.example/);
  assert.match(text, /\[a reminder they set, \d{4}-\d{2}-\d{2}\] Register Leo for the Chess Club/);
  db.close();
});

test('what every list says about something: watch find', () => {
  const r = bc(['watch', 'find', 'chess']);
  assert.match(r.stdout, /Chess Club places for young players \(optional\) · School notices/);
  assert.match(r.stdout, /Register Leo for the Chess Club by Friday · Things I need to do/);
  assert.match(bc(['watch', 'find', 'zebra']).stdout, /Nothing on any list says "zebra"/);
  assert.equal(JSON.parse(bc(['watch', 'show', 'todo', '--find', 'chess', '--json']).stdout).items.length, 1);
});

test('the agent is never given more than it can take in at once: it is told to ask for less', () => {
  for (let k = 0; k < 120; k++)
    bc(['watch', 'add-item', 'School notices', '--title', `Notice ${k} ${'about a thing of the school '.repeat(8)}`, '--anyway']);
  const owner = bc(['watch', 'show', 'School notices', '--json']);
  assert.equal(owner.status, 0, 'the owner gets all of it');
  assert.ok(owner.stdout.length > 25_000);
  const agent = bc(['watch', 'show', 'School notices', '--json'], { BLACKCAT_CALLER: 'agent' });
  assert.notEqual(agent.status, 0);
  assert.match(agent.stdout, /Too long to give at once \(\d+ characters\): ask for less/);
  assert.equal(bc(['watch', 'show', 'School notices', '--find', 'Notice 7', '--json'], { BLACKCAT_CALLER: 'agent' }).status, 0);
});
