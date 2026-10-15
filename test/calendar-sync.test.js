// The calendar is fetched every half hour and is nearly always the same as last time.
// Recognising that must not depend on the order the server happens to send it in.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { home } from './helpers.js';

home();
const { fingerprint } = await import('../plugins/calendar/plugin.js');

const event = (uid, title, stamp, extra = []) => [
  'BEGIN:VEVENT',
  `DTSTAMP:${stamp}`,
  `UID:${uid}`,
  'DTSTART:20261009T170000Z',
  'DTEND:20261009T180000Z',
  `SUMMARY:${title}`,
  ...extra,
  'END:VEVENT',
];
const feed = (events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'X-WR-CALNAME:Family', ...events.flat(), 'END:VCALENDAR', ''].join('\r\n');
const who = ['ATTENDEE;CN=A:mailto:a@example.com', 'ATTENDEE;CN=B:mailto:b@example.com'];

test('the same calendar is recognised whatever order it arrives in, and a real change is not missed', () => {
  const a = feed([event('1', 'Swimming', '20261005T040000Z', who), event('2', 'Dentist', '20261005T040000Z')]);
  // fetched again: every event stamped with the new time, events and lines in another order
  const again = feed([event('2', 'Dentist', '20261005T043000Z'), event('1', 'Swimming', '20261005T043000Z', [...who].reverse())]);
  assert.notEqual(a, again);
  assert.equal(fingerprint(again), fingerprint(a));
  assert.equal(fingerprint(a.replace(/\r\n/g, '\n')), fingerprint(a), 'line endings do not matter');

  const changes = {
    'a new event': feed([
      event('1', 'Swimming', '20261005T040000Z', who),
      event('2', 'Dentist', '20261005T040000Z'),
      event('3', 'Parents evening', '20261005T040000Z'),
    ]),
    'an event removed': feed([event('1', 'Swimming', '20261005T040000Z', who)]),
    'a title changed': feed([event('1', 'Swimming gala', '20261005T040000Z', who), event('2', 'Dentist', '20261005T040000Z')]),
    'a time changed': a.replace('DTSTART:20261009T170000Z', 'DTSTART:20261009T173000Z'),
    'a guest added': feed([
      event('1', 'Swimming', '20261005T040000Z', [...who, 'ATTENDEE;CN=C:mailto:c@example.com']),
      event('2', 'Dentist', '20261005T040000Z'),
    ]),
  };
  for (const [what, text] of Object.entries(changes)) assert.notEqual(fingerprint(text), fingerprint(a), what);
});

