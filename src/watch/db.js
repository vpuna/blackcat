// A list is the owner's own: a name, the fields they gave it, and its entries. A watch is a
// standing instruction: keep an eye on certain messages, file the ones that fit on the list it
// fills, and report on a schedule (digest) or at once (alert). A list needs no watch.
import { upgrade } from '../db.js';
import {
  SOURCES,
  adopt,
  alike,
  commonWords,
  historyDays,
  now,
  openRemindersDb as openAgentDb,
  ownerChat,
  storedSchedule,
  ymd,
} from '../internal.js';
import { cancelNudges, settleNudges } from '../reminders/nudges.js';
const SCHEMA = `
CREATE TABLE IF NOT EXISTS watches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     INTEGER NOT NULL,            -- the owner's chat, on the channel in use: where its reports go
  name        TEXT NOT NULL,
  look_for    TEXT NOT NULL,               -- what belongs on the list, in the owner's words
  sources     TEXT NOT NULL,               -- JSON, see below
  mode        TEXT NOT NULL DEFAULT 'digest',   -- digest | alert
  days        TEXT NOT NULL DEFAULT '[4]', -- JSON: weekdays for the digest, 0 = Sunday
  at          TEXT NOT NULL DEFAULT '18:00',
  active      INTEGER NOT NULL DEFAULT 1,
  last_rowid  INTEGER NOT NULL DEFAULT 0,  -- ignore messages at or before this (set by --history none)
  last_digest INTEGER NOT NULL DEFAULT 0,
  created_ts  INTEGER NOT NULL,
  nudge TEXT,
  scan TEXT,
  report TEXT,
  last_scan INTEGER NOT NULL DEFAULT 0,
  builtin TEXT,
  state TEXT,
  lists TEXT
);
-- sources: { "chats": [{ "ref": "…", "name": "Maya", "sender": "maya" | null }],
--            "self": true,        also messages you send to yourself
--            "mine": false,       also your own messages in the listed chats
--            "linksOnly": true }
--          (Files are read where they arrive, for every watch: src/archive/reading.js. An older
--          watch may still carry "attachments", which no longer means anything.)

CREATE TABLE IF NOT EXISTS watch_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id    INTEGER NOT NULL,
  title       TEXT NOT NULL,
  category    TEXT,
  place       TEXT,
  area        TEXT,
  event_date  TEXT,                        -- YYYY-MM-DD, for things that happen on a day
  summary     TEXT,
  url         TEXT,
  status      TEXT NOT NULL DEFAULT 'new', -- new (not reported yet) | kept | done | dropped | expired
  created_ts  INTEGER NOT NULL,
  msg_id      TEXT,                        -- the message it came from, whichever the source (or a calendar event)
  msg_chat    TEXT,
  msg_sender  TEXT,
  msg_ts      INTEGER,
  remind_ts INTEGER,
  file TEXT
);
CREATE INDEX IF NOT EXISTS watch_items_watch ON watch_items (watch_id, status);

-- Every WhatsApp message a watch has already examined, so each is looked at once even
-- when chats are added to the watch later.
CREATE TABLE IF NOT EXISTS watch_seen (
  watch_id  INTEGER NOT NULL,
  msg_id TEXT NOT NULL,
  PRIMARY KEY (watch_id, msg_id)
) WITHOUT ROWID;
-- The same link, or the same message, goes on a list once.
CREATE UNIQUE INDEX IF NOT EXISTS watch_items_url ON watch_items (watch_id, url) WHERE url IS NOT NULL;
-- (One attachment, such as a newsletter, can put several things on a list: hence the title.)
DROP INDEX IF EXISTS watch_items_msg;
CREATE UNIQUE INDEX IF NOT EXISTS watch_items_msg_title ON watch_items (watch_id, msg_id, title) WHERE msg_id IS NOT NULL;
`;

