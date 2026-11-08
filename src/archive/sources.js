// Where the messages in the archive come from. Each source is a plugin's, declared with
// `source` in its manifest (WhatsApp, Telegram and email are bundled plugins like any other).
// Nothing outside a plugin needs to know its source by name.
//
// A source is told from the others by how its ids begin: its chats and people are
// "<id>:…", and so are its messages, unless its message ids are another shape, which it
// then gives as `messageId` (WhatsApp's are WhatsApp's own; Telegram's "tg<chat>_<n>").
//
//   id            the prefix, a short lowercase word; one plugin's alone (src/plugins/registry.js)
//   label         what to call it ("Email")
//   messageId     a RegExp for its message ids, when they do not begin "<id>:"
//   optIn         true if it is not part of "all chats": a watch reads it only by naming one
//                 of its chats (the built-in to-do watch reads it unless told not to)
//   textLimit     characters of one message shown to a watch's reader (400 if not given)
//   todoLimit     the same, for the to-do watch (500 if not given)
//   connected()   is anything set up to collect from it?
//   fetchMedia(row, dest, id)   save a message's file to `dest` (`row.fetch`: what the source kept to fetch it)
//   collects(ref, db)   is this chat still being collected? (shown in the list of chats)
//   historyDays(id)   how many days back its history is fetched, for this message (a mail
//                 account's own); null: all of it. An undated list entry lapses that long after
//                 its last message (src/watch/db.js).

const sources = new Map();

// id → label. Kept as a plain object because that is how the rest of the code reads it.
export const SOURCES = {};

export const validSourceId = (id) => /^[a-z][a-z0-9]{1,15}$/.test(id ?? '');

// (Who may have a prefix is decided where the plugins are loaded: here it is only kept.)
export function registerSource(def) {
  if (!validSourceId(def?.id)) throw new Error('a source id is a short lowercase word');
  sources.set(def.id, def);
  SOURCES[def.id] = def.label ?? def.id;
}
// (Before the sources are registered again: the plugins were loaded again.)
export function resetSources() {
  sources.clear();
  for (const k of Object.keys(SOURCES)) delete SOURCES[k];
}

export const source = (id) => sources.get(id) ?? null;
export const added = () => [...sources.values()];
export const optIn = () => added().filter((s) => s.optIn);

const prefixOf = (id) => /^([a-z][a-z0-9]*):/.exec(String(id ?? ''))?.[1] ?? null;
// The source of a chat or a person. An id with a prefix nobody has registered (a plugin that
// was removed) still counts as that source.
export const sourceOf = (ref) => prefixOf(ref);
// The source of a message, by its id: its prefix, or the source whose message ids look like it.
// null when none does (its plugin is not there).
export const msgSource = (id) =>
  prefixOf(id) ?? [...sources.values()].find((s) => s.messageId instanceof RegExp && s.messageId.test(String(id ?? '')))?.id ?? null;
export const labelOf = (id) => SOURCES[id] ?? id;
// How far back the source of this message fetches its history, in days. → days | null
export function historyDays(msgId) {
  const s = source(msgSource(msgId));
  try {
    return s?.historyDays?.(msgId) || null;
  } catch {
    return null;
  }
}
// How each source is connected, in the words of the plugin that collects it: for "there are
// no messages yet". → ['WhatsApp (bc wa pair)', …]
export const howToConnect = () => [...sources.values()].filter((s) => s.link).map((s) => `${s.label} (${s.link})`);

// SQL condition limiting an id column to one source ('1' when no source is given).
// Written as ranges so the (chat_ref, ts) index can be used.
const range = (col, id) => `(${col} >= '${id}:' AND ${col} < '${id};')`;
export function sourceSql(col, id) {
  if (!id) return '1';
  if (!SOURCES[id]) throw new Error(`Unknown source "${id}". Use: ${Object.keys(SOURCES).join(', ')}`);
  return range(col, id);
}
// SQL condition: the column does not belong to a source that has to be asked for by name.
export const notOptInSql = (col) =>
  optIn()
    .map((s) => `NOT ${range(col, s.id)}`)
    .join(' AND ') || '1';
export const inSourceSql = range;
