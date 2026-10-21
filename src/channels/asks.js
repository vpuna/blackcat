// Asking the owner something in the middle of work and waiting for the answer: ctx.askOwner.
// A plugin's command, job or service asks ("Book this ride? €24–31"), with a picture if it
// has one and two to four choices; it gets back the choice the owner tapped, or none.
//
// The question is kept in agent.db (`asks`) and the agent service, which holds the channel,
// sends it and takes the tap: whoever asks may be a command started by the agent, by a chat,
// or by a job, in a process of its own that cannot hear the channel. The service looks for
// new questions every second.
//
// What is promised whoever asks: only the owner's tap, in their own chat, answers; a question
// is answered once, and not after it expires; there is no "always", so the same question is
// asked every time. In a terminal on this machine, with the owner at it, it is asked there.
import crypto from 'node:crypto';
import path from 'node:path';
import { AGENT_DB } from '../agentdb.js';
import { openSqlite, upgrade, withDb } from '../db.js';
import { log } from '../log.js';
import { ownerChat, LOCAL } from '../owner.js';
import { errMsg, esc } from '../util/format.js';
import { hm, now } from '../util/time.js';
import { sleep } from '../util/wait.js';
import { can, ui } from './desk.js';
import { actions } from './kit.js';

const STEPS = [
  // state: new → sent → answered | expired | unsent (nobody sent it) | withdrawn (whoever asked stopped waiting)
  (db) =>
    db.exec(`
      CREATE TABLE asks (id TEXT PRIMARY KEY, part TEXT NOT NULL, title TEXT NOT NULL, chat TEXT NOT NULL, text TEXT NOT NULL,
        picture TEXT, choices TEXT NOT NULL, asked_ts INTEGER NOT NULL, expires_ts INTEGER NOT NULL, state TEXT NOT NULL,
        ref TEXT, answer TEXT, answered_ts INTEGER, shown INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX asks_open ON asks (state, shown);
    `),
];
const open = () => {
  const db = openSqlite(AGENT_DB);
  upgrade(db, 'asks', STEPS);
  return db;
};
const use = (fn) => withDb(open, fn);

export const LIMITS = { choices: [2, 4], label: 30, text: 1500, expiresIn: [30, 600] };
const SEND_WAIT_S = 15; // the service sends within a second or two; this long without, it is not running
const KEEP_S = 7 * 86400;

function problems(q) {
  const out = [];
  if (typeof q?.text !== 'string' || !q.text.trim() || q.text.length > LIMITS.text) out.push(`text: up to ${LIMITS.text} characters`);
  const c = q?.choices;
  if (
    !Array.isArray(c) ||
    c.length < LIMITS.choices[0] ||
    c.length > LIMITS.choices[1] ||
    !c.every((x) => typeof x === 'string' && x.trim() && x.length <= LIMITS.label) ||
    new Set(c).size !== c.length
  )
    out.push(`choices: ${LIMITS.choices[0]} to ${LIMITS.choices[1]} different labels, each up to ${LIMITS.label} characters`);
  const e = q?.expiresIn;
  if (e != null && !(Number.isInteger(e) && e >= LIMITS.expiresIn[0] && e <= LIMITS.expiresIn[1]))
    out.push(`expiresIn: seconds, from ${LIMITS.expiresIn[0]} to ${LIMITS.expiresIn[1]}`);
  if (q?.picture != null && !(typeof q.picture === 'string' && path.isAbsolute(q.picture))) out.push('picture: a full path');
  return out;
}

// The owner is at this terminal: the command was typed here, not by the agent or from a chat.
const atTerminal = () =>
  !!process.stdin.isTTY && !!process.stdout.isTTY && process.env.BLACKCAT_CALLER !== 'agent' && !process.env.BLACKCAT_CHAT_ID;

