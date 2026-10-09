import { ARCHIVE_DB, INDEX_DB, INDEX_LOCK } from './files.js';
import fs from 'node:fs';
import { openSqlite, withDb } from '../db.js';
import * as sqliteVec from 'sqlite-vec';

import { CHAT_NAME, SENDER_NAME, sourceOf } from './db.js';
import { getEmbedder } from './embed/index.js';
import { QueryError, fmtTime, open as openArchive, parseTime, resolveChats, search as ftsSearch } from './query.js';

// Meaning-based search. Messages are grouped into short conversation "windows"
// (a lone "ok 👍" means nothing; the exchange around it does), each window gets
// an embedding, and a search embeds the question and finds the nearest windows.
//
// The index lives in its own file: the archive stays single-writer, and
// the index can be deleted and rebuilt, or rebuilt with a different model, at any time.
export { INDEX_DB };
const LOCK = INDEX_LOCK;

const GAP_S = 30 * 60; // a pause this long starts a new window
const MAX_MSGS = 12;
const MAX_CHARS = 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS windows (
  id         INTEGER PRIMARY KEY,
  chat_ref   TEXT NOT NULL,
  start_ts   INTEGER NOT NULL,
  end_ts     INTEGER NOT NULL,
  first_rowid INTEGER NOT NULL,    -- messages.rowid of the first message, to resume from
  anchor_id  TEXT NOT NULL,        -- id of the first message, for \`bc msg thread --around\`
  n          INTEGER NOT NULL,
  text       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS windows_chat ON windows (chat_ref, start_ts);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

const vecTable = (modelId) => `vec_${modelId.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
const blob = (f32) => Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);

function openIndex({ readonly = false } = {}) {
  if (readonly && !fs.existsSync(INDEX_DB)) return null;
  const db = openSqlite(INDEX_DB, { readonly });
  sqliteVec.load(db);
  if (!readonly) db.exec(SCHEMA);
  return db;
}

const meta = (db, key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
const setMeta = (db, key, value) =>
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, String(value));

// One line per message, as the model and the reader will see it.
function lineOf(m) {
  const body = [
    m.type !== 'text' ? `[${m.type}]` : null,
    m.text,
    m.link_title ? `(link: ${m.link_title}${m.link_desc ? ` – ${m.link_desc}` : ''})` : null,
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return body && body !== `[${m.type}]` ? `${m.sender}: ${body}` : null;
}

function* windowsOf(messages) {
  let cur = null;
  for (const m of messages) {
    const line = lineOf(m);
    if (!line) continue;
    if (cur && (m.ts - cur.end_ts > GAP_S || cur.n >= MAX_MSGS || cur.chars + line.length > MAX_CHARS)) {
      yield cur;
      cur = null;
    }
    cur ??= { start_ts: m.ts, first_rowid: m.rowid, anchor_id: m.id, n: 0, chars: 0, lines: [] };
    cur.end_ts = m.ts;
    cur.n++;
    cur.chars += line.length;
    cur.lines.push(line.slice(0, MAX_CHARS));
  }
  if (cur) yield cur;
}

// Only one indexer at a time (the scheduler and a manual run could overlap).
function lock() {
  try {
    const pid = Number(fs.readFileSync(LOCK, 'utf8'));
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        return false; // still running
      } catch {} // stale lock from a dead process
    }
  } catch {}
  fs.writeFileSync(LOCK, String(process.pid));
  process.on('exit', () => fs.rmSync(LOCK, { force: true }));
  return true;
}

// How far the index is behind the archive, found by comparing two numbers: nothing is
// loaded, so this can be asked often. Messages from any source count alike.
//   → { built, messages (in the archive and not yet in the index), unfinished (a run was cut short) }
export function behind() {
  if (!fs.existsSync(ARCHIVE_DB)) return { built: false, messages: 0, unfinished: false };
  let upto = 0;
  let unfinished = false;
  const built = fs.existsSync(INDEX_DB);
  if (built) {
    withDb(
      () => openSqlite(INDEX_DB, { readonly: true }),
      (ix) => {
        try {
          upto = Number(meta(ix, 'indexed_rowid')) || 0;
          unfinished = meta(ix, 'unfinished') === '1';
        } catch {
          // an index file with nothing in it yet
        }
      },
    );
  }
  return withDb(openArchive, (archive) => {
    return {
      built,
      messages: archive.prepare('SELECT COUNT(*) FROM messages WHERE rowid > ? AND deleted = 0').pluck().get(upto),
      unfinished,
    };
  });
}

