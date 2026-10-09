// The desk: where everything the owner says arrives, and everything they are shown leaves
// from, whichever channel is in use. A channel (Telegram, Slack, …) only carries: it hands
// what the owner wrote or tapped to the desk, and sends what the desk gives it.
//
// For the core and for plugins this is `ui`:
//
//   ui.command('reminders', (c) => c.reply('…'))        the owner typed /remind
//   ui.action(/^rm:(\d+):d$/, (c) => { c.match[1] … })   the owner tapped a button
//   ui.text((c, next) => …)                              any other text, before the agent gets it
//   ui.send(chat, 'text', { html, actions })             say something unprompted → a reference
//   ui.edit(chat, ref, 'text', { … }) · ui.setActions(chat, ref, actions | null) · ui.remove(chat, ref)
//   ui.sendFile(chat, '/path', { caption })
//
// A handler is given `c`, the moment it is answering:
//
//   c.chat  c.who  c.text  c.args  c.match  c.ref
//   c.reply(text, opts)   c.edit(text, opts)   c.setActions(a)   c.clearActions()
//   c.toast('Saved')      c.working()          c.remove()        c.sendFile(path, caption)
import fs from 'node:fs';
import path from 'node:path';
import { ownerDoing } from '../activity/log.js';
import { log } from '../log.js';
import { chunks, message, plain } from './kit.js';
import { resolveHome } from '../util/paths.js';

const commandHandlers = new Map(); // name → [handlers], asked in the order they were added
const actionHandlers = []; // [{ pattern, fn }], tried in the order they were added
const textHandlers = []; // [(c, next) => …]
let fallback = null; // what happens to text nobody else took (set by the core: the agent)
let carrier = null; // the channel in use: what actually sends

// The channel that carries messages, for this process. In the agent service it is the
// running channel; in a command or a job it is the same channel, opened only to send.
export function setCarrier(c) {
  carrier = c;
}
export const hasCarrier = () => !!carrier;
// The channel's own object (the Telegram bot, say), for plugins written against it directly.
export const nativeOf = () => carrier?.native ?? null;
const out = () => {
  if (!carrier) throw new Error('no channel is active: there is nowhere to send this');
  return carrier;
};
export const can = () => ({
  buttons: false,
  edit: false,
  files: false,
  html: false,
  maxChars: 4000,
  label: carrier?.label,
  ...carrier?.can,
});

const expand = resolveHome;

export const ui = {
  // The owner typed /name. Several may answer to one name: each is given `next`, to pass it
  // on to the one added after it (and, after the last, to whatever takes ordinary text).
  command(name, fn) {
    commandHandlers.set(name, [...(commandHandlers.get(name) ?? []), fn]);
  },
  action(pattern, fn) {
    actionHandlers.push({ pattern, fn });
  },
  text(fn) {
    textHandlers.push(fn);
  },
  // Say something. → a reference to the message, for edit / setActions / remove.
  // (One too long for the channel goes as several, cut at line ends, with any buttons under
  // the last. It is sent as plain text then: formatting cut in half would be refused.)
  send: async (chat, body, opts) => {
    const m = fit(chat, message(body, opts));
    const max = can().maxChars ?? 4000;
    if ((m.text ?? '').length <= max) return out().send(chat, m);
    const parts = chunks(m.html ? plain(m.text) : m.text, max);
    let ref;
    for (const [i, text] of parts.entries())
      ref = await out().send(chat, { ...m, text, html: false, actions: i === parts.length - 1 ? m.actions : null });
    return ref;
  },
  // Change a message already sent. On a channel that cannot, the new version is sent as a message of its own.
  edit: async (chat, ref, body, opts) =>
    can().edit ? out().edit(chat, ref, fit(chat, message(body, opts))) : void (await out().send(chat, fit(chat, message(body, opts)))),
  // Change, or (null) take away, a message's buttons.
  async setActions(chat, ref, a) {
    const rows = a ? message('', { actions: a }).actions : null;
    if (can().buttons && can().edit) return out().setActions(chat, ref, rows);
    if (!can().buttons) numbered.delete(offerKey(chat)); // the choices that were offered are no longer open
    return undefined;
  },
  // Take a message away (one that held a secret, say). Fails on a channel that cannot, so the caller can say so.
  async remove(chat, ref) {
    if (!out().remove) throw new Error('a message cannot be taken back on this channel');
    return out().remove(chat, ref);
  },
  // (Not while the owner is being asked to choose by number: it is their turn, and nothing is being worked on.)
  working: async (chat, kind = 'typing') => (awaiting.has(offerKey(chat)) ? undefined : out().working?.(chat, kind)),
  // Send a file the bot is allowed to send (see files.js). → true if it went.
  async sendFile(chat, requested, { caption } = {}) {
    const { sendable } = await import('./files.js');
    const file = sendable(requested);
    if (!file || fs.statSync(file).size > (can().maxFileBytes ?? Infinity)) return false;
    await out().sendFile(chat, file, { caption });
    return true;
  },
  // The commands to offer in the channel's own menu, if it has one.
  setMenu: async (commands) => out().setMenu?.(commands),
};

