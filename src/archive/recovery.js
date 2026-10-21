// Going through the days of history a source fetches again and keeping what is missing (`bc wa recover`,
// `bc tg account recover`). How far back is the source's own setting, never asked for here. Only the source's service is logged in to the account, so the
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
import { listChats, open as openArchive } from './query.js';

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

// What came of it, for a person. `head` begins it: "Asked your phone for the last 30 days of 2 chats".
export function recoveredText(r, head) {
  const first = `${head}: ${
    r.recovered
      ? `${r.recovered} message${r.recovered === 1 ? ' that was' : 's that were'} missing ${r.recovered === 1 ? 'is' : 'are'} now kept`
      : 'nothing was missing'
  }.`;
  const per = (r.per ?? []).slice(0, 8).map((c) => `  ${c.chat}: ${c.recovered}`);
  const more = (r.per ?? []).length > 8 ? [`  and ${r.per.length - 8} more chats`] : [];
  const begin = r.begin
    ? [`${plural(r.begin, 'chat')} begin${r.begin === 1 ? 's' : ''} later than that: there is nothing older on the phone.`]
    : [];
  const silent = r.silent ? [`The phone gave no answer for ${plural(r.silent, 'chat')} (it may have nothing older).`] : [];
  return [first, ...per, ...more, ...begin, ...silent].join('\n');
}

// The command. `s` says what is particular to the source:
//   source      its id in the archive ('wa')         label      what it is called ('WhatsApp')
//   linked()    whether the account is linked        notLinked  what to say when it is not
//   keptDays    the days of history it fetches       stored     only chats with messages are named
//   stateKey    its state in the archive's meta      notConnected  what to say when it is not connected
//   open        its own database                     table      the table the work is left in
//   head(days, chats)  how what came of it begins
export async function recoverCommand(ctx, i, s) {
  if (!s.linked()) ctx.fail(s.notLinked);
  const days = s.keptDays || 30;
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
    // (Not waited for any longer: how it ends is sent to the owner when it does.)
    tellWhenDone(db, s.table, id);
    const p = JSON.parse(q.byId(id).progress || '{}');
    return {
      text: `${before}Still going${named ? ` (${named})` : ''}: ${p.looked ?? 0} of ${p.chats ?? '?'} chats looked at, ${p.recovered ?? 0} missing messages kept so far. It carries on by itself, and you are sent how it ended.`,
      data: { done: false, ...p },
    };
  });
}

// Work left for a service whose end the owner is sent, as it ends (one nobody stays to see).
export function tellWhenDone(db, table, id) {
  db.prepare(`UPDATE ${table} SET args = json_set(args, '$.tell', json('true')) WHERE id = ?`).run(id);
}

// Work left for a service, from outside a command (after linking, after the days were changed):
// one already waiting is that one. Its end is sent to the owner. → its id
export function leaveWork(db, table, args) {
  const q = queue(db, table);
  const id = q.open('recover')?.id ?? q.add('recover', { ...args, by: askedBy() });
  tellWhenDone(db, table, id);
  return id;
}

// The service's side: what was left for it, done one at a time. Call the function this
// returns as often as it should look (it does nothing while one is going, or while `ready()`
// says the service cannot do it now). `recover(args, onProgress)` → { recovered, looked, … }.
// `say(result, args)`: how it ended, in words, for work whose end the owner is sent.
export function serveRecovery({ db, table, source, label, recover, say, log, ready = () => true }) {
  // What was being done when the service stopped will not be finished.
  db.prepare(`UPDATE ${table} SET status = 'error', result = ? WHERE status = 'running'`).run(
    `the ${label} service was restarted before it finished`,
  );
  const next = db.prepare(`SELECT * FROM ${table} WHERE status = 'pending' ORDER BY id LIMIT 1`);
  // (Read again at the end: a command that stopped waiting may have asked for it meanwhile.)
  const wantsTelling = (id) => JSON.parse(db.prepare(`SELECT args FROM ${table} WHERE id = ?`).pluck().get(id) ?? '{}').tell === true;
  const set = db.prepare(`UPDATE ${table} SET status = ?, progress = COALESCE(?, progress), result = ? WHERE id = ?`);
  let busy = false;
  return async function serve() {
    if (busy || !ready()) return;
    const r = next.get();
    if (!r) return;
    busy = true;
    set.run('running', null, null, r.id);
    const tell = (text) => import('../channels/send.js').then(({ notifyOwner }) => notifyOwner(text)).catch(() => false);
    let args = {};
    try {
      if (r.kind !== 'recover') throw new Error(`work of a kind not known here: ${r.kind}`);
      const { by, tell: _t, ...rest } = JSON.parse(r.args);
      args = rest;
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
      if (wantsTelling(r.id) && say) await tell(`${label}: ${say(done, args)}`);
    } catch (e) {
      set.run('error', null, e.message, r.id);
      log?.(`recovering stopped: ${e.message}`);
      if (wantsTelling(r.id))
        await tell(`${label}: fetching history stopped: ${e.message}. Try again: bc ${source === 'tg' ? 'tg account' : source} recover`);
    } finally {
      busy = false;
      db.prepare(`DELETE FROM ${table} WHERE created_ts < ?`).run(now() - KEEP_DAYS * 86400);
    }
  };
}
