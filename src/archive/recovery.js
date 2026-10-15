// Going through the last days of a source again and keeping what is missing (`bc wa recover`,
// `bc tg account recover`). Only the source's service is logged in to the account, so the
// command leaves the work for it in a table of the plugin's own and waits to see it end; the
// service does it, one piece at a time, and says how it went. One definition for every
// source: the plugin says how its service goes through the days again, and in what words.
import fs from 'node:fs';
import { asAsked, askedBy, record } from '../activity/log.js';
import { withDb } from '../db.js';
import { plural } from '../util/format.js';
import { now } from '../util/time.js';
import { sleep } from '../util/wait.js';
import { DB_PATH, getMeta } from './db.js';
import { listChats, open as openArchive, parseTime } from './query.js';

export const MAX_DAYS = 3650;
const WAIT_S = () => Number(process.env.BLACKCAT_RECOVER_WAIT_S) || 120; // how long the command stays to see it finish
const KEEP_DAYS = 7; // work done is forgotten after this

// The table the work is left in, in the plugin's own database.
export const workTable = (table) => `
CREATE TABLE IF NOT EXISTS ${table} (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,                     -- recover
  args       TEXT NOT NULL DEFAULT '{}',        -- JSON
  status     TEXT NOT NULL DEFAULT 'pending',   -- pending | running | done | error
  progress   TEXT,                              -- JSON: how far it has got
  result     TEXT,                              -- JSON when done, the reason when not
  created_ts INTEGER NOT NULL
);
`;

const queue = (db, table) => ({
  // The one waiting or being worked on, if there is one: a second is not started beside it.
  open: (kind) => db.prepare(`SELECT * FROM ${table} WHERE kind = ? AND status IN ('pending', 'running') ORDER BY id LIMIT 1`).get(kind),
  add: (kind, args) =>
    db.prepare(`INSERT INTO ${table} (kind, args, created_ts) VALUES (?, ?, ?)`).run(kind, JSON.stringify(args), now()).lastInsertRowid,
  byId: (id) => db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id),
});

// How far back, as whole days: 60d, 8w, a date; left out, the days that are kept.
function daysOf(ctx, since, kept) {
  if (since == null) return kept;
  let from;
  try {
    from = parseTime(String(since));
  } catch (e) {
    ctx.fail(e.message);
  }
  const days = Math.round((Date.now() / 1000 - from) / 86400); // (30d is 30 days, whatever second it is asked at)
  if (!(days >= 1 && days <= MAX_DAYS)) ctx.fail(`--since is a time in the past, at most ${MAX_DAYS} days back: 60d, 8w, 2026-09-01.`);
  return days;
}

// What came of it, for a person. `head` begins it: "Asked your phone for the last 30 days of 2 chats".
export function recoveredText(r, head) {
  const first = `${head}: ${
    r.recovered
      ? `${r.recovered} message${r.recovered === 1 ? ' that was' : 's that were'} missing ${r.recovered === 1 ? 'is' : 'are'} now kept`
      : 'nothing was missing'
  }.`;
  const per = (r.per ?? []).slice(0, 8).map((c) => `  ${c.chat}: ${c.recovered}`);
  const more = (r.per ?? []).length > 8 ? [`  and ${r.per.length - 8} more chats`] : [];
  const silent = r.silent ? [`The phone gave no answer for ${plural(r.silent, 'chat')}.`] : [];
  return [first, ...per, ...more, ...silent].join('\n');
}

