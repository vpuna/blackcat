// Saying something to the owner from anywhere: a command, a scheduled job, a plugin. It goes
// through whichever channel is in use; with none, nothing is sent (and the caller is told).
import { ownerChat } from '../owner.js';
import { ui } from './desk.js';
import { ensureCarrier } from './registry.js';

const CAPTION_MAX = 1000; // (a picture's caption is kept short on every channel)

const chatOfTurn = () => {
  const id = process.env.BLACKCAT_CHAT_ID;
  return id == null || id === '' ? null : /^-?\d+$/.test(id) ? Number(id) : id;
};

// Send the owner a message (for jobs and alerts). → true if it went. `picture`: a file in a
// folder the agent may read, sent with the message as its caption when it is short enough to
// be one, else first (the message still goes if the picture cannot).
export async function notifyOwner(text, { picture, ...opts } = {}) {
  const chat = chatOfTurn() ?? ownerChat();
  if (!chat || !(await ensureCarrier().catch(() => false))) return false;
  try {
    if (picture && String(text).length <= CAPTION_MAX && !opts.actions) {
      if (
        await ui.sendFile(chat, picture, { caption: String(text) }).then(
          () => true,
          () => false,
        )
      )
        return true;
    } else if (picture) await ui.sendFile(chat, picture).catch(() => false);
    await ui.send(chat, String(text).slice(0, 4000), opts);
    return true;
  } catch {
    return false;
  }
}

// A message that says how work is going, changed as it goes (one message, not one per step).
// → { update(text), done(text) }, or null when there is nowhere to send it. On a channel whose
// messages cannot be changed, only the first and the last are sent. Changes come no closer
// than `everyMs` (a service limits how often a message may be changed); the last is kept.
export async function progressOwner(text, { everyMs = 1500 } = {}) {
  // (Run as a step of something that shows its own steps, a shortcut: one list is enough.)
  if (process.env.BLACKCAT_PROGRESS === 'off') return null;
  const chat = chatOfTurn() ?? ownerChat();
  if (!chat || !(await ensureCarrier().catch(() => false))) return null;
  const { can } = await import('./desk.js');
  let ref;
  try {
    ref = await ui.send(chat, String(text).slice(0, 4000));
  } catch {
    return null;
  }
  let last = 0;
  let wanted = null;
  let timer = null;
  let chain = Promise.resolve();
  const edit = (t) =>
    (chain = chain.then(() => ui.edit(chat, ref, String(t).slice(0, 4000)).catch(() => {})).then(() => void (last = Date.now())));
  const flush = () => {
    timer = null;
    if (wanted != null) edit(wanted);
    wanted = null;
  };
  return {
    update(t) {
      if (!can().edit) return;
      wanted = t;
      if (!timer) timer = setTimeout(flush, Math.max(0, everyMs - (Date.now() - last)));
    },
    async done(t) {
      clearTimeout(timer);
      timer = null;
      wanted = null;
      if (can().edit) edit(t);
      else await ui.send(chat, String(t).slice(0, 4000)).catch(() => {});
      await chain;
    },
  };
}

// Say something in the chat this command is being run for, straight away (a "this will take
// a moment" while the answer is still being worked out). → false when it is not being run
// for a chat on a channel (your terminal, a scheduled job): nothing is sent.
export async function tellChat(text) {
  const chat = chatOfTurn();
  if (chat == null || !(await ensureCarrier().catch(() => false))) return false;
  try {
    await ui.send(chat, String(text).slice(0, 4000));
    return true;
  } catch {
    return false;
  }
}