// The last choice is the one that leaves things as they are ("Cancel").
// → { answer: one of the choices, or null; how: 'answered' | 'expired' | 'unasked'; why? }
export async function askOwner(part, title, q, { signal } = {}) {
  const wrong = problems(q);
  if (wrong.length) throw new Error(`askOwner: ${wrong.join('; ')}`);
  const expiresIn = q.expiresIn ?? 120;
  const result = atTerminal() ? await inTerminal(q, expiresIn) : await onChannel(part, title, q, expiresIn, signal);
  const { record } = await import('../activity/log.js');
  record({
    kind: 'event',
    category: part,
    summary: `asked the owner: ${result.answer ? `"${result.answer}"` : result.how === 'expired' ? 'no answer in time' : 'could not ask'}`,
    ok: result.how !== 'unasked',
    data: { how: result.how, ...(result.why ? { why: result.why } : {}) },
  });
  return result;
}

// (An answer given after the question expired counts for nothing, as on a channel.)
async function inTerminal(q, expiresIn) {
  const p = await import('@clack/prompts');
  const t = Date.now();
  p.note(`${q.text}${q.picture ? `\n\nThe picture: ${q.picture}` : ''}`, 'blackcat asks');
  const v = await p.select({
    message: `Your answer (within ${expiresIn >= 120 ? `${Math.round(expiresIn / 60)} minutes` : `${expiresIn} seconds`})`,
    options: q.choices.map((c) => ({ value: c, label: c })),
    // (The last choice is the one that does nothing: a stray Enter chooses it.)
    initialValue: q.choices.at(-1),
  });
  if (p.isCancel(v)) return { answer: null, how: 'answered', why: 'cancelled' };
  if (Date.now() - t > expiresIn * 1000) {
    p.log.warn('That came after the question expired, so it does not count.');
    return { answer: null, how: 'expired' };
  }
  return { answer: v, how: 'answered' };
}

async function onChannel(part, title, q, expiresIn, signal) {
  const chat = ownerChat();
  if (chat == null || chat === LOCAL) return { answer: null, how: 'unasked', why: 'no channel is in use' };
  const id = crypto.randomBytes(6).toString('hex');
  const t = now();
  use((db) => {
    db.prepare('DELETE FROM asks WHERE asked_ts < ?').run(t - KEEP_S);
    db.prepare(
      `INSERT INTO asks (id, part, title, chat, text, picture, choices, asked_ts, expires_ts, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')`,
    ).run(id, part, title, String(chat), q.text, q.picture ?? null, JSON.stringify(q.choices), t, t + expiresIn);
  });
  const get = () => use((db) => db.prepare('SELECT state, answer, expires_ts FROM asks WHERE id = ?').get(id));
  // (Ended by whoever asks only where nothing else has: a tap that came first stands.)
  const end = (state, from) =>
    use((db) => db.prepare(`UPDATE asks SET state = ? WHERE id = ? AND state IN (${from})`).run(state, id).changes);
  try {
    for (;;) {
      if (signal?.aborted) {
        end('withdrawn', "'new', 'sent'");
        return { answer: null, how: 'unasked', why: 'stopped' };
      }
      const row = get();
      if (row.state === 'answered') return { answer: row.answer, how: 'answered' };
      if (row.state === 'expired') return { answer: null, how: 'expired' };
      if (row.state === 'withdrawn') return { answer: null, how: 'answered', why: 'the owner wrote instead of answering' };
      if (row.state === 'unsent') return { answer: null, how: 'unasked', why: 'it could not be sent' };
      if (row.state === 'new' && now() - t > SEND_WAIT_S && end('unsent', "'new'"))
        return { answer: null, how: 'unasked', why: 'the agent service is not running, so nothing could be sent' };
      if (now() >= row.expires_ts && end('expired', "'new', 'sent'")) return { answer: null, how: 'expired' };
      await sleep(500);
    }
  } finally {
    // Killed while waiting: the question is closed, not left open for a tap nobody waits for.
    end('withdrawn', "'new', 'sent'");
  }
}

// ---------- in the agent service ----------

const rendered = (row, footer) => [`🐈‍⬛ <b>${esc(row.title)} asks</b>`, esc(row.text), footer].filter(Boolean).join('\n\n');
const waitingFooter = (row) => `<i>Only your tap answers. It expires at ${hm(row.expires_ts)}.</i>`;
const chatOf = (s) => (/^-?\d+$/.test(s) ? Number(s) : s);