// Added after the first version:
//   watches.nudge      JSON: how to nudge about an item, see watch/nudge.js
//   watches.scan       JSON: { cron: ['*/15 * * * *'] }: when it looks for new messages
//   watches.report     JSON: [cron…]: when a watch with its own report sends it (the days and at columns held this before)
//   watches.last_scan  when it last looked for new messages
//   watches.builtin    'todo' for the built-in "Things I need to do" watch
//   watches.state      (not used: it was for checks when they were a kind of watch; see src/checks)
//   watches.lists      JSON: { quiet: [list names] } (lists kept out of reports; see lists.js)
//   watch_items.file   a picture or document that belongs with the item
//   watch_items.remind_ts  when to nudge, for watches where the reader suggests a time
//   watch_items.reference  a booking's or an order's number, to find what comes about it later
//   watch_items.watch_id   is list_id since lists stand by themselves (step 11); the table keeps its name
//   watch_items.fields     JSON: the values of the fields the owner added to the list { name: value }
//   watches.list_id        the list the watch fills
// and watches.mode gained 'briefing': new items go in the daily briefing rather than a report of their own.
export const DEFAULT_NUDGE = { mode: 'before', days: 2, at: '18:00' };
export const DEFAULT_SCAN = { cron: ['*/15 * * * *'] };
export const TODO = 'todo';
// When "Things I need to do" looks until the owner says otherwise: every hour. (A look that
// finds nothing new asks no model anything, so this costs only when there is something to read.)
export const TODO_SCAN = { cron: ['0 * * * *'] };
const TODO_NAME = 'Things I need to do';
const TODO_LOOK_FOR =
  'things I have to do or answer: notes to myself, events I am expected at, things I said I would do, questions and requests waiting for my reply, payments and deadlines';

