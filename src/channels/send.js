// Saying something to the owner from anywhere: a command, a scheduled job, a plugin. It goes
// through whichever channel is in use; with none, nothing is sent (and the caller is told).
import { ownerChat } from '../owner.js';
import { ui } from './desk.js';
import { ensureCarrier } from './registry.js';

const chatOfTurn = () => {
  const id = process.env.BLACKCAT_CHAT_ID;
  return id == null || id === '' ? null : /^-?\d+$/.test(id) ? Number(id) : id;
};

// Send the owner a message (for jobs and alerts). → true if it went.
export async function notifyOwner(text, opts) {
  const chat = chatOfTurn() ?? ownerChat();
  if (!chat || !(await ensureCarrier().catch(() => false))) return false;
  try {
    await ui.send(chat, String(text).slice(0, 4000), opts);
    return true;
  } catch {
    return false;
  }
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
