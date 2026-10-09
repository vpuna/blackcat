// A watch is a standing instruction: keep an eye on certain WhatsApp messages,
// collect the ones that fit into a list, and report on a schedule (digest) or at once (alert).
import { upgrade } from '../db.js';
import { adopt, now, openRemindersDb as openAgentDb, ownerChat, storedSchedule, ymd } from '../internal.js';
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
--            "linksOnly": true,
--            "attachments": false }   also read pictures, PDFs and documents (see src/archive/attachments.js)

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
];

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
    days: JSON.parse(w.days),
    nudge: w.nudge ? JSON.parse(w.nudge) : DEFAULT_NUDGE,
    scan: { cron: storedSchedule(w.scan ? JSON.parse(w.scan) : DEFAULT_SCAN) },
    report: storedSchedule({ cron: w.report ? JSON.parse(w.report) : null }, ['0 18 * * 4']),
    state: w.state ? JSON.parse(w.state) : null,
    lists: w.lists ? JSON.parse(w.lists) : {},
  };

export const getWatch = (db, id) => hydrate(db.prepare('SELECT * FROM watches WHERE id = ?').get(id));
export const listWatches = (db, { activeOnly = false } = {}) =>
  db
    .prepare(`SELECT * FROM watches ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY id`)
    .all()
    .map(hydrate);

// By id, or by (part of) the name.
export function findWatch(db, ref) {
  if (/^\d+$/.test(String(ref))) return getWatch(db, Number(ref));
  if (String(ref).toLowerCase() === TODO) return hydrate(db.prepare('SELECT * FROM watches WHERE builtin = ?').get(TODO));
  const hits = listWatches(db).filter((w) => w.name.toLowerCase().includes(String(ref).toLowerCase()));
  return hits.length === 1 ? hits[0] : null;
}

export function addWatch(db, w) {
  // (`days` and `at` are the columns a report's schedule was kept in before `report`; they are still filled so an older copy of the database stays readable.)
  const info = db
    .prepare(
      `INSERT INTO watches (chat_id, name, look_for, sources, mode, days, at, last_rowid, created_ts, nudge, scan, report)
    VALUES (@chatId, @name, @lookFor, @sources, @mode, @days, @at, @lastRowid, @createdTs, @nudge, @scan, @report)`,
    )
    .run({
      lastRowid: 0,
      ...w,
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
    at: 'at',
    active: 'active',
    lastRowid: 'last_rowid',
    lastDigest: 'last_digest',
    lastScan: 'last_scan',
  };
  const sets = [];
  const vals = {};
  for (const [k, v] of Object.entries(patch)) {
    if (['sources', 'days', 'nudge', 'scan', 'state', 'lists', 'report'].includes(k))
      (sets.push(`${k} = @${k}`), (vals[k] = JSON.stringify(v)));
    else if (cols[k]) (sets.push(`${cols[k]} = @${k}`), (vals[k] = v));
  }
  if (sets.length) db.prepare(`UPDATE watches SET ${sets.join(', ')} WHERE id = @id`).run({ ...vals, id });
  return getWatch(db, id);
}

export const seenIds = (db, watchId) => new Set(db.prepare('SELECT msg_id FROM watch_seen WHERE watch_id = ?').pluck().all(watchId));
export function markSeen(db, watchId, ids) {
  const ins = db.prepare('INSERT OR IGNORE INTO watch_seen (watch_id, msg_id) VALUES (?, ?)');
  db.transaction(() => ids.forEach((id) => ins.run(watchId, id)))();
}

export function removeWatch(db, id) {
  cancelNudges(db, db.prepare('SELECT id FROM watch_items WHERE watch_id = ?').pluck().all(id));
  db.prepare('DELETE FROM watch_seen WHERE watch_id = ?').run(id);
  db.prepare('DELETE FROM watch_items WHERE watch_id = ?').run(id);
  return db.prepare('DELETE FROM watches WHERE id = ?').run(id).changes;
}

// Returns the new item, or null if that link or message is already on the list.
export function addItem(db, it) {
  const info = db
    .prepare(
      `INSERT INTO watch_items (watch_id, title, category, place, area, event_date, summary, url, created_ts, msg_id, msg_chat, msg_sender, msg_ts, remind_ts, file)
    VALUES (@watchId, @title, @category, @place, @area, @eventDate, @summary, @url, @createdTs, @msgId, @msgChat, @msgSender, @msgTs, @remindTs, @file)
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
      createdTs: now(),
      ...it,
    });
  return info.changes ? getItem(db, Number(info.lastInsertRowid)) : null;
}

export const getItem = (db, id) => db.prepare('SELECT * FROM watch_items WHERE id = ?').get(id);

export function listItems(db, watchId, { status, list } = {}) {
  const where = ['watch_id = @watchId'];
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
    .all({ watchId, ...(list ? { list } : {}) });
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
  const changes = db.prepare('UPDATE watch_items SET status = ? WHERE id = ?').run(status, id).changes;
  if (['done', 'dropped', 'expired'].includes(status)) settle(db, 'id = ?', id);
  return changes;
}

// Events whose day has passed drop off the list by themselves.
export function expirePast(db, watchId) {
  const n = db
    .prepare(
      "UPDATE watch_items SET status = 'expired' WHERE watch_id = ? AND status IN ('new', 'kept') AND event_date IS NOT NULL AND event_date < ?",
    )
    .run(watchId, ymd()).changes;
  if (n) settle(db, "watch_id = ? AND status = 'expired'", watchId);
  return n;
}

// Let a watch look again at the messages that carry a file (used when attachment
// reading is switched on, so files that were skipped or judged by caption get read).
export function forgetSeen(db, watchId, ids) {
  const del = db.prepare('DELETE FROM watch_seen WHERE watch_id = ? AND msg_id = ?');
  db.transaction(() => ids.forEach((id) => del.run(watchId, id)))();
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
  };
  const sets = Object.keys(patch)
    .filter((k) => cols[k])
    .map((k) => `${cols[k]} = @${k}`);
  if (sets.length) db.prepare(`UPDATE watch_items SET ${sets.join(', ')} WHERE id = @id`).run({ ...patch, id });
  return getItem(db, id);
}
export const removeItem = (db, id) => db.prepare('DELETE FROM watch_items WHERE id = ?').run(id).changes;