const STEPS = [
  // The tables, and the watch that is always there, "Things I need to do".
  (db) => {
    db.exec(SCHEMA);
    ensureTodo(db);
  },
  // 5: a watch reads the owner's own messages in its chats too, unless told not to. One that
  //    was already there (when that was something to ask for) reads them from now on: what
  //    the owner wrote before stays unread, so a long history does not arrive all at once.
  (db) => {
    const at = Math.floor(Date.now() / 1000);
    const put = db.prepare('UPDATE watches SET sources = ? WHERE id = ?');
    for (const w of db.prepare('SELECT id, sources FROM watches WHERE builtin IS NULL').all()) {
      let src;
      try {
        src = JSON.parse(w.sources);
      } catch {
        continue;
      }
      if (!src || src.mine === true) continue;
      put.run(JSON.stringify({ ...src, mine: true, mineSince: at }), w.id);
    }
  },
  // 6: for something the owner is waiting on: how far into the conversation it has been
  //    looked at for an answer, so that each look judges only what has come since.
  (db) => db.exec('ALTER TABLE watch_items ADD COLUMN checked_ts INTEGER'),
  // 7: what an entry a watch added looks like, among what was kept already (a list entry, a
  //    reminder): JSON [{ kind, id, title, where }]. Said with it, so the owner can drop one.
  (db) => db.exec('ALTER TABLE watch_items ADD COLUMN same_as TEXT'),
  // 8: a WhatsApp chat a watch reads, named as the archive has named it since WhatsApp's ids
  //    were marked "wa:" (src/archive/db.js, step 8).
  (db) => {
    const put = db.prepare('UPDATE watches SET sources = ? WHERE id = ?');
    const unmarked = (ref) => /^[0-9][^:]*@/.test(ref ?? '');
    for (const w of db.prepare('SELECT id, sources FROM watches').all()) {
      let src;
      try {
        src = JSON.parse(w.sources);
      } catch {
        continue;
      }
      if (!src?.chats?.some((c) => unmarked(c.ref))) continue;
      put.run(JSON.stringify({ ...src, chats: src.chats.map((c) => (unmarked(c.ref) ? { ...c, ref: `wa:${c.ref}` } : c)) }), w.id);
    }
  },
  // 9: a booking's or an order's reference (its booking number, order number, tracking
  //    number), by which later messages about it are found, whoever sends them.
  (db) => db.exec('ALTER TABLE watch_items ADD COLUMN reference TEXT'),
  // 10: what an entry came to, as a reader judged it (OUTCOMES), in its own columns: what it
  //     said, and when. It used to be written into the summary ("Answered: …"), which lost what
  //     the entry was about and said nothing when the reader gave no reason. Those are moved.
  (db) => {
    for (const c of ['outcome TEXT', 'outcome_text TEXT', 'outcome_ts INTEGER']) db.exec(`ALTER TABLE watch_items ADD COLUMN ${c}`);
    const put = db.prepare('UPDATE watch_items SET outcome = ?, outcome_text = ?, outcome_ts = ?, summary = ? WHERE id = ?');
    const was = { Answered: 'answered', 'Since then': 'later', Done: 'done', Arrived: 'arrived', Cancelled: 'cancelled', Moved: 'moved' };
    for (const it of db.prepare('SELECT id, summary, checked_ts, created_ts FROM watch_items').all()) {
      const m = /^(Answered|Since then|Done|Arrived|Cancelled|Moved): (.*)$/s.exec(it.summary ?? '');
      if (m) put.run(was[m[1]], m[2], it.checked_ts ?? it.created_ts, m[2], it.id);
    }
  },
  // 11: lists stand by themselves (docs/architecture.md, "Lists"), and a watch fills
  //     one. The list a watch had is made with the watch's own number, so its entries, which
  //     named the watch, name the list: none is moved or rewritten. A watch that watched nothing
  //     (a "plain list") is now its list alone.
  (db) => {
    db.exec(`CREATE TABLE lists (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      fields     TEXT,              -- JSON [{ name, kind }]: the fields the owner added (kind: text, number, date)
      created_ts INTEGER NOT NULL,
      changed_ts INTEGER,           -- when something on it was last added, changed or ticked off, by the owner or a watch
      seen_ts    INTEGER,           -- when it was last looked at
      briefing   INTEGER NOT NULL DEFAULT 0  -- a list kept by hand: its dated entries are in the daily briefing
    )`);
    db.exec(`INSERT INTO lists (id, name, created_ts, changed_ts)
      SELECT w.id, w.name, w.created_ts, (SELECT MAX(i.created_ts) FROM watch_items i WHERE i.watch_id = w.id) FROM watches w`);
    db.exec('ALTER TABLE watches ADD COLUMN list_id INTEGER');
    db.exec('UPDATE watches SET list_id = id');
    db.exec('ALTER TABLE watch_items RENAME COLUMN watch_id TO list_id');
    db.exec('ALTER TABLE watch_items ADD COLUMN fields TEXT');
    // Messages the owner linked to an entry ("link this mail to the flight").
    db.exec(`CREATE TABLE list_links (
      item_id    INTEGER NOT NULL,
      msg_id     TEXT NOT NULL,
      msg_chat   TEXT,
      msg_sender TEXT,
      msg_ts     INTEGER,
      linked_ts  INTEGER NOT NULL,
      PRIMARY KEY (item_id, msg_id)
    ) WITHOUT ROWID`);
    for (const w of db.prepare('SELECT id, sources FROM watches WHERE builtin IS NULL').all()) {
      let src;
      try {
        src = JSON.parse(w.sources);
      } catch {
        continue;
      }
      if (!src?.manual) continue;
      cancelNudges(db, db.prepare('SELECT id FROM watch_items WHERE list_id = ?').pluck().all(w.id));
      db.prepare('DELETE FROM watch_seen WHERE watch_id = ?').run(w.id);
      db.prepare('DELETE FROM watches WHERE id = ?').run(w.id);
    }
  },
  // When a later message last spoke of an entry, or the owner kept it: an undated one lapses
  // its source's days of history after that (lapseUndated).
  (db) => db.exec('ALTER TABLE watch_items ADD COLUMN mentioned_ts INTEGER'),
];
// What an entry can come to: the first four close it, the last two leave it open.
export const OUTCOMES = ['answered', 'done', 'arrived', 'cancelled', 'later', 'moved'];

// What an entry looks like the same as, kept already: [{ kind, id, title, where }]. (A calendar
// copy keeps what was judged not to be it too, with same: false, so as not to ask again.)
export function sameAsOf(it) {
  try {
    return it?.same_as ? JSON.parse(it.same_as).filter((k) => k.same !== false) : [];
  } catch {
    return [];
  }
}
// 'may be the same as "Chess Club places" on School notices', for a line or a card: named by
// its title, since a number there would read as one of the briefing's. In a terminal, with
// the id to use in a command (item 173, reminder 12).
export const sameAsText = (it, { terminal = false } = {}) => {
  const k = sameAsOf(it)[0];
  if (!k) return null;
  const title = k.title?.length > 60 ? `${k.title.slice(0, 59)}…` : k.title;
  const named = k.title ? `"${title}"` : k.kind === 'reminder' ? 'a reminder' : 'an entry';
  const id = terminal ? ` (${k.kind === 'reminder' ? 'reminder' : 'item'} ${k.id})` : '';
  return `may be the same as ${k.kind === 'reminder' ? `the reminder ${named}` : `${named} on ${k.where}`}${id}`;
};