// ---- for a channel that can do less ----
// No buttons: the actions are listed under the message with numbers, and the owner answers
// with a number. No HTML: the tags are taken out.
const numbered = new Map(); // chat → the ids of the actions last offered there, in order
// (A channel that is one conversation and nothing else, the terminal, has one set of choices.)
const offerKey = (chat) => (can().oneChat ? '*' : String(chat));
const awaiting = new Set(); // chats where a numbered choice has just been offered and not yet answered or passed over
function fit(chat, m) {
  const c = can();
  let { text } = m;
  if (m.html && !c.html) text = plain(text);
  if (m.actions && !c.buttons) {
    const flat = m.actions.flat();
    numbered.set(
      offerKey(chat),
      flat.map((a) => a.id),
    );
    awaiting.add(offerKey(chat));
    text = `${text}\n\n${flat.map((a, i) => `${i + 1}. ${a.label}`).join('\n')}\n(Answer with a number.)`;
    return { ...m, text, html: m.html && !!c.html, actions: null };
  }
  return { ...m, text, html: m.html && !!c.html };
}

// The moment a handler is answering: who, where, what, and ways to respond.
function moment(ev) {
  const c = {
    chat: ev.chat,
    who: ev.who ?? 'owner',
    text: ev.text ?? null,
    ref: ev.ref ?? null,
    args: '',
    match: null,
    forwarded: ev.forwarded ?? null,
    // Which conversation with the agent this belongs to. On most channels that is the chat;
    // the terminal keeps its own, whichever channel the owner's things belong to.
    conversation: ev.conversation ?? ev.chat,
    reply: (body, opts) => ui.send(ev.chat, body, opts),
    edit: (body, opts) => ui.edit(ev.chat, ev.ref, body, opts),
    setActions: (a) => ui.setActions(ev.chat, ev.ref, a),
    clearActions: () => ui.setActions(ev.chat, ev.ref, null),
    remove: () => ui.remove(ev.chat, ev.ref),
    working: (kind) => ui.working(ev.chat, kind).catch(() => {}),
    // A brief acknowledgement of a tap (a channel without such a thing does nothing).
    // The same, for a tap that could do nothing: what it was about is gone. (Noted as such.)
    gone: async (text) => {
      ev.gone = true;
      return c.toast(text);
    },
    at: ev.at ?? null,
    toast: async (text) => {
      ev.toasted = true;
      if (carrier?.toast) return out().toast(ev, text == null ? undefined : String(text));
      // No such thing here: what it would have said is said as a message, when it says anything.
      return text ? void (await out().send(ev.chat, fit(ev.chat, message(text)))) : undefined;
    },
    // Send a file, saying so in the chat when it cannot be sent.
    async sendFile(requested, caption) {
      const { sendable } = await import('./files.js');
      let real;
      try {
        real = fs.realpathSync(expand(requested));
      } catch {
        return c.reply(`😿 File not found: ${requested}`);
      }
      if (!sendable(real)) return c.reply(`😿 Not allowed to send ${requested}`);
      const { size } = fs.statSync(real);
      const max = can().maxFileBytes;
      if (max && size > max) return c.reply(`😿 ${path.basename(real)} is too big to send here (${(size / 1024 ** 2).toFixed(0)} MB)`);
      return out().sendFile(ev.chat, real, { caption });
    },
  };
  return c;
}

