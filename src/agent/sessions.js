// Where each chat's conversation with the engine is at: the engine's own name for it, the
// fingerprint of the instructions it began under, and which engine holds it. This is what
// lets a conversation be carried on after the agent service restarts.
//
// It is kept in blackcat's database, not the settings file: it changes with the
// conversation, and a change to the settings makes the process kept waiting for the agent's
// next command start afresh (src/agent/warm.js).
import { openAgentDb } from '../agentdb.js';
import { upgrade, withDb } from '../db.js';

const STEPS = [
  (db) =>
    db.exec(
      'CREATE TABLE chat_sessions (chat TEXT PRIMARY KEY, session TEXT NOT NULL, instructions TEXT, engine TEXT, updated_ts INTEGER NOT NULL)',
    ),
];
const open = () => {
  const db = openAgentDb();
  upgrade(db, 'chat-sessions', STEPS, { base: 2, owns: ['chat_sessions'] });
  return db;
};

// → { session, instructions, engine }, or null when the chat has no conversation under way.
export const sessionOf = (chatId) =>
  withDb(open, (db) => db.prepare('SELECT session, instructions, engine FROM chat_sessions WHERE chat = ?').get(String(chatId)) ?? null);

// Note where a chat's conversation is at. Nothing is written when it is where it was.
export function keepSession(chatId, { session, instructions = null, engine = null }) {
  return withDb(open, (db) => {
    const was = db.prepare('SELECT session, instructions, engine FROM chat_sessions WHERE chat = ?').get(String(chatId));
    if (was && was.session === session && was.instructions === instructions && was.engine === engine) return false;
    db.prepare(
      `INSERT INTO chat_sessions (chat, session, instructions, engine, updated_ts) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (chat) DO UPDATE SET session = excluded.session, instructions = excluded.instructions, engine = excluded.engine, updated_ts = excluded.updated_ts`,
    ).run(String(chatId), String(session), instructions, engine, Math.floor(Date.now() / 1000));
    return true;
  });
}

// The chat starts afresh next time. → whether there was anything to forget
export const dropSession = (chatId) =>
  withDb(open, (db) => db.prepare('DELETE FROM chat_sessions WHERE chat = ?').run(String(chatId)).changes > 0);
