// This plugin's settings: { days, mode: 'all' | 'selected', chats: [ref…], exclude: [ref…], selectedAt }
// (`exclude`: chats left out of all the others; with only some picked, none is.)
// `days`: how far back history is fetched (when linking, and by recover); what is stored is
// kept however old it gets. Before `bc wa select` has run, mode is unset and every chat is
// collected, so there is something to choose from.
import { settingsFor } from '../../src/api.js';
const mine = settingsFor(import.meta.url);
// (Chats picked before WhatsApp's ids were marked "wa:" are read as marked.)
export const waSettings = () => {
  const w = mine.get();
  return w.chats?.some((c) => !c.startsWith('wa:')) ? { ...w, chats: w.chats.map((c) => (c.startsWith('wa:') ? c : `wa:${c}`)) } : w;
};

export const saveWaSettings = (patch) => mine.set(patch);

// Whether a chat is collected: not left out, and among those picked when only some are.
export const collects = (ref, w = waSettings()) =>
  !(w.exclude ?? []).includes(ref) && (w.mode !== 'selected' || (w.chats ?? []).includes(ref));

export const cutoff = (w = waSettings()) => (w.days ? Math.floor(Date.now() / 1000) - w.days * 86400 : 0);

export function describeSelection(w = waSettings()) {
  const depth = w.days ? `history ${w.days} days back` : 'all history';
  if (w.mode === 'all') return `all chats${w.exclude?.length ? `, ${w.exclude.length} left out` : ''}, ${depth}`;
  if (w.mode === 'selected') return `${w.chats?.length ?? 0} selected chats, ${depth}`;
  return `everything, ${depth} (not narrowed down yet → bc wa select)`;
}
