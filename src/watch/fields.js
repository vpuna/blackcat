// What an entry on a list holds besides its title. A few things any list may use are kept in
// columns of their own, since a watch's readers fill them and the briefing reads them (`type`
// is what groups a list: a watch's restaurants, events, wishes…). Anything else is a field the
// owner adds to the list by name (`quantity`, `specs`, `aisle`), kept with each entry.
import { PluginError } from '../internal.js';

// field name → the entry's column
export const BUILT_IN = {
  type: 'category',
  note: 'summary',
  date: 'event_date',
  place: 'place',
  area: 'area',
  link: 'url',
  ref: 'reference',
};
export const KINDS = ['text', 'number', 'date'];
// Names an entry shows already, which a field would be mistaken for.
const SHOWN = new Set(['title', 'id', 'status', 'file', 'from', 'chat', 'sent', 'links', 'list', 'cameto', 'messageid', 'maybesameas']);
const DATE = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/;

const nameOf = (text) =>
  String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');

// "quantity:number" → { name: 'quantity', kind: 'number' }. A plain name is text.
export function fieldSpec(text) {
  const [raw, kind = 'text'] = String(text ?? '').split(':');
  const name = nameOf(raw);
  if (!/^[a-z][a-z0-9 _-]{0,23}$/.test(name))
    throw new PluginError(`"${raw}" can't be a field's name: a letter, then letters, digits, spaces, _ or -, up to 24.`);
  if (SHOWN.has(name.replace(/[ _-]/g, '')) || BUILT_IN[name]) throw new PluginError(`Every list has "${name}" already.`);
  if (!KINDS.includes(kind)) throw new PluginError(`A field is ${KINDS.join(', ')} ("${name}:number").`);
  return { name, kind };
}

// The field of a list a name refers to: { name, kind, column } for one every list has, or one
// the owner added; a name the list doesn't have is an error that says how to add it.
export function fieldOf(list, name) {
  const n = nameOf(name);
  if (BUILT_IN[n]) return { name: n, kind: n === 'date' ? 'day' : 'text', column: BUILT_IN[n] };
  const f = list.fields.find((x) => x.name === n);
  if (!f) throw new PluginError(`"${list.name}" has no field "${n}". Add it with: bc list field "${list.name}" add "${n}"`);
  return f;
}

// A value as typed, for a field of this kind → what is kept (null for "" : no value).
export function fieldValue(f, raw) {
  const v = String(raw ?? '').trim();
  if (v === '') return null;
  if (f.kind === 'number') {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new PluginError(`"${f.name}" is a number: not "${v}".`);
    return n;
  }
  if (f.kind === 'day' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new PluginError(`"${f.name}" is a day, YYYY-MM-DD: not "${v}".`);
  if (f.kind === 'date' && !DATE.test(v)) throw new PluginError(`"${f.name}" is a date, YYYY-MM-DD or YYYY-MM-DD HH:MM: not "${v}".`);
  return v.slice(0, 500);
}

// "quantity=3" → ['quantity', '3']
export function assignment(text) {
  const at = String(text ?? '').indexOf('=');
  if (at < 1) throw new PluginError(`Give a field as name=value: not "${text}".`);
  return [String(text).slice(0, at), String(text).slice(at + 1)];
}

export const valuesOf = (it) => (it?.fields ? JSON.parse(it.fields) : {});

// What --set name=value (and --unset name) change on an entry of `list`, as a patch for
// updateItem / addItem: the columns, and `fields` for the owner's own (merged into `had`).
export function patchOf(list, { set = [], unset = [] }, had = {}) {
  const patch = {};
  const own = { ...had };
  let ownChanged = false;
  const put = (name, value) => {
    const f = fieldOf(list, name);
    if (f.column) patch[COLUMN_KEY[f.column]] = value === null ? null : fieldValue(f, value);
    else {
      const v = value === null ? null : fieldValue(f, value);
      if (v === null) delete own[f.name];
      else own[f.name] = v;
      ownChanged = true;
    }
  };
  for (const a of set) put(...assignment(a));
  for (const n of unset) put(n, null);
  if (ownChanged) patch.fields = own;
  return patch;
}
// (The keys updateItem and addItem take for those columns.)
const COLUMN_KEY = {
  category: 'category',
  summary: 'summary',
  event_date: 'eventDate',
  place: 'place',
  area: 'area',
  url: 'url',
  reference: 'reference',
};

// The totals of a list's number fields over these entries: { quantity: 7 }.
export function totals(list, items) {
  const out = {};
  for (const f of list.fields.filter((x) => x.kind === 'number')) {
    const vals = items.map((i) => valuesOf(i)[f.name]).filter((v) => typeof v === 'number');
    if (vals.length) out[f.name] = vals.reduce((a, b) => a + b, 0);
  }
  return out;
}