// (Opened with the reminders' table in place: a watch keeps its nudges there.)
export function openWatchDb() {
  const db = openAgentDb();
  upgrade(db, 'watch', STEPS, { base: 4, owns: ['watches'] });
  adopt(db, 'watches');
  return db;
}

// The built-in watch. It looks across your chats (except those another watch covers) for
// things you need to do or answer. Created once, switched on, and it covers whatever is
// connected: messages, kept email and calendars (see agenda.js).
function ensureTodo(db) {
  if (db.prepare('SELECT 1 FROM watches WHERE builtin = ?').get(TODO)) return;
  db.prepare(
    `INSERT INTO watches (chat_id, name, look_for, sources, mode, days, at, active, last_rowid, created_ts, nudge, scan, builtin)
    VALUES (?, ?, ?, ?, 'briefing', '[0,1,2,3,4,5,6]', '07:00', 1, 0, ?, ?, ?, ?)`,
  ).run(
    ownerChat(),
    TODO_NAME,
    TODO_LOOK_FOR,
    JSON.stringify({ everywhere: 'all', mine: true }),
    Math.floor(Date.now() / 1000),
    JSON.stringify({ mode: 'suggested' }),
    JSON.stringify(TODO_SCAN),
    TODO,
  );
}

const hydrate = (w) =>
  w && {
    ...w,
    sources: JSON.parse(w.sources),
    nudge: w.nudge ? JSON.parse(w.nudge) : DEFAULT_NUDGE,
    scan: { cron: storedSchedule(w.scan ? JSON.parse(w.scan) : DEFAULT_SCAN) },
    report: storedSchedule({ cron: w.report ? JSON.parse(w.report) : null }, ['0 18 * * 4']),
    lists: w.lists ? JSON.parse(w.lists) : {},
  };

// (With the name of the list it fills, as `listName`.)
const WATCH = 'SELECT w.*, l.name AS listName FROM watches w LEFT JOIN lists l ON l.id = w.list_id';
export const getWatch = (db, id) => hydrate(db.prepare(`${WATCH} WHERE w.id = ?`).get(id));
export const listWatches = (db, { activeOnly = false } = {}) =>
  db
    .prepare(`${WATCH} ${activeOnly ? 'WHERE w.active = 1' : ''} ORDER BY w.id`)
    .all()
    .map(hydrate);

// By id, or by (part of) the name.
export function findWatch(db, ref) {
  if (/^\d+$/.test(String(ref))) return getWatch(db, Number(ref));
  if (String(ref).toLowerCase() === TODO) return hydrate(db.prepare(`${WATCH} WHERE w.builtin = ?`).get(TODO));
  const hits = listWatches(db).filter((w) => w.name.toLowerCase().includes(String(ref).toLowerCase()));
  return hits.length === 1 ? hits[0] : null;
}

// `listId`: the list it fills; without one, a list of its own is made, named as the watch.
export function addWatch(db, w) {
  // (`days` and `at` are the columns a report's schedule was kept in before `report`; they are still filled so an older copy of the database stays readable.)
  const info = db
    .prepare(
      `INSERT INTO watches (chat_id, name, look_for, sources, mode, days, at, last_rowid, created_ts, nudge, scan, report, list_id)
    VALUES (@chatId, @name, @lookFor, @sources, @mode, @days, @at, @lastRowid, @createdTs, @nudge, @scan, @report, @listId)`,
    )
    .run({
      lastRowid: 0,
      ...w,
      listId: w.listId ?? addList(db, w.name).id,
      sources: JSON.stringify(w.sources),
      days: JSON.stringify(w.days ?? [4]),
      at: w.at ?? '18:00',
      createdTs: now(),
      nudge: JSON.stringify(w.nudge ?? DEFAULT_NUDGE),
      scan: JSON.stringify(w.scan ?? DEFAULT_SCAN),
      report: w.report ? JSON.stringify(w.report) : null,
    });
  return getWatch(db, Number(info.lastInsertRowid));
}

