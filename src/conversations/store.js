// Conversations with the agent, kept in blackcat's own database: each turn's question and
// reply, under a conversation with a title. Until this existed, what was said lived only in
// Claude Code's own session files, so a past conversation could not be listed, shown,
// continued once its file was gone, or tied to what the activity record says it cost.
//
// A conversation belongs to a channel ('telegram', 'terminal') and a chat on it. It is not
// tied to the engine: `engine_session` is the engine's own handle for it, used to continue
// it the engine's way while that still works, and the stored turns are what continues it
// when it does not (see history()).
//
// What a turn ran is not stored here: the activity record has that, linked by turn.
// Nothing here may get in the way of a conversation: callers wrap these in safe().
import { load } from '../config.js';
import { getMeta, openAgentDb, setMeta } from '../agentdb.js';
import { upgrade, withDb as withOpen } from '../db.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id             INTEGER PRIMARY KEY,
  channel        TEXT NOT NULL,             -- terminal, or the channel's name (tg-bot, …)
  chat           TEXT NOT NULL,             -- the chat on that channel
  title          TEXT NOT NULL,
  engine         TEXT NOT NULL,             -- claude-code
  engine_session TEXT,                      -- the engine's own id for it
  instructions   TEXT,                      -- fingerprint of the instructions it last ran with
  started_ts     INTEGER NOT NULL,
  last_ts        INTEGER NOT NULL,
  turns          INTEGER NOT NULL DEFAULT 0,
  engine_cost REAL,
  engine_api_ms INTEGER,
  summary TEXT,
  summary_upto INTEGER
);
CREATE INDEX IF NOT EXISTS conversations_chat ON conversations (channel, chat, last_ts);
CREATE TABLE IF NOT EXISTS conversation_turns (
  id              INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL,
  ts              INTEGER NOT NULL,
  question        TEXT NOT NULL,
  reply           TEXT,                     -- null while it is being answered, or if it never was
  ok              INTEGER,
  ms              INTEGER
);
CREATE INDEX IF NOT EXISTS conversation_turns_conv ON conversation_turns (conversation_id, id);
`;

// The engine a conversation is taken to be held by when nobody says (the one that comes with blackcat).
export const ENGINE = 'claude-code';
const QUESTION_MAX = 8000;
const REPLY_MAX = 20_000;
// on: keep conversations at all · days: how long (0 = until you delete them)
// summary: when a long conversation is continued from this record, have a reader summarise
// the part that is too long to hand over whole (kept with the conversation, and added to as it grows)
export const DEFAULTS = { on: true, days: 90, summary: true };
export const settings = () => ({ ...DEFAULTS, ...load().conversations });

// engine_cost, engine_api_ms: the engine's own running totals for a conversation.
// summary, summary_upto: the summary of its earlier part.
const STEPS = [(db) => db.exec(SCHEMA)];
function open() {
  const db = openAgentDb();
  upgrade(db, 'conversations', STEPS);
  return db;
}
const now = () => Math.floor(Date.now() / 1000);
const withDb = (fn) => withOpen(open, fn);
// Run something that must never break a conversation. → its result, or `fallback`.
export function safe(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// A title from the first thing asked: its first line, without the notes blackcat puts in front.
export function titleOf(question) {
  const text = String(question ?? '')
    .replace(/^(\[[^\]]*\]\s*)+/, '')
    .trim();
  const line = (text.split('\n').find((l) => l.trim()) ?? '').replace(/\s+/g, ' ').trim();
  return (line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line) || 'Untitled';
}

// Begin a conversation. → its id, or null when conversations are not kept.
export function start({ channel, chat, question, instructions, engine = ENGINE }) {
  if (!settings().on) return null;
  return withDb((db) =>
    Number(
      db
        .prepare(
          `INSERT INTO conversations (channel, chat, title, engine, instructions, started_ts, last_ts)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(channel, String(chat), titleOf(question), engine, instructions ?? null, now(), now()).lastInsertRowid,
    ),
  );
}

// A question has been asked. → the turn's id.
export function addTurn(conversationId, question) {
  if (!conversationId || !settings().on) return null;
  return withDb((db) => {
    const id = Number(
      db
        .prepare('INSERT INTO conversation_turns (conversation_id, ts, question) VALUES (?, ?, ?)')
        .run(conversationId, now(), String(question).slice(0, QUESTION_MAX)).lastInsertRowid,
    );
    db.prepare('UPDATE conversations SET last_ts = ?, turns = turns + 1 WHERE id = ?').run(now(), conversationId);
    prune(db);
    return id;
  });
}

