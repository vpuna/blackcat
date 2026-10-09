import { load } from './config.js';

// Who reminders, watches and reports belong to: the owner, at their chat on the channel in
// use (the Telegram bot, say). With no channel, everything is still kept, under LOCAL, and
// shown in `bc chat`; when a channel is set up later, those rows are handed over to it.
export const LOCAL = 0;

// The owner on the channel in use: { chat, name }, or null. A channel plugin keeps this in
// its settings as `owner`, so it is known without loading the plugin.
// (`telegram` at the top of the settings file is where the bot kept it before it was a plugin.)
export function owner() {
  const cfg = load();
  const o = cfg.channel ? cfg.plugins?.settings?.[cfg.channel]?.owner : null;
  if (o?.chat != null) return o;
  const t = !cfg.channel && cfg.telegram?.token ? cfg.telegram.allow?.[0] : null;
  return t ? { chat: t.id, name: t.name } : null;
}

// Is there a channel to reach the owner through? (The name is from when the bot was the only one.)
export const hasBot = () => !!owner();

// BLACKCAT_CHAT_ID is set for a conversation with the agent started from a chat on the channel.
const chatOfTurn = () => {
  const id = process.env.BLACKCAT_CHAT_ID;
  return id == null || id === '' ? null : /^-?\d+$/.test(id) ? Number(id) : id;
};
export const ownerChat = () => chatOfTurn() || owner()?.chat || LOCAL;

// Give what was created before a channel was set up to the owner's chat on it.
export function adopt(db, table) {
  const id = owner()?.chat;
  if (id) db.prepare(`UPDATE ${table} SET chat_id = ? WHERE chat_id = ?`).run(id, LOCAL);
}