const SWEEP_EVERY_S = 3600; // how often windows of deleted messages are looked for when nothing else is new

// `ifNeeded`: stop at once when the index is already up to date (what the scheduled run
// asks for; it runs every few minutes and usually finds nothing to do).
// `budgetMs`: stop working out vectors after about this long, newest conversations first,
// and leave the rest for the next run (a search that is waiting asks for this).
// `onPlan(n)` is told how many windows need a vector, before that work starts.
export async function index({ rebuild = false, quiet = false, ifNeeded = false, budgetMs = 0, onPlan } = {}) {
  const say = (msg) => quiet || console.log(msg);
  if (ifNeeded && !rebuild) {
    const b = behind();
    if (b.built && !b.messages && !b.unfinished) {
      const swept = withDb(
        () => openSqlite(INDEX_DB, { readonly: true }),
        (ix) => Number(meta(ix, 'swept_at')) || 0,
      );
      if (Date.now() / 1000 - swept < SWEEP_EVERY_S) return { upToDate: true };
    }
  }
  if (!lock()) return say('Another index run is in progress.');

  const embedder = await getEmbedder();
  const table = vecTable(embedder.id);
  try {
    return await withDb(openIndex, (ix) =>
      withDb(openArchive, async (archive) => {
        if (rebuild) {
          ix.exec('DELETE FROM windows');
          ix.exec(`DROP TABLE IF EXISTS ${table}`);
          setMeta(ix, 'indexed_rowid', 0);
        }
        ix.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING vec0(embedding float[${embedder.dims}])`);
        setMeta(ix, 'model', embedder.id);
        // Until the end of this run the index may hold windows with no vector yet.
        setMeta(ix, 'unfinished', 1);

        // 0. Forget windows whose messages are no longer in the archive (deleted on purpose,
        //    pruned by a narrower selection, or never meant to be kept). The index must not
        //    remember what the archive has let go of.
        const exists = archive.prepare('SELECT 1 FROM messages WHERE rowid = ? AND chat_ref = ? AND deleted = 0');
        const gone = ix
          .prepare('SELECT id, first_rowid, chat_ref FROM windows')
          .all()
          .filter((w) => !exists.get(w.first_rowid, w.chat_ref));
        if (gone.length) {
          ix.transaction(() => {
            for (const w of gone) {
              ix.prepare('DELETE FROM windows WHERE id = ?').run(w.id);
              ix.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(BigInt(w.id));
            }
          })();
          say(`Removed ${gone.length} conversation${gone.length === 1 ? '' : 's'} no longer in the archive.`);
        }
        setMeta(ix, 'swept_at', Math.floor(Date.now() / 1000));

        // 1. Re-window chats that have new messages. A chat's last window may still be
        //    growing, so it is dropped and rebuilt from its first message onwards.
        const upto = Number(meta(ix, 'indexed_rowid')) || 0;
        const maxRowid = archive.prepare('SELECT COALESCE(MAX(rowid), 0) AS m FROM messages').get().m;
        const chats = archive
          .prepare('SELECT DISTINCT chat_ref FROM messages WHERE rowid > ?')
          .all(upto)
          .map((r) => r.chat_ref);
        const insertWindow = ix.prepare(
          'INSERT INTO windows (chat_ref, start_ts, end_ts, first_rowid, anchor_id, n, text) VALUES (?, ?, ?, ?, ?, ?, ?)',
        );
        const fetch = archive.prepare(`SELECT m.rowid, m.id, m.ts, m.type, m.text, m.link_title, m.link_desc,
      CASE WHEN m.from_me THEN 'Me' WHEN m.sender_ref IS NULL THEN 'Unknown' ELSE ${SENDER_NAME} END AS sender
    FROM messages m WHERE m.chat_ref = ? AND m.deleted = 0 AND (m.ts > ? OR (m.ts = ? AND m.rowid >= ?)) ORDER BY m.ts, m.rowid`);
        const chatName = archive.prepare(`SELECT ${CHAT_NAME} AS name FROM chats ch WHERE ch.ref = ?`);

        // Working out a vector is the slow part (about two windows a second on a Pi). When a
        // chat's windows are rebuilt, most come out exactly as they were: those keep their vector.
        const vectorOf = ix.prepare(`SELECT embedding FROM ${table} WHERE rowid = ?`);
        const textOf = ix.prepare('SELECT text FROM windows WHERE id = ?');
        const putBack = ix.prepare(`INSERT INTO ${table} (rowid, embedding) VALUES (?, ?)`);
        let made = 0;
        let reused = 0;
        ix.transaction(() => {
          for (const ref of chats) {
            const kept = new Map(); // window text → its vector
            let last = ix
              .prepare('SELECT id, start_ts, first_rowid FROM windows WHERE chat_ref = ? ORDER BY start_ts DESC, id DESC LIMIT 1')
              .get(ref);
            // Older messages can arrive late (a history re-sync). They belong before the
            // last window, so rebuild the whole chat rather than leave them out.
            const oldestNew = archive.prepare('SELECT MIN(ts) AS ts FROM messages WHERE chat_ref = ? AND rowid > ?').get(ref, upto).ts;
            const drop =
              last && oldestNew < last.start_ts ? ix.prepare('SELECT id FROM windows WHERE chat_ref = ?').all(ref) : last ? [last] : [];
            if (drop.length > 1) last = null;
            for (const w of drop) {
              const vec = vectorOf.get(BigInt(w.id))?.embedding;
              if (vec) kept.set(textOf.get(w.id).text, Buffer.from(vec));
              ix.prepare('DELETE FROM windows WHERE id = ?').run(w.id);
              ix.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(BigInt(w.id));
            }
            const from = last ? [last.start_ts, last.start_ts, last.first_rowid] : [-1, -1, 0];
            const name = chatName.get(ref)?.name ?? ref;
            for (const w of windowsOf(fetch.all(ref, ...from))) {
              const text = `Chat: ${name}\n${w.lines.join('\n')}`;
              const id = insertWindow.run(ref, w.start_ts, w.end_ts, w.first_rowid, w.anchor_id, w.n, text).lastInsertRowid;
              made++;
              if (kept.has(text)) {
                putBack.run(BigInt(id), kept.get(text));
                reused++;
              }
            }
          }
          setMeta(ix, 'indexed_rowid', maxRowid);
        })();

        // 2. Embed every window that has no vector yet for the active model.
        //    The most recent conversations first: if this run is cut short, or has only so long,
        //    what was said lately is what becomes findable.
        const todo = ix
          .prepare(
            `SELECT w.id, w.text FROM windows w WHERE NOT EXISTS (SELECT 1 FROM ${table} v WHERE v.rowid = w.id) ORDER BY w.end_ts DESC, w.id DESC`,
          )
          .all();
        if (todo.length) say(`Embedding ${todo.length} conversation windows with ${embedder.id}…`);
        if (todo.length) await onPlan?.(todo.length);
        const put = ix.prepare(`INSERT INTO ${table} (rowid, embedding) VALUES (?, ?)`);
        const t0 = Date.now();
        let done = 0;
        const STEP = budgetMs ? 4 : 16; // small steps when someone is waiting, so the time limit is kept closely
        for (let i = 0; i < todo.length; i += STEP) {
          if (budgetMs && Date.now() - t0 > budgetMs) break;
          const batch = todo.slice(i, i + STEP);
          const vecs = await embedder.embed(batch.map((w) => w.text));
          ix.transaction(() => batch.forEach((w, j) => put.run(BigInt(w.id), blob(vecs[j]))))();
          done += batch.length;
          if (!quiet && process.stdout.isTTY) process.stdout.write(`\r  ${done}/${todo.length}`);
        }
        if (!quiet && todo.length && process.stdout.isTTY) process.stdout.write('\n');
        const left = todo.length - done;
        setMeta(ix, 'indexed_at', Math.floor(Date.now() / 1000));
        // Windows still without a vector are picked up by the next run.
        setMeta(ix, 'unfinished', left ? 1 : 0);
        const total = ix.prepare('SELECT COUNT(*) AS n FROM windows').get().n;
        say(
          left
            ? `Index partly up to date: ${done} of ${todo.length} windows embedded in ${((Date.now() - t0) / 1000).toFixed(0)}s; the rest at the next run.`
            : `Index up to date: ${total} windows (${made} rebuilt, ${reused} unchanged, ${done} embedded in ${((Date.now() - t0) / 1000).toFixed(0)}s).`,
        );
        return { windows: total, rebuilt: made, reused, embedded: done, left };
      }),
    );
  } finally {
    fs.rmSync(LOCK, { force: true });
  }
}

export function indexStats() {
  return withDb(
    () => openIndex({ readonly: true }),
    (ix) => {
      if (!ix) return null;
      const model = meta(ix, 'model');
      return {
        model,
        windows: ix.prepare('SELECT COUNT(*) AS n FROM windows').get().n,
        embedded: model ? ix.prepare(`SELECT COUNT(*) AS n FROM ${vecTable(model)}`).get().n : 0,
        indexedAt: Number(meta(ix, 'indexed_at')) || null,
      };
    },
  );
}

// Words too common to say anything about what a question is looking for.
const STOP = new Set(
  `a about after all also am an and any are as at be been before but by can could did do does for from get got had has have he her here him his how i if in into is it its just me my no not of on or our out she so some than that the their them then there these they this to up us was we were what when where which who why will with would you your did someone anyone something anything`.split(
    /\s+/,
  ),
);
const KEYWORD_WEIGHT = 0.6; // meaning leads; exact words confirm

export function contentWords(question) {
  return [
    ...new Set(
      question
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/),
    ),
  ].filter((w) => w && !STOP.has(w) && (w.length >= 3 || /^\d+$/.test(w)));
}

// Hybrid search: nearest windows by meaning, plus windows containing keyword hits,
// merged by reciprocal rank so a result that both methods like comes first.
// `questions` can hold several phrasings of the same thing ("fish", "tuna salmon seafood");
// each is searched and the rankings are merged, which finds far more than one wording does.
// How long a search waits for new messages to be indexed. What is not done by then is left
// to the scheduled run, and the search says so.
export const CATCH_UP_MS = 30_000;

export async function find(questions, { chat, since, until, limit = 8, source, onCatchUp } = {}) {
  questions = [questions]
    .flat()
    .map((q) => q.trim())
    .filter(Boolean);
  if (!questions.length) throw new QueryError('Nothing to search for.');
  // Messages that arrived since the index was last brought up to date would be missed by a
  // search by meaning, so they are indexed first. (`caughtUp` tells the caller it happened;
  // `onCatchUp` is called before it starts, with how many messages there are.)
  let caughtUp = null;
  const b = behind();
  if (b.built && (b.messages || b.unfinished)) {
    const t0 = Date.now();
    const r = await index({ quiet: true, budgetMs: CATCH_UP_MS, onPlan: (windows) => onCatchUp?.({ ...b, windows }) });
    // (No result: another run holds the index just now, and will bring it up to date.)
    caughtUp = {
      messages: b.messages,
      windows: r?.embedded ?? 0,
      left: r ? r.left : null,
      seconds: Math.round((Date.now() - t0) / 100) / 10,
    };
  }
  const results = await withDb(
    () => openIndex({ readonly: true }),
    (ix) => {
      if (!ix || !meta(ix, 'model'))
        throw new QueryError('The search index has not been built yet. Run `bc msg index` (the agent also builds it automatically).');
      return withDb(openArchive, async (archive) => {
        const embedder = await getEmbedder();
        if (meta(ix, 'model') !== embedder.id)
          throw new QueryError(
            `The index was built with ${meta(ix, 'model')} but the configured model is ${embedder.id}. Run \`bc msg index --rebuild\`.`,
          );

        const refs = chat ? resolveChats(archive, chat, source).map((c) => c.ref) : null;
        const from = since ? parseTime(since) : 0;
        const to = until ? parseTime(until) : 2 ** 31;
        const keep = (w) =>
          (!refs || refs.includes(w.chat_ref)) && (!source || sourceOf(w.chat_ref) === source) && w.end_ts >= from && w.start_ts <= to;

        const K = 60;
        const scores = new Map(); // window id → { score, by: Set }
        const bump = (id, rank, by, weight = 1) => {
          const s = scores.get(id) ?? { score: 0, by: new Set() };
          s.score += weight / (K + rank);
          s.by.add(by);
          scores.set(id, s);
        };

        const getWindow = ix.prepare('SELECT * FROM windows WHERE id = ?');
        const nearest = ix.prepare(
          `SELECT rowid AS id, distance FROM ${vecTable(embedder.id)} WHERE embedding MATCH ? AND k = ? ORDER BY distance`,
        );
        const vectors = await embedder.embed(questions, { kind: 'query' });

        for (const [qi, question] of questions.entries()) {
          // By meaning. Filters are applied after the nearest-neighbour search, so ask for extra.
          let rank = 0;
          for (const n of nearest.all(blob(vectors[qi]), refs || since || until || source ? 200 : 40)) {
            const w = getWindow.get(n.id);
            if (w && keep(w)) bump(w.id, rank++, 'meaning');
          }

          // By keyword, using only the words that carry meaning ("the" and "you" don't count).
          // A window ranks by how many different question words it contains, then by how rare
          // those words are (the full-text index's own ordering).
          const words = contentWords(question);
          if (words.length) {
            const windowAt = ix.prepare(
              'SELECT id, text FROM windows WHERE chat_ref = ? AND start_ts <= ? AND end_ts >= ? ORDER BY start_ts DESC LIMIT 1',
            );
            let hits = [];
            try {
              hits = ftsSearch(archive, words.join(' '), { chat, since, until, any: true, limit: 80, source });
            } catch (e) {
              if (!(e instanceof QueryError)) throw e;
            }
            const found = new Map(); // window id → { matched, order }
            hits.forEach((h, order) => {
              const w = windowAt.get(h.chatRef, h.ts, h.ts);
              if (!w || found.has(w.id)) return;
              const text = w.text.toLowerCase();
              const matched = words.filter((x) => new RegExp(`(^|[^\\p{L}\\p{N}])${x}`, 'u').test(text)).length;
              if (matched) found.set(w.id, { matched, order });
            });
            [...found.entries()]
              .sort((a, b) => b[1].matched - a[1].matched || a[1].order - b[1].order)
              .forEach(([id], r) => bump(id, r, 'keyword', KEYWORD_WEIGHT));
          }
        } // each phrasing

        const chatName = archive.prepare(`SELECT ${CHAT_NAME} AS name, ch.is_group AS isGroup FROM chats ch WHERE ch.ref = ?`);
        const results = [...scores.entries()]
          .sort((a, b) => b[1].score - a[1].score)
          .slice(0, limit)
          .map(([id, s]) => {
            const w = getWindow.get(id);
            const c = chatName.get(w.chat_ref);
            return {
              source: sourceOf(w.chat_ref),
              chat: c?.name ?? w.chat_ref,
              isGroup: !!c?.isGroup,
              from: fmtTime(w.start_ts),
              to: fmtTime(w.end_ts),
              matchedBy: [...s.by].sort().join('+'),
              messages: w.n,
              anchorId: w.anchor_id, // pass to `bc msg thread <chat> --around` for more context
              text: w.text.split('\n').slice(1).join('\n'),
            };
          });
        return results;
      });
    },
  );
  // (Carried beside the results, so everything that reads them as a list still can.)
  Object.defineProperty(results, 'caughtUp', { value: caughtUp });
  return results;
}