// Send new questions, take taps, and close the messages of those that ended. → { stop() }
export function installAsks({ everyMs = 1000 } = {}) {
  ui.action(/^ak:([0-9a-f]{12}):(\d)$/, async (c) => {
    const [, id, n] = c.match;
    const row = use((db) => db.prepare('SELECT * FROM asks WHERE id = ?').get(id));
    if (!row || row.state !== 'sent' || now() >= row.expires_ts) return c.gone('This question is no longer waiting.');
    if (String(c.conversation) !== row.chat) return c.toast("This isn't your question.");
    const choice = JSON.parse(row.choices)[Number(n)];
    if (choice == null) return c.toast('That choice is not one of them.');
    const took = use(
      (db) =>
        db
          .prepare(`UPDATE asks SET state = 'answered', answer = ?, answered_ts = ? WHERE id = ? AND state = 'sent' AND expires_ts > ?`)
          .run(choice, now(), id, now()).changes,
    );
    if (!took) return c.gone('This question is no longer waiting.');
    use((db) => db.prepare('UPDATE asks SET shown = 1 WHERE id = ?').run(id));
    await ui
      .edit(chatOf(row.chat), JSON.parse(row.ref), rendered(row, `<b>${esc(choice)} · ${hm(now())}</b>`), { html: true })
      .catch((e) => log(`could not update a question: ${errMsg(e)}`));
    return c.toast(can().edit ? choice : undefined);
  });

  // The owner wrote instead of tapping: the question is closed, unanswered, as Cancel would be.
  ui.heard((ev) => {
    const chat = String(ev.conversation ?? ev.chat);
    use((db) => db.prepare(`UPDATE asks SET state = 'withdrawn', answer = NULL WHERE chat = ? AND state = 'sent'`).run(chat));
  });

  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const rows = use((db) =>
        db
          .prepare(
            `SELECT * FROM asks WHERE state = 'new' OR (state IN ('expired', 'withdrawn') AND shown = 0 AND ref IS NOT NULL) OR (state = 'sent' AND expires_ts <= ?)`,
          )
          .all(now()),
      );
      for (const row of rows) await (row.state === 'new' ? send(row) : close(row));
    } catch (e) {
      log(`questions to the owner: ${errMsg(e)}`);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, everyMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer), tick };
}

async function send(row) {
  const chat = chatOf(row.chat);
  try {
    if (row.picture && !(await ui.sendFile(chat, row.picture).catch(() => false))) row.text += '\n\n(The picture could not be sent.)';
    const kb = actions();
    JSON.parse(row.choices).forEach((label, i) => kb.add(label, `ak:${row.id}:${i}`));
    const ref = await ui.send(chat, rendered(row, waitingFooter(row)), { html: true, actions: kb });
    // (Asked for meanwhile to stop: the message goes out and is closed at once below.)
    use((db) =>
      db
        .prepare(`UPDATE asks SET state = CASE state WHEN 'new' THEN 'sent' ELSE state END, ref = ? WHERE id = ?`)
        .run(JSON.stringify(ref ?? null), row.id),
    );
  } catch (e) {
    log(`could not ask the owner: ${errMsg(e)}`);
    use((db) => db.prepare(`UPDATE asks SET state = 'unsent' WHERE id = ? AND state = 'new'`).run(row.id));
  }
}

async function close(row) {
  const said = row.state === 'withdrawn' ? '<b>✖ Not answered: nothing was done</b>' : '<b>⌛ Expired, nothing was done</b>';
  use((db) =>
    db.prepare(`UPDATE asks SET shown = 1, state = CASE state WHEN 'sent' THEN 'expired' ELSE state END WHERE id = ?`).run(row.id),
  );
  await ui
    .edit(chatOf(row.chat), JSON.parse(row.ref), rendered(row, said), { html: true })
    .catch((e) => log(`could not close a question: ${errMsg(e)}`));
}