// It has been answered (or was not: `reply` null).
export function finishTurn(turnId, { reply, ok = true, ms, engineSession, instructions, engineCost, engineApiMs } = {}) {
  if (!turnId) return;
  withDb((db) => {
    const text = reply == null ? null : String(reply);
    db.prepare('UPDATE conversation_turns SET reply = ?, ok = ?, ms = ? WHERE id = ?').run(
      text == null ? null : text.length > REPLY_MAX ? `${text.slice(0, REPLY_MAX)}\n[… the rest of this reply was not kept]` : text,
      ok ? 1 : 0,
      ms ?? null,
      turnId,
    );
    const conv = db.prepare('SELECT conversation_id FROM conversation_turns WHERE id = ?').pluck().get(turnId);
    if (conv && (engineSession || instructions)) {
      db.prepare(
        `UPDATE conversations SET engine_session = COALESCE(?, engine_session), instructions = COALESCE(?, instructions), last_ts = ?,
        engine_cost = COALESCE(?, engine_cost), engine_api_ms = COALESCE(?, engine_api_ms) WHERE id = ?`,
      ).run(engineSession ?? null, instructions ?? null, now(), engineCost ?? null, engineApiMs ?? null, conv);
    }
  });
}

// A question that was never really put (the conversation could not be opened, and it is
// about to be asked again): take it out, so it is not kept twice.
export function dropTurn(turnId) {
  if (!turnId) return;
  withDb((db) => {
    const conv = db.prepare('SELECT conversation_id FROM conversation_turns WHERE id = ?').pluck().get(turnId);
    if (!conv) return;
    db.prepare('DELETE FROM conversation_turns WHERE id = ?').run(turnId);
    db.prepare('UPDATE conversations SET turns = MAX(0, turns - 1) WHERE id = ?').run(conv);
  });
}

export const get = (id) => withDb((db) => db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) ?? null);
export const byEngineSession = (session) =>
  session
    ? withDb((db) => db.prepare('SELECT * FROM conversations WHERE engine_session = ? ORDER BY last_ts DESC LIMIT 1').get(session) ?? null)
    : null;

// Recent conversations, most recently used first. With `channel` and `chat`: only that chat's.
export function list({ channel, chat, limit = 10 } = {}) {
  return withDb((db) => {
    const where = ['turns > 0'];
    const p = { limit: Math.min(Math.max(Number(limit) || 10, 1), 200) };
    if (channel) (where.push('channel = @channel'), (p.channel = channel));
    if (chat != null) (where.push('chat = @chat'), (p.chat = String(chat)));
    return db
      .prepare(
        `SELECT c.*, (SELECT question FROM conversation_turns t WHERE t.conversation_id = c.id ORDER BY t.id DESC LIMIT 1) AS lastQuestion
      FROM conversations c WHERE ${where.join(' AND ')} ORDER BY last_ts DESC, id DESC LIMIT @limit`,
      )
      .all(p);
  });
}

// The turns of one conversation, oldest first (the last `limit` of them).
export function turns(conversationId, { limit = 200 } = {}) {
  return withDb((db) =>
    db
      .prepare('SELECT * FROM (SELECT * FROM conversation_turns WHERE conversation_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id')
      .all(conversationId, Math.max(1, Number(limit) || 200)),
  );
}

// Turns whose question or reply contains `text`, newest first, each with its conversation.
export function find(text, { sinceTs, limit = 10 } = {}) {
  return withDb((db) =>
    db
      .prepare(
        `SELECT t.*, c.title, c.channel, c.chat FROM conversation_turns t JOIN conversations c ON c.id = t.conversation_id
    WHERE (t.question LIKE @q ESCAPE '\\' OR t.reply LIKE @q ESCAPE '\\') ${sinceTs ? 'AND t.ts >= @since' : ''} ORDER BY t.id DESC LIMIT @limit`,
      )
      .all({
        q: `%${String(text).replace(/[\\%_]/g, '\\$&')}%`,
        limit: Math.min(Math.max(Number(limit) || 10, 1), 100),
        ...(sinceTs ? { since: sinceTs } : {}),
      }),
  );
}

