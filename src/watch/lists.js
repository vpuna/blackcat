// The entries of a list are grouped by their type: a watch's restaurants, events, wishes…
// (kept as the entry's `category`; the watch's commands still call each such group "a list",
// as they did before lists stood by themselves). Types come about by themselves: whoever files
// an entry (a reader going through messages, or the owner by hand) names its type, and a new
// name starts a new group. A watch may keep a type quiet, which keeps it out of its reports.

// "Restaurants", "wish list", "Wishes" and "wish" all mean the same list.
export function listKey(name) {
  let s = String(name ?? '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N} -]/gu, '');
  s = s.replace(/ ?lists?$/, '').trim();
  if (/ies$/.test(s)) s = `${s.slice(0, -3)}y`;
  else if (/(sh|ch|x|ss)es$/.test(s)) s = s.slice(0, -2);
  else if (/s$/.test(s) && !/ss$/.test(s)) s = s.slice(0, -1);
  return s.slice(0, 24) || 'other';
}

const LABELS = {
  waiting: 'Waiting on others',
  other: 'Other',
  unclear: 'Not sure what these are',
  shopping: 'Shopping',
  travel: 'Travel',
  info: 'Information',
};
// How a list is shown: "restaurant" → "Restaurants", "wish" → "Wishes".
export function listLabel(key) {
  if (LABELS[key]) return LABELS[key];
  const s = key.charAt(0).toUpperCase() + key.slice(1);
  if (/[^aeiou]y$/.test(s)) return `${s.slice(0, -1)}ies`;
  if (/(sh|ch|x|s)$/.test(s)) return `${s}es`;
  return `${s}s`;
}

export const quietLists = (w) => new Set((w.lists?.quiet ?? []).map(listKey));
export const isQuiet = (w, category) => quietLists(w).has(listKey(category ?? 'other'));

// The types on a list, with how many entries are still open in each; `w`: the watch that fills
// it, if any, for which are quiet. → [{ key, label, count, quiet }]
export function listsOf(db, listId, w = null) {
  const rows = db
    .prepare(
      "SELECT COALESCE(category, 'other') AS key, COUNT(*) AS count FROM watch_items WHERE list_id = ? AND status IN ('new', 'kept') GROUP BY 1 ORDER BY count DESC, key",
    )
    .all(listId);
  const quiet = w ? quietLists(w) : new Set();
  const out = rows.map((r) => ({ key: r.key, label: listLabel(r.key), count: r.count, quiet: quiet.has(r.key) }));
  // A quiet list that is empty for now still exists.
  for (const q of quiet) if (!out.some((l) => l.key === q)) out.push({ key: q, label: listLabel(q), count: 0, quiet: true });
  return out;
}