const COMMAND = /^\/([A-Za-z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/;

// How long something waited before blackcat had it, where the channel says when it was
// written (`ev.at`, in seconds): only when that is long enough to matter.
const waited = (ev) => {
  const s = ev?.at ? Date.now() / 1000 - ev.at : 0;
  return s >= 5 && s < 7 * 86400 ? { waitedS: Math.round(s) } : {};
};

// ---- what a channel calls ----

export const desk = {
  // The owner wrote something. ev: { chat, who, text, ref }
  // (The channel has already made sure it is the owner. A forwarded message, or one with
  // files, comes through desk.forwarded / desk.files instead.)
  async text(ev) {
    awaiting.delete(offerKey(ev.chat));
    // On a channel without buttons, a number is the answer to the choices last offered.
    const offered = numbered.get(offerKey(ev.chat));
    const n = offered && /^\s*(\d{1,2})\s*$/.exec(ev.text ?? '');
    if (n && offered[Number(n[1]) - 1]) {
      numbered.delete(offerKey(ev.chat));
      return desk.action({ chat: ev.chat, conversation: ev.conversation, who: ev.who, id: offered[Number(n[1]) - 1], ref: null });
    }
    const c = moment(ev);
    const m = COMMAND.exec(ev.text ?? '');
    const forCommand = (m && commandHandlers.get(m[1].toLowerCase())) || [];
    if (forCommand.length) {
      c.args = (m[2] ?? '').trim();
      c.match = c.args;
    }
    // Those that answer to the command first, then whoever takes text, then the agent.
    const chain = [...forCommand, ...textHandlers];
    let i = 0;
    let toAgent = false;
    const next = async () => {
      const h = chain[i++];
      if (!h) toAgent = true;
      return h ? h(c, next) : fallback?.(c);
    };
    if (!m) return next();
    // A command typed in the chat is something the owner did: noted by its name and first
    // word, not its text; with how long it took, whether it failed, and whether it was a
    // command of blackcat's or was left to the agent (whose turn is then part of the time).
    const words = (m[2] ?? '').trim().split(/\s+/).filter(Boolean);
    const typed = `/${m[1].toLowerCase()}${words[0] ? ` ${words[0].slice(0, 30)}` : ''}${words.length > 1 ? ' …' : ''}`;
    return ownerDoing('typed', typed, next, { surface: 'chat', data: () => ({ by: toAgent ? 'agent' : 'command', ...waited(ev) }) });
  },
  // The owner tapped a button. ev: { chat, who, id, ref, … whatever the channel needs to acknowledge it }
  async action(ev) {
    const c = moment(ev);
    // A button tapped: noted by what the button said (where the channel can tell) and its
    // id, with how long what it set off took, and whether that failed.
    const tapped = `${ev.label ? `"${String(ev.label).slice(0, 40)}" · ` : ''}${String(ev.id ?? '').slice(0, 60)}`;
    let known = false;
    return ownerDoing(
      'tapped',
      tapped,
      async () => {
        for (const { pattern, fn } of actionHandlers) {
          const match = typeof pattern === 'string' ? (pattern === ev.id ? [ev.id] : null) : pattern.exec(ev.id);
          if (!match) continue;
          known = true;
          c.match = match;
          try {
            return await fn(c);
          } finally {
            // A tap is always acknowledged, so the channel is not left showing it as pending.
            if (!ev.toasted) await c.toast().catch(() => {});
          }
        }
        return c.toast().catch(() => {});
      },
      { surface: 'chat', data: () => ({ ...(known ? {} : { unknown: true }), ...(ev.gone ? { gone: true } : {}), ...waited(ev) }) },
    );
  },
  moment,
  // Text nobody else took (the core sends it to the agent).
  setFallback(fn) {
    fallback = fn;
  },
  log,
  chunks,
};

// For tests: forget every handler.
export function resetDesk() {
  commandHandlers.clear();
  numbered.clear();
  actionHandlers.length = 0;
  textHandlers.length = 0;
  fallback = null;
  carrier = null;
}