export function updateWatch(db, id, patch) {
  const cols = {
    name: 'name',
    lookFor: 'look_for',
    mode: 'mode',
    active: 'active',
    lastRowid: 'last_rowid',
    lastDigest: 'last_digest',
    lastScan: 'last_scan',
    listId: 'list_id',
  };
  const sets = [];
  const vals = {};
  for (const [k, v] of Object.entries(patch)) {
    if (['sources', 'nudge', 'scan', 'lists', 'report'].includes(k)) (sets.push(`${k} = @${k}`), (vals[k] = JSON.stringify(v)));
    else if (cols[k]) (sets.push(`${cols[k]} = @${k}`), (vals[k] = v));
  }
  if (sets.length) db.prepare(`UPDATE watches SET ${sets.join(', ')} WHERE id = @id`).run({ ...vals, id });
  return getWatch(db, id);
}

// A chat was renamed (a mail account, say): the watches that read it show the new name.
// They find the chat by its ref, so this changes only what is shown. → how many watches
export function renameChatInWatches(db, ref, name) {
  let n = 0;
  db.transaction(() => {
    for (const w of listWatches(db)) {
      if (!(w.sources.chats ?? []).some((c) => c.ref === ref && c.name !== name)) continue;
      updateWatch(db, w.id, { sources: { ...w.sources, chats: w.sources.chats.map((c) => (c.ref === ref ? { ...c, name } : c)) } });
      n++;
    }
  })();
  return n;
}

// How many entries a list has in each state: { new: 3, kept: 1, … }.
export const itemCounts = (db, listId) =>
  Object.fromEntries(
    db
      .prepare('SELECT status, COUNT(*) AS n FROM watch_items WHERE list_id = ? GROUP BY status')
      .all(listId)
      .map((r) => [r.status, r.n]),
  );

export const seenIds = (db, watchId) => new Set(db.prepare('SELECT msg_id FROM watch_seen WHERE watch_id = ?').pluck().all(watchId));
export function markSeen(db, watchId, ids) {
  const ins = db.prepare('INSERT OR IGNORE INTO watch_seen (watch_id, msg_id) VALUES (?, ?)');
  db.transaction(() => ids.forEach((id) => ins.run(watchId, id)))();
}

// The list stays, with everything on it; what the watch would still nudge about is not nudged.
export function removeWatch(db, id) {
  const w = getWatch(db, id);
  if (w) cancelNudges(db, db.prepare('SELECT id FROM watch_items WHERE list_id = ?').pluck().all(w.list_id));
  db.prepare('DELETE FROM watch_seen WHERE watch_id = ?').run(id);
  return db.prepare('DELETE FROM watches WHERE id = ?').run(id).changes;
}

// ---------- lists ----------

const hydrateList = (l) => l && { ...l, fields: l.fields ? JSON.parse(l.fields) : [] };
export const getList = (db, id) => hydrateList(db.prepare('SELECT * FROM lists WHERE id = ?').get(id));
export const allLists = (db) => db.prepare('SELECT * FROM lists ORDER BY id').all().map(hydrateList);
// The lists kept by hand that the owner put in the daily briefing.
export const briefingLists = (db) =>
  db
    .prepare('SELECT * FROM lists WHERE briefing = 1 AND id NOT IN (SELECT list_id FROM watches WHERE list_id IS NOT NULL) ORDER BY id')
    .all()
    .map(hydrateList);
// The watch that fills a list, or null for one kept by hand.
export const watchOfList = (db, listId) => hydrate(db.prepare(`${WATCH} WHERE w.list_id = ?`).get(listId)) ?? null;

