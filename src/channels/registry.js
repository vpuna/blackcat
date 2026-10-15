// Which channels there are, and which one is in use.
//
// A channel is a plugin whose manifest has `channel`:
//
//   channel: {
//     label: 'Telegram',
//     can: { buttons, edit, files, voice, html, maxChars, maxFileBytes },
//     paired: (ctx) => boolean,          set up, and linked to the owner
//     open:  async (ctx) => carrier,     to send only (a command, a scheduled job)
//     start: async (ctx, host) => carrier with run() and stop(),   to send and receive (the agent service)
//     self:  (ctx) => ['tg:12345'],      optional: blackcat itself, as a source would see it (see ownRefs below)
//   }
//
// A carrier is what actually talks to the service:
//
//   { can, label, send(chat, message) → ref, edit(chat, ref, message), setActions(chat, ref, rows | null),
//     remove(chat, ref), toast(event, text), working(chat, kind), sendFile(chat, path, { caption }), setMenu(commands) }
//
// and what it receives it hands to `host`: host.incoming(event) for what the owner wrote or
// sent, host.action(event) for a button tapped. The channel is responsible for one thing
// above all: only the paired owner, in a private conversation, ever reaches the host.
//
// The plugin keeps who the owner is in its settings as `owner: { chat, name }`, so the core
// knows where to send without loading it.
//
// Any number of channels may be installed and paired. ONE is in use at a time (`channel` in
// config.json), chosen in a terminal: `bc channel use <name>`. The terminal (`bc chat`) is
// always there beside it.
import { load, update } from '../config.js';
import { everyKnown, findLoaded, loadPlugins, loaded, makeCtx, mountOf } from '../plugins/registry.js';
import { hasCarrier, setCarrier } from './desk.js';

export const channelPlugins = () => loaded().filter((p) => p.manifest.channel);

// blackcat itself, as the sources see it: the refs under which a chat with one of its
// channels would turn up in the archive (its Telegram bot, as the owner's own Telegram
// account sees it). Such a chat is blackcat talking to its owner: were it collected, the
// agent would read its own replies and reminders and react to them. So it never is. The
// archive's writer leaves these out whatever a source does, and a source asks here so as
// not to offer them. Every channel that is set up counts, in use or not.
let own = { at: 0, refs: [] };
export function ownRefs() {
  // (Asked for every message a source stores; what it rests on changes only at a pairing.)
  if (Date.now() - own.at < 5000) return own.refs;
  const refs = [];
  for (const p of channelPlugins()) {
    if (!p.manifest.channel.self) continue;
    try {
      for (const r of p.manifest.channel.self(makeCtx(p, { caller: 'job', surface: 'job' })) ?? [])
        if (typeof r === 'string' && r) refs.push(r);
    } catch {
      // (a channel that cannot say names none just now)
    }
  }
  own = { at: Date.now(), refs };
  return refs;
}
// (For tests, and after a pairing in the same process.)
export const forgetOwnRefs = () => void (own = { at: 0, refs: [] });
export const activeName = () => load().channel ?? null;
// What a channel is called, for people: 'Telegram' for tg-bot. One that is not there goes by its name.
export const labelOf = (name) =>
  name === 'terminal' ? 'the terminal' : (everyKnown().find((p) => p.name === name)?.manifest.channel?.label ?? name);
// Where the owner is reached, in a word, for a sentence: "sent to Telegram". With no channel in use: 'the chat'.
export const channelLabel = () => (activeName() ? labelOf(activeName()) : 'the chat');

// The channel in use, if it is there and paired: { plugin, def, ctx }.
export function activeChannel() {
  const p = findLoaded(activeName());
  if (!p?.manifest.channel) return null;
  const ctx = makeCtx(p, { caller: 'owner', surface: 'job' });
  let paired = false;
  try {
    paired = !!p.manifest.channel.paired(ctx);
  } catch {}
  return paired ? { plugin: p, def: p.manifest.channel, ctx } : null;
}

// Every channel, for `bc channel`: { name, label, paired, active }.
export function listChannels() {
  return channelPlugins().map((p) => {
    let paired = false;
    try {
      paired = !!p.manifest.channel.paired(makeCtx(p));
    } catch {}
    return { name: p.name, label: p.manifest.channel.label ?? p.manifest.title, paired, active: p.name === activeName() };
  });
}

// In a command or a job: make the channel in use available for sending. → false if there is none.
export async function ensureCarrier() {
  if (hasCarrier()) return true;
  await loadPlugins();
  const a = activeChannel();
  if (!a) return false;
  setCarrier(await a.def.open(a.ctx));
  return true;
}

// Make `name` the channel in use (null: none). What belongs to the owner follows them: it
// is kept against their chat on the old channel, and is handed to their chat on the new one.
// → { from, to, moved } or throws with why not.
export async function useChannel(name) {
  await loadPlugins();
  const was = activeName();
  const ownerOf = (n) => (n ? (load().plugins?.settings?.[n]?.owner?.chat ?? null) : null);
  if (name != null) {
    const p = findLoaded(name);
    if (!p?.manifest.channel) throw new Error(`"${name}" is not a channel. See: bc channel`);
    if (!p.manifest.channel.paired(makeCtx(p)))
      throw new Error(`${p.manifest.channel.label ?? name} is not set up yet. Pair it first: bc ${mountOf(p.manifest).join(' ')} pair`);
  }
  const from = ownerOf(was) ?? 0;
  const to = ownerOf(name) ?? 0;
  update((cfg) => {
    if (name == null) delete cfg.channel;
    else cfg.channel = name;
  });
  // Whatever was to be sent to the owner where they were, goes where they are now: each part
  // that keeps such things moves its own (`ownerMoved`).
  let moved = 0;
  if (from !== to) {
    for (const p of loaded()) {
      if (!p.manifest.ownerMoved) continue;
      try {
        moved += Number(await p.manifest.ownerMoved(makeCtx(p, { caller: 'owner', surface: 'job' }), { from, to })) || 0;
      } catch (e) {
        console.error(`${p.manifest.title} could not move with you: ${e.message}`);
      }
    }
  }
  return { from: was, to: name, moved };
}
