import fs from 'node:fs';
import path from 'node:path';
import { dataPath, ownRefs, settingsFor } from '../../src/api.js';

// The login for the owner's own Telegram account. As sensitive as their phone:
// it can do anything the account can. The agent can never read this folder.
export const TG_DIR = dataPath('tg-account');
const SESSION = path.join(TG_DIR, 'session');

export const isLinked = () => {
  try {
    return fs.readFileSync(SESSION, 'utf8').trim().length > 0;
  } catch {
    return false;
  }
};
export const readSession = () => (isLinked() ? fs.readFileSync(SESSION, 'utf8').trim() : '');
export function writeSession(s) {
  fs.mkdirSync(TG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(SESSION, s, { mode: 0o600 });
}
export const clearSession = () => fs.rmSync(TG_DIR, { recursive: true, force: true });

// This plugin's settings: { apiId, apiHash, days, mode: 'all' | 'selected', chats: [ref…],
//             include: { bots, channels, big }, exclude: [ref…] }
const mine = settingsFor(import.meta.url);
export const tgaSettings = () => mine.get();
export const saveTgaSettings = (patch) => mine.set(patch);

// blackcat itself (its bot, when Telegram is how it talks to the owner). That chat is never
// collected, or the agent would read its own replies and reminders and react to them. The
// core says which chats those are, and its writer leaves them out in any case.
export const isOwn = (ref) => ownRefs().includes(ref);

export const BIG_GROUP = 500; // members; above this a group is treated like a channel

// Is this chat collected? `kind` is user | bot | group | supergroup | channel.
// Telegram's own service account: login codes and security alerts arrive here.
const TELEGRAM_SERVICE = 'tg:777000';

export function wanted(ref, kind, members, s = tgaSettings()) {
  if (isOwn(ref)) return false; // always, not configurable
  if (ref === TELEGRAM_SERVICE) return false; // login codes must never be stored where the agent can search
  if ((s.exclude ?? []).includes(ref)) return false;
  if (s.mode === 'selected') return (s.chats ?? []).includes(ref);
  if ((s.chats ?? []).includes(ref)) return true; // picked explicitly on top of the defaults
  const inc = s.include ?? {};
  if (kind === 'user' || kind === 'group') return true;
  if (kind === 'supergroup') return (members ?? 0) <= BIG_GROUP || !!inc.big;
  if (kind === 'bot') return !!inc.bots;
  if (kind === 'channel') return !!inc.channels;
  return false;
}

export function describeTga(s = tgaSettings()) {
  const depth = s.days ? `last ${s.days} days` : 'all history';
  if (s.mode === 'selected') return `${s.chats?.length ?? 0} selected chats, ${depth}`;
  const extra = Object.entries(s.include ?? {})
    .filter(([, v]) => v)
    .map(([k]) => ({ bots: 'bots', channels: 'channels', big: 'large groups' })[k]);
  return `private chats and groups${extra.length ? ` plus ${extra.join(', ')}` : ''}, ${depth}`;
}