// By number, by name (any case), or by a part of the name that only one list has. "todo" is
// the list of "Things I need to do".
export function findList(db, ref) {
  const r = String(ref ?? '').trim();
  if (/^\d+$/.test(r)) return getList(db, Number(r));
  if (r.toLowerCase() === TODO) return getList(db, db.prepare('SELECT list_id FROM watches WHERE builtin = ?').pluck().get(TODO));
  const all = allLists(db);
  const exact = all.filter((l) => l.name.toLowerCase() === r.toLowerCase());
  if (exact.length === 1) return exact[0];
  const part = all.filter((l) => l.name.toLowerCase().includes(r.toLowerCase()));
  return part.length === 1 ? part[0] : null;
}

export const listNamed = (db, name) => allLists(db).find((l) => l.name.toLowerCase() === String(name).trim().toLowerCase()) ?? null;

export function addList(db, name, fields = []) {
  const at = now();
  const info = db
    .prepare('INSERT INTO lists (name, fields, created_ts, changed_ts) VALUES (?, ?, ?, ?)')
    .run(name, fields.length ? JSON.stringify(fields) : null, at, at);
  return getList(db, Number(info.lastInsertRowid));
}

export function updateList(db, id, { name, fields, briefing }) {
  if (name !== undefined) db.prepare('UPDATE lists SET name = ? WHERE id = ?').run(name, id);
  if (briefing !== undefined) db.prepare('UPDATE lists SET briefing = ? WHERE id = ?').run(briefing ? 1 : 0, id);
  if (fields !== undefined) db.prepare('UPDATE lists SET fields = ? WHERE id = ?').run(fields.length ? JSON.stringify(fields) : null, id);
  touchList(db, id);
  return getList(db, id);
}

// A list and everything on it. (One a watch fills is not removed: the watch is, first.)
export function removeList(db, id) {
  const items = db.prepare('SELECT id FROM watch_items WHERE list_id = ?').pluck().all(id);
  cancelNudges(db, items);
  const unlink = db.prepare('DELETE FROM list_links WHERE item_id = ?');
  for (const i of items) unlink.run(i);
  db.prepare('DELETE FROM watch_items WHERE list_id = ?').run(id);
  return db.prepare('DELETE FROM lists WHERE id = ?').run(id).changes;
}

// When a list was last used: something on it added, changed or ticked off (by the owner or a
// watch), and when it was last looked at.
export const touchList = (db, listId) => db.prepare('UPDATE lists SET changed_ts = ? WHERE id = ?').run(now(), listId);
const touchItem = (db, itemId) =>
  db.prepare('UPDATE lists SET changed_ts = ? WHERE id = (SELECT list_id FROM watch_items WHERE id = ?)').run(now(), itemId);
export const seeList = (db, listId) => db.prepare('UPDATE lists SET seen_ts = ? WHERE id = ?').run(now(), listId);

// Messages linked to an entry by the owner: [{ msg_id, msg_chat, msg_sender, msg_ts, linked_ts }], oldest first.
export const linksOf = (db, itemId) => db.prepare('SELECT * FROM list_links WHERE item_id = ? ORDER BY msg_ts, linked_ts').all(itemId);
// → whether it was not linked already
export function linkMessage(db, itemId, m) {
  const r = db
    .prepare(
      'INSERT INTO list_links (item_id, msg_id, msg_chat, msg_sender, msg_ts, linked_ts) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
    )
    .run(itemId, m.id, m.chat ?? null, m.sender ?? null, m.ts ?? null, now());
  if (r.changes) touchItem(db, itemId);
  return r.changes > 0;
}
export function unlinkMessage(db, itemId, msgId) {
  const n = db.prepare('DELETE FROM list_links WHERE item_id = ? AND msg_id = ?').run(itemId, msgId).changes;
  if (n) touchItem(db, itemId);
  return n;
}

// ---------- entries ----------

// Returns the new item, or null if that link or message is already on the list.
export function addItem(db, it) {
  const info = db
    .prepare(
      `INSERT INTO watch_items (list_id, title, category, place, area, event_date, summary, url, created_ts, msg_id, msg_chat, msg_sender, msg_ts, remind_ts, file, reference, fields)
    VALUES (@listId, @title, @category, @place, @area, @eventDate, @summary, @url, @createdTs, @msgId, @msgChat, @msgSender, @msgTs, @remindTs, @file, @reference, @fields)
    ON CONFLICT DO NOTHING`,
    )
    .run({
      category: null,
      place: null,
      area: null,
      eventDate: null,
      summary: null,
      url: null,
      msgId: null,
      msgChat: null,
      msgSender: null,
      msgTs: null,
      remindTs: null,
      file: null,
      reference: null,
      createdTs: now(),
      ...it,
      fields: it.fields && Object.keys(it.fields).length ? JSON.stringify(it.fields) : null,
    });
  if (!info.changes) return null;
  touchList(db, it.listId);
  return getItem(db, Number(info.lastInsertRowid));
}