test("an event says who it is from and who else is in it; one of the owner's own does not say it is from them", async () => {
  const { readCalendar } = await import('../plugins/calendar/ics.js');
  const own = (events) =>
    ['BEGIN:VCALENDAR', 'VERSION:2.0', 'X-WR-CALNAME:me@example.com', ...events.flat(), 'END:VCALENDAR', ''].join('\r\n');
  const at = Date.UTC(2026, 9, 9);
  const read = (text) => Object.fromEntries(readCalendar(text, 'mine', at, at + 86400000).map((e) => [e.title, e]));
  const me = 'ATTENDEE;CN=me@example.com;PARTSTAT=ACCEPTED:mailto:me@example.com';
  const e = read(
    own([
      // an invitation from someone else, with a room booked and a colleague invited
      event('1', 'Budget review', '20261005T040000Z', [
        'ORGANIZER;CN=Priya Nair:mailto:Priya@Work.example',
        me,
        'ATTENDEE;CN=Tom Reed:mailto:tom@work.example',
        'ATTENDEE;CUTYPE=ROOM;CN=Room 4:mailto:room4@work.example',
      ]),
      // an organiser known only by address
      event('2', 'Service visit', '20261005T040000Z', ['ORGANIZER:mailto:bookings@garage.example', me]),
      // the owner's own event, with two people invited
      event('3', 'Dinner', '20261005T040000Z', [
        'ORGANIZER;CN=me@example.com:mailto:me@example.com',
        me,
        'ATTENDEE;CN=Maya:mailto:maya@example.com',
        'ATTENDEE:mailto:sam@example.com',
      ]),
      // nobody else in it
      event('4', 'Gym', '20261005T040000Z'),
      // more people than are worth naming
      event('5', 'All hands', '20261005T040000Z', [
        'ORGANIZER;CN=Office:mailto:office@work.example',
        ...Array.from({ length: 12 }, (_, i) => `ATTENDEE;CN=Person ${i}:mailto:p${i}@work.example`),
      ]),
    ]),
  );
  assert.deepEqual(
    [e['Budget review'].from, e['Budget review'].with, e['Budget review'].others],
    [{ name: 'Priya Nair', email: 'priya@work.example' }, ['Tom Reed'], 0],
  );
  assert.deepEqual([e['Service visit'].from, e['Service visit'].with], [{ name: null, email: 'bookings@garage.example' }, []]);
  assert.deepEqual([e.Dinner.from, e.Dinner.with], [null, ['Maya', 'sam@example.com']]);
  assert.deepEqual([e.Gym.from, e.Gym.with, e.Gym.others], [null, [], 0]);
  assert.deepEqual([e['All hands'].with.length, e['All hands'].others], [8, 4]);
  // a shared calendar is not a person: an event on it is not "from" the calendar
  const shared = read(feed([event('6', 'Swimming', '20261005T040000Z', ['ORGANIZER;CN=Family:mailto:abc123@group.calendar.google.com'])]));
  assert.equal(shared.Swimming.from, null);
});

test('the agenda shows who an appointment is from or with, and one is found by a person in it', async () => {
  const { spawnSync } = await import('node:child_process');
  const { save } = await import('../src/config.js');
  save({
    plugins: {
      enabled: ['calendar', 'mail'],
      settings: {
        calendar: { calendars: { mine: { title: 'me@example.com' } } },
        mail: { accounts: { home: { address: 'me@example.com', host: 'imap.example.com', days: 30 } } },
      },
    },
  });
  // what the owner's mail knows: the garage writes under a name; so, once, did somebody else from that address
  const { loadPlugins, makeCtx } = await import('../src/plugins/registry.js');
  const mail = (await loadPlugins()).find((p) => p.name === 'mail');
  const { openStore } = await import('../plugins/mail/store.js');
  const mdb = openStore(makeCtx(mail));
  const put = mdb.prepare('INSERT INTO mail (account, uid, ts, from_addr, from_name, subject) VALUES (?, ?, ?, ?, ?, ?)');
  put.run('home', 1, 1, 'Bookings@Garage.example', 'City Garage', 'Your booking');
  put.run('home', 2, 2, 'bookings@garage.example', 'City Garage', 'Reminder');
  put.run('home', 3, 3, 'bookings@garage.example', 'Someone <else>', 'Hello');
  put.run('home', 4, 4, 'noname@example.org', 'noname@example.org', 'An address for a name is no name');
  mdb.close();
  const day = new Date();
  day.setHours(15, 0, 0, 0);
  const s = Math.floor(day / 1000);
  const ev = (o) => ({
    cal: 'mine',
    allDay: false,
    start: s,
    end: s + 3600,
    day: day.toLocaleDateString('en-CA'),
    lastDay: day.toLocaleDateString('en-CA'),
    location: null,
    notes: null,
    from: null,
    with: [],
    others: 0,
    ...o,
  });
  (await import('../src/store.js')).storeFor('calendar').set('events', {
    syncedAt: Math.floor(Date.now() / 1000),
    errors: {},
    seen: {},
    events: [
      ev({
        uid: '1',
        title: 'Budget review',
        from: { name: 'Priya Nair', email: 'priya@work.example' },
        with: ['Tom Reed'],
        location: 'https://meet.example/abc',
      }),
      ev({ uid: '2', title: 'Dinner', with: ['Maya', 'Sam', 'Leo', 'Ana', 'Raj'], start: s + 7200, end: s + 10800 }),
      ev({ uid: '3', title: 'Gym', start: s + 14400, end: s + 18000 }),
      ev({ uid: '5', title: 'Service visit', start: s + 15000, end: s + 16000, from: { name: null, email: 'bookings@garage.example' } }),
      ev({ uid: '6', title: 'Unknown caller', start: s + 16000, end: s + 17000, from: { name: null, email: 'noname@example.org' } }),
      ev({ uid: '4', title: 'From before', start: s + 20000, end: s + 21000, from: undefined, with: undefined, others: undefined }), // copied before people were read
    ],
  });
  const { FORCE_COLOR: _f, ...env } = process.env;
  const bc = (...args) =>
    spawnSync(process.execPath, [new URL('../bin/bc.js', import.meta.url).pathname, 'calendar', ...args], { encoding: 'utf8', env });
  const today = bc('today').stdout;
  // the name the invitation gives, with the address; a name the owner's mail knows for an address; else the address alone
  assert.match(today, /Budget review · from Priya Nair \(priya@work\.example\) · https:\/\/meet\.example\/abc/);
  assert.match(today, /Service visit · from City Garage \(bookings@garage\.example\)\n/);
  assert.match(today, /Unknown caller · from noname@example\.org\n/);
  assert.match(today, /Dinner · with Maya, Sam, Leo and 2 more\n/);
  assert.match(today, /\d\d:\d\d–\d\d:\d\d {2}Gym\n/);
  assert.match(today, /From before(\n|$)/);
  const json = JSON.parse(bc('today', '--json').stdout).events.find((x) => x.title === 'Budget review');
  assert.deepEqual([json.from.name, json.with], ['Priya Nair', ['Tom Reed']]);
  assert.deepEqual(JSON.parse(bc('today', '--json').stdout).events.find((x) => x.title === 'Service visit').from, {
    name: 'City Garage',
    email: 'bookings@garage.example',
  });
  assert.match(bc('find', 'priya').stdout, /Budget review/);
  assert.match(bc('find', 'tom', 'reed').stdout, /Budget review/);
  assert.match(bc('find', 'maya').stdout, /Dinner/);
});

