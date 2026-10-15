// This plugin's settings: { days, mode: 'all' | 'selected', chats: [ref…], selectedAt }
// Before `bc wa select` has run, mode is unset and everything within `days` is kept,
// so there is something to choose from.
import { settingsFor } from '../../src/api.js';
const mine = settingsFor(import.meta.url);
export const waSettings = () => mine.get();

export const saveWaSettings = (patch) => mine.set(patch);

export const cutoff = (w = waSettings()) => (w.days ? Math.floor(Date.now() / 1000) - w.days * 86400 : 0);

export function describeSelection(w = waSettings()) {
  const depth = w.days ? `last ${w.days} days` : 'all history';
  if (w.mode === 'all') return `all chats, ${depth}`;
  if (w.mode === 'selected') return `${w.chats?.length ?? 0} selected chats, ${depth}`;
  return `everything, ${depth} (not narrowed down yet → bc wa select)`;
}