export const getItem = (db, id) => db.prepare('SELECT * FROM watch_items WHERE id = ?').get(id);

// What is still open on a list that looks like `title`: by the words that carry the meaning
// (plugins/same.js), or with every word of one in the other, short ones and numbers too
// ("Raspberry Pi 4" and "Raspberry Pi 4 Model B"; not "Raspberry Pi 5"). Only that list: what
// is on another list is not the same thing.
const wordsOf = (t) =>
  new Set(
    String(t ?? '')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  );
const within = (a, b) => {
  const [x, y] = [wordsOf(a), wordsOf(b)];
  const [small, big] = x.size <= y.size ? [x, y] : [y, x];
  return small.size > 0 && [...small].every((w) => big.has(w));
};
export function alikeOnList(db, listId, title) {
  const open = db.prepare("SELECT * FROM watch_items WHERE list_id = ? AND status IN ('new', 'kept')").all(listId);
  const common = commonWords(open.map((o) => o.title));
  return open.filter((o) => alike(title, o.title, common) || within(title, o.title));
}

export function listItems(db, listId, { status, list } = {}) {
  const where = ['list_id = @listId'];
  if (list) where.push("COALESCE(category, 'other') = @list");
  if (status && status !== 'all')
    where.push(
      `status IN (${status
        .split(',')
        .map((s) => `'${s.replace(/[^a-z]/g, '')}'`)
        .join(', ')})`,
    );
  return db
    .prepare(`SELECT * FROM watch_items WHERE ${where.join(' AND ')} ORDER BY COALESCE(event_date, '9999'), msg_ts DESC, id DESC`)
    .all({ listId, ...(list ? { list } : {}) });
}

// Nothing left to nudge about once an item is done, dropped or past.
const settle = (db, where, ...args) =>
  settleNudges(
    db,
    db
      .prepare(`SELECT id FROM watch_items WHERE ${where}`)
      .pluck()
      .all(...args),
  );
export function setItemStatus(db, id, status) {
  // (Kept, or opened again, by the owner: as if just spoken of, so that it does not lapse at once.)
  const changes = ['new', 'kept'].includes(status)
    ? db.prepare('UPDATE watch_items SET status = ?, mentioned_ts = ? WHERE id = ?').run(status, now(), id).changes
    : db.prepare('UPDATE watch_items SET status = ? WHERE id = ?').run(status, id).changes;
  if (changes && status !== 'expired') touchItem(db, id);
  if (['done', 'dropped', 'expired'].includes(status)) settle(db, 'id = ?', id);
  return changes;
}

// Events whose day has passed drop off the list by themselves, and so do undated entries
// whose source's days of history have gone by since a message last spoke of them.
export function expirePast(db, listId) {
  const n = db
    .prepare(
      "UPDATE watch_items SET status = 'expired' WHERE list_id = ? AND status IN ('new', 'kept') AND event_date IS NOT NULL AND event_date < ?",
    )
    .run(listId, ymd()).changes;
  const lapsed = lapseUndated(db, listId);
  if (n || lapsed) settle(db, "list_id = ? AND status = 'expired'", listId);
  return n + lapsed;
}

// The days an undated entry is kept, after the last message that spoke of it: as far back as
// its source's history is fetched (WhatsApp's 30 days, a mail account's 180), what the owner
// chose as worth reading. One the owner added by hand, or from a source with no such limit,
// stays. → days | null
export const keptDays = (it) => (it.msg_id ? historyDays(it.msg_id) : null);
// When it was last spoken of: its message, a later one about it, a message the owner linked
// to it, or the owner keeping it.
const lastSpoken = (db, it) =>
  Math.max(
    it.msg_ts ?? it.created_ts,
    it.mentioned_ts ?? 0,
    db.prepare('SELECT MAX(msg_ts) FROM list_links WHERE item_id = ?').pluck().get(it.id) ?? 0,
  );