// What was said, as text to hand to a conversation that has to start over (the engine's own
// copy is gone, or the instructions have changed since): the most recent turns that fit.
// How one exchange is written out, for the engine and for a reader.
export const written = (t, max = Infinity) => `Owner: ${t.question}\nYou: ${t.reply ?? '(this was not answered)'}`.slice(0, max);

export function history(conversationId, maxChars = 12_000) {
  const all = turns(conversationId, { limit: 100_000 });
  const blocks = [];
  let used = 0;
  let from = all.length; // the first exchange that is given in full
  for (let i = all.length - 1; i >= 0; i--) {
    const block = written(all[i]);
    if (used + block.length > maxChars && blocks.length) break;
    blocks.unshift(block.slice(0, maxChars));
    used += block.length;
    from = i;
  }
  const left = all.length - blocks.length;
  return {
    turns: blocks.length,
    omitted: left,
    firstShown: all[from]?.id ?? null,
    text: `${left ? `(${left} earlier exchange${left === 1 ? '' : 's'} not shown.)\n\n` : ''}${blocks.join('\n\n')}`,
  };
}

// The exchanges of a conversation between two points (after one turn, before another), oldest first.
export const between = (conversationId, afterId, beforeId) =>
  withDb((db) =>
    db
      .prepare('SELECT * FROM conversation_turns WHERE conversation_id = ? AND id > ? AND id < ? ORDER BY id')
      .all(conversationId, afterId ?? 0, beforeId),
  );

// The summary kept of a conversation's earlier part: its text, and the last exchange it covers.
export function setSummary(conversationId, text, uptoTurnId) {
  return withDb(
    (db) => db.prepare('UPDATE conversations SET summary = ?, summary_upto = ? WHERE id = ?').run(text, uptoTurnId, conversationId).changes,
  );
}

// What to show you when you pick a conversation up again: enough to remember where you
// were, never the conversation itself (`bc conversations show` is for reading one).
const clip = (text, n) => {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > n ? `${flat.slice(0, n - 1).trimEnd()}…` : flat;
};
// For a chat window: the last thing you asked there, in a line. Null when that is the title already.
export function lastAsked(conversationId, max = 140) {
  const c = get(conversationId);
  const last = turns(conversationId, { limit: 1 })[0];
  if (!c || !last) return null;
  const q = clip(last.question.replace(/^(\[[^\]]*\]\s*)+/, ''), max);
  return c.turns <= 1 || q === c.title ? null : q;
}
// For a terminal, where nothing of it is on screen: the last `n` exchanges, cut short.
export function recap(conversationId, n = 2) {
  return turns(conversationId, { limit: n }).map((t) => ({
    ts: t.ts,
    you: clip(t.question.replace(/^(\[[^\]]*\]\s*)+/, ''), 240),
    reply: t.reply == null ? null : clip(t.reply, 480),
  }));
}

// Once a day, let go of what is past its keeping time.
function prune(db) {
  const days = Number(settings().days) || 0;
  const today = new Date().toDateString();
  if (!days || getMeta(db, 'conversations_pruned') === today) return;
  const cutoff = now() - days * 86400;
  db.prepare('DELETE FROM conversation_turns WHERE conversation_id IN (SELECT id FROM conversations WHERE last_ts < ?)').run(cutoff);
  db.prepare('DELETE FROM conversations WHERE last_ts < ?').run(cutoff);
  setMeta(db, 'conversations_pruned', today);
}

export function remove(id) {
  return withDb((db) => {
    db.prepare('DELETE FROM conversation_turns WHERE conversation_id = ?').run(id);
    return db.prepare('DELETE FROM conversations WHERE id = ?').run(id).changes;
  });
}
export function clear() {
  return withDb((db) => {
    const n = db.prepare('SELECT COUNT(*) FROM conversations').pluck().get();
    db.exec('DELETE FROM conversation_turns; DELETE FROM conversations;');
    return n;
  });
}
export const counts = () =>
  withDb((db) => ({
    conversations: db.prepare('SELECT COUNT(*) FROM conversations WHERE turns > 0').pluck().get(),
    turns: db.prepare('SELECT COUNT(*) FROM conversation_turns').pluck().get(),
    since: db.prepare('SELECT MIN(started_ts) FROM conversations').pluck().get(),
  }));
