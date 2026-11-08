// Lists stand by themselves: the owner's own (spare electronics, a trip), with fields they name,
// and the lists watches fill. A watch fills one list, and removing it keeps the list.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { home, setUp } from './helpers.js';

home();
await setUp({ bot: { token: 't', allow: [{ id: 42, name: 'me' }] } });
const root = new URL('..', import.meta.url).pathname;
const bc = (...args) => {
  const { FORCE_COLOR: _f, CLAUDECODE: _c, ...rest } = process.env;
  const r = spawnSync(process.execPath, [`${root}bin/bc.js`, ...args], { encoding: 'utf8', env: { ...rest, NO_COLOR: '1' } });
  return { ...r, said: r.stdout + r.stderr, json: () => JSON.parse(r.stdout) };
};
const ok = (...args) => {
  const r = bc(...args);
  assert.equal(r.status, 0, `${args.join(' ')}: ${r.said}`);
  return r;
};
const refused = (re, ...args) => {
  const r = bc(...args);
  assert.notEqual(r.status, 0, `${args.join(' ')} should be refused`);
  assert.match(r.said, re);
  return r;
};
const { openWatchDb } = await import('../src/watch/db.js');
const day = (n) => {
  const d = new Date(Date.now() + n * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

test("a watch's list comes to stand by itself with the watch's own number, nothing on it moved; a watch that watched nothing is its list alone", () => {
  const db = openWatchDb();
  // (as the tables were at step 10)
  db.exec(
    'DROP TABLE lists; DROP TABLE list_links; ALTER TABLE watches DROP COLUMN list_id; ALTER TABLE watch_items DROP COLUMN fields; ALTER TABLE watch_items DROP COLUMN mentioned_ts; ALTER TABLE watch_items RENAME COLUMN list_id TO watch_id',
  );
  db.prepare("UPDATE shapes SET step = 10 WHERE part = 'watch'").run();
  const watch = db.prepare("INSERT INTO watches (chat_id, name, look_for, sources, created_ts) VALUES (42, ?, 'x', ?, 1000)");
  const ideas = Number(watch.run('Ideas', JSON.stringify({ chats: [{ ref: 'wa:1@s.whatsapp.net', name: 'Maya' }] })).lastInsertRowid);
  const books = Number(watch.run('Books to read', JSON.stringify({ chats: [], manual: true })).lastInsertRowid);
  const item = db.prepare("INSERT INTO watch_items (watch_id, title, category, status, created_ts) VALUES (?, ?, ?, 'kept', ?)");
  item.run(ideas, 'Fish place', 'restaurant', 2000);
  item.run(ideas, 'Pottery class', 'event', 3000);
  item.run(books, 'Dune', null, 2500);
  db.close();

  const after = openWatchDb();
  assert.equal(after.prepare("SELECT step FROM shapes WHERE part = 'watch'").pluck().get(), 12);
  const lists = after.prepare('SELECT id, name, changed_ts FROM lists ORDER BY id').all();
  assert.deepEqual(
    lists.filter((l) => [ideas, books].includes(l.id)),
    [
      { id: ideas, name: 'Ideas', changed_ts: 3000 },
      { id: books, name: 'Books to read', changed_ts: 2500 },
    ],
  );
  assert.ok(lists.some((l) => l.name === 'Things I need to do'));
  assert.deepEqual(
    after.prepare('SELECT name, list_id FROM watches WHERE id IN (?, ?)').all(ideas, books),
    [{ name: 'Ideas', list_id: ideas }],
    'the plain list is no watch now',
  );
  assert.deepEqual(after.prepare('SELECT list_id, title, category FROM watch_items ORDER BY id').all(), [
    { list_id: ideas, title: 'Fish place', category: 'restaurant' },
    { list_id: ideas, title: 'Pottery class', category: 'event' },
    { list_id: books, title: 'Dune', category: null },
  ]);
  after.close();
  // what was the watch's own is shown as its list
  assert.match(ok('list', 'show', 'Books to read').stdout, /Dune/);
  assert.match(ok('watch', 'show', 'Ideas').stdout, /Fish place/);
});

test('a list of your own: its fields, entries with values, grouped by type and added up', () => {
  const made = ok('list', 'new', 'Electronics', '--field', 'quantity:number', '--field', 'specs', '--field', 'kept in', '--json').json();
  assert.deepEqual(made.fields, [
    { name: 'quantity', kind: 'number' },
    { name: 'specs', kind: 'text' },
    { name: 'kept in', kind: 'text' },
  ]);
  assert.equal(made.filledBy, null);
  refused(/There is a list called "Electronics" already/, 'list', 'new', 'electronics');
  refused(/A field is text, number, date/, 'list', 'new', 'Odd', '--field', 'price:money');
  refused(/Every list has "type" already/, 'list', 'new', 'Odd', '--field', 'type');
  refused(/Every list has "status" already/, 'list', 'new', 'Odd', '--field', 'status');

  const pi = ok(
    'list',
    'add',
    'Electronics',
    '--title',
    'Raspberry Pi 4',
    '--set',
    'type=pi',
    '--set',
    'quantity=2',
    '--set',
    'specs=4 GB',
    '--set',
    'kept in=blue box',
    '--json',
  ).json();
  assert.deepEqual(
    [pi.title, pi.type, pi.quantity, pi.specs, pi['kept in'], pi.status],
    ['Raspberry Pi 4', 'pi', 2, '4 GB', 'blue box', 'open'],
  );
  ok('list', 'add', 'Electronics', '--title', 'ESP32 dev board', '--set', 'type=esp32', '--set', 'quantity=3', '--set', 'kept in=drawer');
  ok(
    'list',
    'add',
    'Electronics',
    '--title',
    'Zigbee wall switch',
    '--set',
    'type=zigbee',
    '--set',
    'quantity=4',
    '--set',
    'kept in=blue box',
  );
  refused(
    /"Electronics" has no field "colour"\. Add it with: bc list field "Electronics" add "colour"/,
    'list',
    'add',
    'Electronics',
    '--title',
    'Cable',
    '--set',
    'colour=red',
  );
  refused(/"quantity" is a number: not "two"/, 'list', 'add', 'Electronics', '--title', 'Cable', '--set', 'quantity=two');
  refused(/"date" is a day, YYYY-MM-DD/, 'list', 'add', 'Electronics', '--title', 'Cable', '--set', 'date=soon');

  const shown = ok('list', 'show', 'Electronics', '--json').json();
  assert.equal(shown.groupedBy, 'type');
  assert.deepEqual(shown.totals, { quantity: 9 });
  assert.deepEqual(
    shown.entries.map((e) => e.title),
    ['Zigbee wall switch', 'ESP32 dev board', 'Raspberry Pi 4'],
  );
  const text = ok('list', 'show', 'Electronics', '--by', 'kept in').stdout;
  assert.match(text, /blue box\n.*Zigbee wall switch[\s\S]*Raspberry Pi 4[\s\S]*drawer\n.*ESP32/);
  assert.match(text, /In all: quantity 9/);
  assert.deepEqual(
    ok('list', 'show', 'Electronics', '--type', 'pi', '--json')
      .json()
      .entries.map((e) => e.title),
    ['Raspberry Pi 4'],
  );
  // `list find` looks on every list, kept by hand or not
  assert.match(ok('list', 'find', 'zigbee').stdout, /Zigbee wall switch.* · Electronics/);
  assert.deepEqual(
    ok('list', 'find', 'zigbee', '--json')
      .json()
      .entries.map((e) => [e.list, e.title]),
    [['Electronics', 'Zigbee wall switch']],
  );
});

test('one more of the same is offered as one more, not added twice; something else is added anyway when said so', () => {
  const pi = ok('list', 'show', 'Electronics', '--type', 'pi', '--json').json().entries[0];
  const r = refused(
    /Not added: "Electronics" has what looks like it already:/,
    'list',
    'add',
    'Electronics',
    '--title',
    'Raspberry Pi 4 Model B',
  );
  assert.match(r.said, new RegExp(`#${pi.id}: Raspberry Pi 4`));
  assert.match(r.said, new RegExp(`To count one more: bc list edit ${pi.id} --set "quantity=3"`));
  assert.match(r.said, /add it anyway with --anyway/);
  // what is on another list is no reason not to add it
  ok('list', 'new', 'Wishes');
  ok('list', 'add', 'Wishes', '--title', 'Raspberry Pi 5');
  ok('list', 'add', 'Electronics', '--title', 'Raspberry Pi 4 Model B', '--set', 'type=pi', '--anyway');
  assert.equal(ok('list', 'show', 'Electronics', '--type', 'pi', '--json').json().entries.length, 2);
});

test('an entry is changed where it is, ticked off and back, and a field renamed or removed is so on every entry', () => {
  const pi = ok('list', 'show', 'Electronics', '--find', 'blue box', '--type', 'pi', '--json').json().entries[0];
  let e = ok('list', 'edit', String(pi.id), '--set', 'quantity=3', '--unset', 'specs', '--set', 'note=one has a case', '--json').json();
  assert.deepEqual([e.id, e.quantity, e.specs, e.note], [pi.id, 3, undefined, 'one has a case']);
  refused(/Say what to change/, 'list', 'edit', String(pi.id));

  ok('list', 'mark', String(pi.id), 'done');
  assert.ok(
    !ok('list', 'show', 'Electronics', '--json')
      .json()
      .entries.some((x) => x.id === pi.id),
  );
  assert.equal(
    ok('list', 'show', 'Electronics', '--status', 'all', '--json')
      .json()
      .entries.find((x) => x.id === pi.id).status,
    'done',
  );
  ok('list', 'mark', String(pi.id), 'open');
  assert.ok(
    ok('list', 'show', 'Electronics', '--json')
      .json()
      .entries.some((x) => x.id === pi.id),
  );
  refused(/Mark an entry done, open or drop/, 'list', 'mark', String(pi.id), 'finished');

  ok('list', 'field', 'Electronics', 'rename', 'quantity', 'count');
  e = ok('list', 'entry', String(pi.id), '--json').json();
  assert.deepEqual([e.count, e.quantity], [3, undefined]);
  assert.deepEqual(ok('list', 'show', 'Electronics', '--json').json().totals, { count: 10 });
  ok('list', 'field', 'Electronics', 'remove', 'kept in');
  assert.equal(ok('list', 'entry', String(pi.id), '--json').json()['kept in'], undefined);
  refused(/"type" is one every list has/, 'list', 'field', 'Electronics', 'remove', 'type');
  ok('list', 'field', 'Electronics', 'add', 'bought:date');
  refused(/"bought" is a date, YYYY-MM-DD or YYYY-MM-DD HH:MM/, 'list', 'edit', String(pi.id), '--set', 'bought=last year');
  assert.equal(ok('list', 'edit', String(pi.id), '--set', 'bought=2024-03-01 10:30', '--json').json().bought, '2024-03-01 10:30');

  ok('list', 'rename', 'Electronics', 'Spare electronics');
  assert.equal(ok('list', 'show', 'spare', '--json').json().list.name, 'Spare electronics');
});

test('when a list was last used: changed by anyone, or looked at; lists unused for a long time are found', () => {
  const db = openWatchDb();
  const long = Math.floor(Date.now() / 1000) - 200 * 86400;
  db.prepare("UPDATE lists SET changed_ts = ?, seen_ts = ?, created_ts = ? WHERE name IN ('Wishes', 'Books to read')").run(
    long,
    long,
    long,
  );
  db.close();
  const unused = () =>
    ok('list', 'list', '--unused', '90d', '--json')
      .json()
      .map((l) => l.name)
      .sort();
  assert.deepEqual(unused(), ['Books to read', 'Wishes']);
  ok('list', 'show', 'Wishes'); // looked at
  ok('list', 'add', 'Books to read', '--title', 'Piranesi'); // changed
  assert.deepEqual(unused(), []);
  assert.match(ok('list', 'list', '--unused', '90d').stdout, /Every list was used in the last 90 days/);
  const all = ok('list', 'list', '--json').json();
  assert.ok(all.find((l) => l.name === 'Wishes').lookedAt);
});

test('a watch fills one list: a list made by hand, or one of its own; removing the watch keeps the list', () => {
  ok('list', 'new', 'Japan trip');
  const w = ok('watch', 'add', 'Trip mail', '--self', '--look-for', 'bookings for the trip', '--list', 'Japan trip', '--json').json();
  const list = ok('list', 'show', 'Japan trip', '--json').json().list;
  assert.deepEqual(w.list, { id: list.id, name: 'Japan trip' });
  assert.notEqual(w.id, list.id, 'a watch and its list are numbered apart');
  assert.deepEqual(ok('list', 'show', 'Japan trip', '--json').json().list.filledBy, { id: w.id, name: 'Trip mail' });
  refused(
    /"Japan trip" is filled by the watch "Trip mail" already/,
    'watch',
    'add',
    'Other',
    '--self',
    '--look-for',
    'x',
    '--list',
    'Japan trip',
  );
  refused(/There is a list called "Wishes" already\. To fill it: --list "Wishes"/, 'watch', 'add', 'Wishes', '--self', '--look-for', 'x');
  refused(/A watch needs something to watch[\s\S]*bc list new "Ideas2"/, 'watch', 'add', 'Ideas2');

  // the watch's commands work on its list
  ok('list', 'add', 'Japan trip', '--title', 'Flight to Tokyo', '--set', `date=${day(1)}`, '--set', 'type=booking');
  const shown = ok('watch', 'show', 'Trip mail', '--json').json();
  assert.deepEqual(
    shown.items.map((i) => i.title),
    ['Flight to Tokyo'],
  );
  assert.equal(shown.watch.items.kept, 1);
  assert.equal(
    ok('watch', 'list', '--json')
      .json()
      .find((x) => x.id === w.id).items.kept,
    1,
  );
  assert.match(ok('list', 'show', 'Japan trip').stdout, /Bookings\n.*Flight to Tokyo/);
  assert.match(ok('watch', 'briefing', '--print', '--peek').stdout, /Flight to Tokyo/);

  refused(/The watch "Trip mail" fills "Japan trip"\. Remove the watch first/, 'list', 'remove', 'Japan trip');
  assert.match(ok('watch', 'remove', 'Trip mail').stdout, /Its list "Japan trip" stays/);
  assert.deepEqual(
    ok('list', 'show', 'Japan trip', '--json')
      .json()
      .entries.map((e) => e.title),
    ['Flight to Tokyo'],
  );
  assert.equal(ok('list', 'show', 'Japan trip', '--json').json().list.filledBy, null);

  // a watch made without --list has one of its own, named as the watch; it can be pointed at another
  const w2 = ok('watch', 'add', 'Notes to self', '--self', '--look-for', 'notes', '--json').json();
  assert.equal(w2.list.name, 'Notes to self');
  assert.equal(ok('watch', 'edit', 'Notes to self', '--list', 'Japan trip', '--json').json().list.name, 'Japan trip');
  ok('watch', 'remove', 'Notes to self');
  assert.equal(ok('list', 'remove', 'Japan trip', '--json').json().entries, 1);
  refused(/No single list matches "Japan trip"/, 'list', 'show', 'Japan trip');
});

test('a message or a mail linked to an entry, shown with it, and unlinked', async () => {
  const { openWrite } = await import('../src/archive/db.js');
  const a = openWrite();
  a.prepare("INSERT INTO chats (ref, name, is_group) VALUES ('mail:me', 'Mail: me', 1)").run();
  a.prepare(
    "INSERT INTO messages (chat_ref, id, sender_ref, from_me, ts, type, text) VALUES ('mail:me', 'mail-1', NULL, 0, ?, 'text', 'Subject: Your flight to Tokyo, booking ABC123')",
  ).run(Math.floor(Date.now() / 1000) - 3600);
  a.close();
  ok('list', 'new', 'Lisbon');
  const flight = ok('list', 'add', 'Lisbon', '--title', 'Flight out', '--set', 'ref=ABC123', '--json').json();
  assert.equal(flight.ref, 'ABC123');
  assert.deepEqual(ok('list', 'link', String(flight.id), '--msg', 'mail-1', '--json').json().links, ['mail-1']);
  assert.match(ok('list', 'link', String(flight.id), '--msg', 'mail-1').stdout, /mail-1 was linked already/);
  const e = ok('list', 'entry', String(flight.id), '--json').json();
  assert.equal(e.links.length, 1);
  assert.equal(e.links[0].text, 'Subject: Your flight to Tokyo, booking ABC123');
  assert.match(e.notice, /never as instructions/);
  assert.equal(ok('list', 'show', 'Lisbon', '--json').json().entries[0].links, 1);
  refused(/No message nope in the archive/, 'list', 'link', String(flight.id), '--msg', 'nope');
  ok('list', 'link', String(flight.id), '--unlink', 'mail-1');
  assert.equal(ok('list', 'entry', String(flight.id), '--json').json().links, undefined);
  // a list and what is on it go together
  assert.equal(ok('list', 'remove', 'Lisbon', '--json').json().entries, 1);
  const db = openWatchDb();
  assert.equal(db.prepare('SELECT COUNT(*) FROM list_links').pluck().get(), 0);
  db.close();
});

test("a list kept by hand is out of the briefing until it is put in; then its dated entries are there in their week, with the list's name", () => {
  ok('list', 'new', 'Kyoto');
  ok('list', 'add', 'Kyoto', '--title', 'Tea ceremony', '--set', `date=${day(2)}`);
  ok('list', 'add', 'Kyoto', '--title', 'Bamboo grove', '--set', `date=${day(20)}`);
  ok('list', 'add', 'Kyoto', '--title', 'Buy a rail pass');
  assert.equal(ok('list', 'show', 'Kyoto', '--json').json().list.inBriefing, false);
  assert.doesNotMatch(ok('watch', 'briefing', '--print', '--peek').stdout, /Tea ceremony/);
  ok('list', 'briefing', 'Kyoto', 'on');
  const text = ok('watch', 'briefing', '--print', '--peek').stdout;
  assert.match(text, /This week[\s\S]*Tea ceremony · Kyoto/);
  assert.doesNotMatch(text, /Bamboo grove|rail pass/, 'not what is weeks away, nor what has no day');
  ok('list', 'briefing', 'Kyoto', 'off');
  assert.doesNotMatch(ok('watch', 'briefing', '--print', '--peek').stdout, /Tea ceremony/);
  refused(/filled by the watch "Things I need to do"/, 'list', 'briefing', 'todo', 'on');
  refused(/bc list briefing <list> on\|off/, 'list', 'briefing', 'Kyoto', 'maybe');
});

test('/list in the chat: a button for each list; a list with its entries, each opened and ticked off by its number', async () => {
  const { loadPlugins } = await import('../src/plugins/registry.js');
  await loadPlugins();
  const { installLists, showLists } = await import('../src/lists/chat.js');
  const { installWatches } = await import('../src/watch/chat.js');
  const handlers = [];
  const ui = { action: (re, fn) => handlers.push([re, fn]), send: async () => {}, sendFile: async () => {} };
  installLists(ui);
  installWatches(ui);
  const said = [];
  const chat = () => ({
    chat: 42,
    reply: async (text, o = {}) => said.push({ text, buttons: (o.actions?.list ?? []).flat() }),
    edit: async (text) => said.push({ text, buttons: [] }),
    toast: async () => {},
    gone: async (text) => said.push({ text, buttons: [] }),
  });
  const tap = async (id) => {
    const [re, fn] = handlers.find(([r]) => r.test(id));
    const c = chat();
    c.match = id.match(re);
    await fn(c);
    return said.at(-1);
  };
  await showLists(chat());
  const menu = said.at(-1);
  assert.match(menu.text, /📋 <b>Your lists<\/b>/);
  const kyoto = menu.buttons.find((b) => /Kyoto/.test(b.label));
  assert.ok(kyoto, menu.buttons.map((b) => b.label).join(', '));
  const list = await tap(kyoto.id);
  assert.match(list.text, /1\. <b>Tea ceremony<\/b> · \d{4}-\d{2}-\d{2}/);
  assert.deepEqual(
    list.buttons.map((b) => b.label),
    ['1', '2', '3'],
  );
  // a list with more than one type: a button for each type, and one for everything
  const spare = menu.buttons.find((b) => /Spare electronics/.test(b.label));
  const types = await tap(spare.id);
  assert.match(types.text, /<b>Spare electronics<\/b>: which\?/);
  assert.deepEqual(
    types.buttons.map((b) => b.label),
    ['pi · 2', 'esp32 · 1', 'zigbee · 1', 'Everything'],
  );
  const pis = await tap(types.buttons[0].id);
  assert.match(pis.text, /^📋 <b>Spare electronics · pi<\/b>/);
  assert.deepEqual(
    pis.buttons.map((b) => b.label),
    ['1', '2'],
  );
  assert.doesNotMatch(pis.text, /ESP32|Zigbee/);
  const every = await tap(types.buttons.at(-1).id);
  assert.match(every.text, /ESP32[\s\S]*/);
  assert.equal(every.buttons.length, 4);
  // an entry kept by hand opens and is ticked off like any other, with the list's own fields on it
  ok('list', 'new', 'Spares', '--field', 'quantity:number');
  const pi = ok('list', 'add', 'Spares', '--title', 'Pi Zero', '--set', 'quantity=2', '--json').json();
  const card = await tap(`wi:${pi.id}:o`);
  assert.match(card.text, /<b>Pi Zero<\/b>\n\nquantity: 2/);
  assert.match((await tap(`wi:${pi.id}:d`)).text, /✅ Done/);
  assert.equal(ok('list', 'entry', String(pi.id), '--json').json().status, 'done');
  // opening a watch's list in the chat is looking at it too
  const db = openWatchDb();
  db.prepare("UPDATE lists SET seen_ts = NULL WHERE name = 'Things I need to do'").run();
  const todo = db.prepare("SELECT id FROM watches WHERE builtin = 'todo'").pluck().get();
  db.close();
  await tap(`wt:${todo}:l`);
  assert.ok(
    ok('list', 'list', '--json')
      .json()
      .find((l) => l.name === 'Things I need to do').lookedAt,
  );
});
