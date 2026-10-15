// Where the messages in the archive come from. WhatsApp and Telegram are collected by
// blackcat itself; any plugin can add another source (email does) by declaring `source`
// in its manifest. Nothing outside a plugin needs to know its source by name.
//
// A source is told from the others by how its ids begin: its chats and people are
// "<id>:…", and so are its messages. Two exceptions from before this rule existed:
// WhatsApp ids have no prefix at all, and Telegram message ids are "tg<chat>_<n>".
//
//   id            the prefix, a short lowercase word
//   label         what to call it ("Email")
//   optIn         true if it is not part of "all chats": a watch reads it only by naming one
//                 of its chats (the built-in to-do watch reads it unless told not to)
//   textLimit     characters of one message shown to a watch's reader (400 if not given)
//   todoLimit     the same, for the to-do watch (500 if not given)
//   connected()   is anything set up to collect from it?
//   fetchMedia(row, dest, id)   save a message's file to `dest`
//   collects(ref, db)   is this chat still being collected? (shown in the list of chats)

const BUILT_IN = [
  { id: 'wa', label: 'WhatsApp' },
  { id: 'tg', label: 'Telegram' },
];
const sources = new Map(BUILT_IN.map((s) => [s.id, s]));

// id → label. Kept as a plain object because that is how the rest of the code reads it.
export const SOURCES = Object.fromEntries(BUILT_IN.map((s) => [s.id, s.label]));

// `own`: the plugin that collects one of the two sources the archive already knows by its
// id format (WhatsApp, Telegram) describes it; no other plugin may take those ids.
export function registerSource(def, { own = false } = {}) {
  if (!/^[a-z][a-z0-9]{1,15}$/.test(def?.id ?? '')) throw new Error('a source id is a short lowercase word');
  const builtIn = BUILT_IN.find((b) => b.id === def.id);
  if (builtIn && !own) throw new Error(`"${def.id}" is one of blackcat's own sources`);
  // One plugin to a source: the first to bring a kind of message in is the one that says what it is.
  const has = sources.get(def.id);
  if (has?.plugin && def.plugin && has.plugin !== def.plugin)
    throw new Error(`messages of the kind "${def.id}" are already brought in by the ${has.plugin} plugin`);
  sources.set(def.id, builtIn ? { ...builtIn, ...def } : def);
  SOURCES[def.id] = def.label ?? builtIn?.label ?? def.id;
}

export const source = (id) => sources.get(id) ?? null;
export const added = () => [...sources.values()].filter((s) => !BUILT_IN.some((b) => b.id === s.id));
export const optIn = () => added().filter((s) => s.optIn);

const prefixOf = (id) => /^([a-z][a-z0-9]*):/.exec(String(id ?? ''))?.[1] ?? null;
// The source of a chat or a person. An id with a prefix nobody has registered (a plugin that
// was removed) still counts as that source, so its rows are not mistaken for WhatsApp.
export const sourceOf = (ref) => prefixOf(ref) ?? 'wa';
export const msgSource = (id) => (/^tg-?\d+_\d+$/.test(String(id ?? '')) ? 'tg' : (prefixOf(id) ?? 'wa'));
export const labelOf = (id) => SOURCES[id] ?? id;
// How each source is connected, in the words of the plugin that collects it: for "there are
// no messages yet". → ['WhatsApp (bc wa pair)', …]
export const howToConnect = () => [...sources.values()].filter((s) => s.link).map((s) => `${s.label} (${s.link})`);

// SQL condition limiting an id column to one source ('1' when no source is given).
// Written as ranges so the (chat_ref, ts) index can be used.
const range = (col, id) => `(${col} >= '${id}:' AND ${col} < '${id};')`;
export function sourceSql(col, id) {
  if (!id) return '1';
  if (!SOURCES[id]) throw new Error(`Unknown source "${id}". Use: ${Object.keys(SOURCES).join(', ')}`);
  if (id !== 'wa') return range(col, id);
  // WhatsApp is whatever belongs to none of the others.
  return [...sources.keys()]
    .filter((k) => k !== 'wa')
    .map((k) => `NOT ${range(col, k)}`)
    .join(' AND ');
}
// SQL condition: the column does not belong to a source that has to be asked for by name.
export const notOptInSql = (col) =>
  optIn()
    .map((s) => `NOT ${range(col, s.id)}`)
    .join(' AND ') || '1';
export const inSourceSql = range;
