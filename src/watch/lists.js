// A watch's items are grouped into lists: restaurants, events, wishes… A list is simply
// the items that share a `category`. Lists come about by themselves: whoever files an
// item (a reader going through messages, or the owner by hand) names the list it belongs to, and
// a new name starts a new list. A list can be marked quiet, which keeps it out of reports.

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

const LABELS = { other: 'Other', unclear: 'Not sure what these are', shopping: 'Shopping', travel: 'Travel', info: 'Information' };
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

// The lists of a watch, with how many items are still on each. → [{ key, label, count, quiet }]
export function listsOf(db, w) {
  const rows = db
    .prepare(
      "SELECT COALESCE(category, 'other') AS key, COUNT(*) AS count FROM watch_items WHERE watch_id = ? AND status IN ('new', 'kept') GROUP BY 1 ORDER BY count DESC, key",
    )
    .all(w.id);
  const quiet = quietLists(w);
  const out = rows.map((r) => ({ key: r.key, label: listLabel(r.key), count: r.count, quiet: quiet.has(r.key) }));
  // A quiet list that is empty for now still exists.
  for (const q of quiet) if (!out.some((l) => l.key === q)) out.push({ key: q, label: listLabel(q), count: 0, quiet: true });
  return out;
}