// The command. `s` says what is particular to the source:
//   source      its id in the archive ('wa')         label      what it is called ('WhatsApp')
//   linked()    whether the account is linked        notLinked  what to say when it is not
//   keptDays    the days it keeps                    stored     only chats with messages are named
//   stateKey    its state in the archive's meta      notConnected  what to say when it is not connected
//   open        its own database                     table      the table the work is left in
//   head(days, chats)  how what came of it begins
export async function recoverCommand(ctx, i, s) {
  if (!s.linked()) ctx.fail(s.notLinked);
  const days = daysOf(ctx, i.since, s.keptDays || 30);
  const archive = fs.existsSync(DB_PATH);
  let chats = null;
  let named = '';
  if (i.chat) {
    const found = archive
      ? withDb(openArchive, (db) => listChats(db, { match: i.chat, source: s.source, stored: !!s.stored, limit: 20 }))
      : [];
    if (!found.length)
      ctx.fail(`No ${s.label} chat${s.stored ? ' with messages' : ''} matches "${i.chat}". Try: bc msg chats --source ${s.source}`);
    chats = found.map((c) => c.ref);
    named = found.map((c) => c.name ?? c.ref).join(', ');
  }
  if (!archive || withDb(openArchive, (db) => getMeta(db))[s.stateKey] !== 'connected') ctx.fail(s.notConnected);

  return withDb(s.open, async (db) => {
    const q = queue(db, s.table);
    const open = q.open('recover');
    const id = open?.id ?? q.add('recover', { days, chats, by: askedBy() });
    const asked = open ? JSON.parse(open.args) : { days, chats };
    const before = open ? 'One was already going: this is that one.\n' : '';
    for (let t = 0; t < WAIT_S() * 2; t++) {
      const r = q.byId(id);
      if (r.status === 'done') {
        const result = JSON.parse(r.result);
        return { text: before + recoveredText(result, s.head(asked.days, result.chats)), data: { done: true, ...result } };
      }
      if (r.status === 'error') ctx.fail(`It could not be done: ${r.result}.`);
      await sleep(500);
    }
    const p = JSON.parse(q.byId(id).progress || '{}');
    return {
      text: `${before}Still going${named ? ` (${named})` : ''}: ${p.looked ?? 0} of ${p.chats ?? '?'} chats looked at, ${p.recovered ?? 0} missing messages kept so far. It carries on by itself; run the same command again to see how it ended.`,
      data: { done: false, ...p },
    };
  });
}

// The service's side: what was left for it, done one at a time. Call the function this
// returns as often as it should look (it does nothing while one is going, or while `ready()`
// says the service cannot do it now). `recover(args, onProgress)` → { recovered, looked, … }.
export function serveRecovery({ db, table, source, label, recover, log, ready = () => true }) {
  // What was being done when the service stopped will not be finished.
  db.prepare(`UPDATE ${table} SET status = 'error', result = ? WHERE status = 'running'`).run(
    `the ${label} service was restarted before it finished`,
  );
  const next = db.prepare(`SELECT * FROM ${table} WHERE status = 'pending' ORDER BY id LIMIT 1`);
  const set = db.prepare(`UPDATE ${table} SET status = ?, progress = COALESCE(?, progress), result = ? WHERE id = ?`);
  let busy = false;
  return async function serve() {
    if (busy || !ready()) return;
    const r = next.get();
    if (!r) return;
    busy = true;
    set.run('running', null, null, r.id);
    try {
      if (r.kind !== 'recover') throw new Error(`work of a kind not known here: ${r.kind}`);
      const { by, ...args } = JSON.parse(r.args);
      const began = Date.now();
      // (Recorded as part of what asked for it: the command that left the work.)
      const done = await asAsked(by, async () => {
        const note = (ok, summary, data) =>
          record({ kind: 'event', category: `messages: ${source}`, ok, ms: Date.now() - began, summary, data });
        try {
          const d = await recover(args, (p) => set.run('running', JSON.stringify(p), null, r.id));
          note(true, `recovered ${d.recovered} that were missing, in ${plural(d.looked, 'chat')} looked at`, {
            recovered: d.recovered,
            looked: d.looked,
          });
          return d;
        } catch (e) {
          note(false, 'recovering stopped');
          throw e;
        }
      });
      set.run('done', JSON.stringify(done), JSON.stringify(done), r.id);
      log?.(`recovered: ${plural(done.recovered, 'message')} that were missing, in ${plural(done.looked, 'chat')} looked at`);
    } catch (e) {
      set.run('error', null, e.message, r.id);
      log?.(`recovering stopped: ${e.message}`);
    } finally {
      busy = false;
      db.prepare(`DELETE FROM ${table} WHERE created_ts < ?`).run(now() - KEEP_DAYS * 86400);
    }
  };
}