test("the briefing says who organised an appointment, and the item's card too", async () => {
  const { spawnSync } = await import('node:child_process');
  const { openWatchDb, listWatches, updateWatch, listItems, TODO } = await import('../src/watch/db.js');
  const { syncAgenda } = await import('../src/watch/agenda.js');
  const db = openWatchDb();
  const todo = listWatches(db).find((w) => w.builtin === TODO);
  updateWatch(db, todo.id, { active: 1, sources: { everywhere: 'all', mine: true, calendar: true } });
  await syncAgenda(db);
  const items = Object.fromEntries(listItems(db, todo.id, { status: 'new,kept' }).map((i) => [i.title, i]));
  assert.equal(items['Budget review'].msg_sender, 'Priya Nair (priya@work.example)');
  assert.equal(items['Service visit'].msg_sender, 'City Garage (bookings@garage.example)');
  assert.equal(items.Gym.msg_sender, null);
  db.close();
  const { FORCE_COLOR: _f, ...env } = process.env;
  const out = spawnSync(process.execPath, [new URL('../bin/bc.js', import.meta.url).pathname, 'watch', 'briefing', '--print'], {
    encoding: 'utf8',
    env,
  }).stdout;
  assert.match(out, /Budget review.* · organised by Priya Nair \(priya@work\.example\) · https:\/\/meet\.example\/abc/);
  assert.match(out, /Service visit.* · organised by City Garage \(bookings@garage\.example\)/);
  assert.doesNotMatch(out, /Gym.*organised by/);
  // an organiser learnt later (the calendar was copied before, or the invitation changed hands) reaches the item already on the list
  const again = openWatchDb();
  again.prepare("UPDATE watch_items SET msg_sender = NULL WHERE title = 'Service visit'").run();
  await syncAgenda(again);
  assert.equal(
    listItems(again, todo.id, { status: 'new,kept' }).find((i) => i.title === 'Service visit').msg_sender,
    'City Garage (bookings@garage.example)',
  );
  again.close();
});