export const isLapsed = (it) => it.status === 'expired' && !it.event_date;
// Those of a list's that expired for their age, as the section of expired entries says (and not,
// say, a to-do nudged long ago and never ticked off: todo.js lets that go after a while too).
export const lapsedItems = (db, listId) =>
  listItems(db, listId, { status: 'expired' }).filter((it) => {
    const days = isLapsed(it) && keptDays(it);
    return days && now() - lastSpoken(db, it) > days * 86400;
  });
// For a watch's chats, as said when it is made: "30 days (the history you keep for WhatsApp)
// after the last message about them". null when none of them has such a limit.
export function keptSaid(refs) {
  const by = new Map();
  for (const ref of refs) {
    const days = historyDays(ref);
    const src = SOURCES[String(ref).split(':')[0]];
    if (days && src) by.set(days, new Set([...(by.get(days) ?? []), src]));
  }
  if (!by.size) return null;
  const said = [...by.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([d, s]) => `${d} days (the history you keep for ${[...s].join(' and ')})`)
    .join(', or ');
  return `${said} after the last message about them`;
}
function lapseUndated(db, listId) {
  const t = now();
  const put = db.prepare("UPDATE watch_items SET status = 'expired' WHERE id = ?");
  let n = 0;
  for (const it of db
    .prepare("SELECT * FROM watch_items WHERE list_id = ? AND status IN ('new', 'kept') AND event_date IS NULL")
    .all(listId)) {
    const days = keptDays(it);
    if (days && t - lastSpoken(db, it) > days * 86400) n += put.run(it.id).changes;
  }
  return n;
}
// A later message spoke of it: the days start again, and one that had lapsed is back.
export function spokenOf(db, id, ts) {
  db.prepare(
    "UPDATE watch_items SET mentioned_ts = MAX(COALESCE(mentioned_ts, 0), ?), status = CASE WHEN status = 'expired' AND event_date IS NULL THEN 'kept' ELSE status END WHERE id = ?",
  ).run(ts ?? now(), id);
}

// Change an item's details (used when a later message adds to, or changes, something already listed).
export function updateItem(db, id, patch) {
  const cols = {
    title: 'title',
    category: 'category',
    place: 'place',
    area: 'area',
    eventDate: 'event_date',
    summary: 'summary',
    status: 'status',
    remindTs: 'remind_ts',
    url: 'url',
    file: 'file',
    reference: 'reference',
    fields: 'fields',
  };
  const vals = { ...patch };
  if (vals.fields) vals.fields = Object.keys(vals.fields).length ? JSON.stringify(vals.fields) : null;
  const sets = Object.keys(vals)
    .filter((k) => cols[k])
    .map((k) => `${cols[k]} = @${k}`);
  if (sets.length) {
    db.prepare(`UPDATE watch_items SET ${sets.join(', ')} WHERE id = @id`).run({ ...vals, id });
    touchItem(db, id);
  }
  return getItem(db, id);
}
// What an entry came to, in a few words: "answered: she said yes", or the word alone when the
// reader gave no reason. → string | null
export const cameTo = (i) => (i.outcome ? (i.outcome_text ? `${i.outcome}: ${i.outcome_text}` : i.outcome) : null);

// What an entry came to, kept with it (`text`: the reader's reason, if it gave one). Its
// summary is left as it was: what the entry is about.
export function setOutcome(db, id, outcome, text = null) {
  if (!OUTCOMES.includes(outcome)) throw new Error(`not an outcome: ${outcome}`);
  db.prepare('UPDATE watch_items SET outcome = ?, outcome_text = ?, outcome_ts = ? WHERE id = ?').run(
    outcome,
    text,
    Math.floor(Date.now() / 1000),
    id,
  );
  touchItem(db, id);
}
export function removeItem(db, id) {
  touchItem(db, id);
  db.prepare('DELETE FROM list_links WHERE item_id = ?').run(id);
  return db.prepare('DELETE FROM watch_items WHERE id = ?').run(id).changes;
}
