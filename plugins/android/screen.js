// What is on a device's screen, from uiautomator's XML: every element with its text,
// description, id and place, and the ways a routine names one (its "target").

const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITY[e] ?? m),
  );

// → the root, each node { attrs…, bounds: [x1, y1, x2, y2], children, parent }
export function parse(xml) {
  const root = { children: [], parent: null, depth: -1 };
  let at = root;
  for (const m of String(xml).matchAll(/<node\b([^>]*?)(\/?)>|<\/node>/g)) {
    if (!m[0].startsWith('<node')) {
      at = at.parent ?? root;
      continue;
    }
    const n = { children: [], parent: at, depth: at.depth + 1 };
    for (const [, k, v] of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) n[k] = decode(v);
    const b = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(n.bounds ?? '');
    n.bounds = b ? b.slice(1).map(Number) : [0, 0, 0, 0];
    at.children.push(n);
    if (!m[2]) at = n;
  }
  return root;
}

export function* walk(n) {
  for (const c of n.children) {
    yield c;
    yield* walk(c);
  }
}

export const idOf = (n) => (n['resource-id'] ?? '').split(':id/').pop();
const area = (n) => Math.max(0, n.bounds[2] - n.bounds[0]) * Math.max(0, n.bounds[3] - n.bounds[1]);
export const middle = (n) => [(n.bounds[0] + n.bounds[2]) / 2, (n.bounds[1] + n.bounds[3]) / 2];

// The words a person would read on it: its own text or description, else its children's.
export function labelOf(n) {
  const own = n.text || n['content-desc'];
  if (own) return own.trim();
  const words = [];
  for (const c of walk(n)) if (c.text || c['content-desc']) words.push((c.text || c['content-desc']).trim());
  return words.join(' · ').slice(0, 120);
}

// A target, in uiautomator2's selector names: text, textContains, description,
// descriptionContains, resourceId, className, package, clickable, focused (where a TV remote's
// arrows have got to), instance (the n-th match).
export const TARGET_KEYS = [
  'text',
  'textContains',
  'description',
  'descriptionContains',
  'resourceId',
  'className',
  'package',
  'clickable',
  'focused',
  'below',
  'width',
  'instance',
];

// A target by words alone never names a text field: words in a field are what was typed
// there, not something to tap (the result "AA batteries" below a field holding "AA batteries").
// A field is named by its id or its class.
export function matches(n, t) {
  if ((n.class ?? '').endsWith('EditText') && !t.resourceId && !t.className) return false;
  for (const [k, want] of Object.entries(t)) {
    if (k === 'instance' || k === 'below') continue;
    const ok = {
      text: () => (n.text ?? '') === want,
      // (Words a routine looks for within others are matched without case: an app writes
      // "Aa Batteries" where the owner wrote "AA batteries".)
      textContains: () => (n.text ?? '').toLowerCase().includes(String(want).toLowerCase()),
      description: () => (n['content-desc'] ?? '') === want,
      descriptionContains: () => (n['content-desc'] ?? '').toLowerCase().includes(String(want).toLowerCase()),
      resourceId: () => n['resource-id'] === want || idOf(n) === want,
      className: () => n.class === want || (n.class ?? '').endsWith(`.${want}`),
      package: () => n.package === want,
      clickable: () => (n.clickable === 'true') === want,
      focused: () => (n.focused === 'true') === want,
      // (As wide as the rows of a list, give or take a few pixels: its rows, not the buttons and
      // map pins around it.)
      width: () => Math.abs(n.bounds[2] - n.bounds[0] - want) <= 6,
    }[k];
    if (!ok?.()) return false;
  }
  return area(n) > 0;
}

// The elements a target names, in screen order (or only its n-th).
// `below`: only those under an element, the first the inner target names. A list's first row,
// whatever it says: { below: { textContains: 'Select a point' }, clickable: true, width: 912,
// instance: 0 } (the width is its rows', which the buttons and pins around it do not share).
export function find(root, t) {
  let all = [...walk(root)].filter((n) => matches(n, t));
  if (t.below) {
    const over = find(root, t.below)[0];
    all = over ? all.filter((n) => n.bounds[1] >= over.bounds[3] && n !== over) : [];
  }
  // Words looked for within others: the closest first. What says exactly those words, then
  // what starts with them, then the rest, each in screen order ("Home" before "homee").
  const want = (t.textContains ?? '').toLowerCase();
  if (want) {
    const rank = (n) => {
      const x = (n.text ?? '').trim().toLowerCase();
      return x === want ? 0 : x.startsWith(want) && !/\w/.test(x[want.length] ?? '') ? 1 : x.startsWith(want) ? 2 : 3;
    };
    all = all
      .map((n, i) => [rank(n), i, n])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1])
      .map((x) => x[2]);
  }
  return t.instance == null ? all : all.slice(t.instance, t.instance + 1);
}

export const describeTarget = (t) =>
  Object.entries(t)
    .map(([k, v]) => (k === 'text' ? `"${v}"` : k === 'below' ? `below ${describeTarget(v)}` : `${k} ${JSON.stringify(v)}`))
    .join(', ');

// A target as the owner reads it: "Place order", the first item below "Choose a seller", the
// search field. (describeTarget is the exact form, for logs and the routine's own messages.)
const ORDINAL = ['first', 'second', 'third', 'fourth', 'fifth'];
export function spoken(t) {
  if (!t) return 'it';
  const words = t.text ?? t.textContains ?? t.description ?? t.descriptionContains;
  const nth = t.instance != null ? (ORDINAL[t.instance] ?? `${t.instance + 1}th`) : null;
  if (t.below) return `the ${nth ?? 'first'} ${words ? `"${words}" ` : ''}item below "${spoken(t.below).replace(/^"|"$/g, '')}"`;
  if (words) return `${nth && t.instance > 0 ? `the ${nth} ` : ''}"${words}"`;
  if (t.resourceId) return `the ${nth && t.instance > 0 ? `${nth} ` : ''}${t.resourceId.replace(/[_-]+/g, ' ')}`;
  if (t.className) return `the ${String(t.className).split('.').pop()}`;
  return 'it';
}

// One target or a few, any of which will do: "Order placed" or "Order confirmed".
export const spokenAny = (t) => [t].flat().filter(Boolean).map(spoken).join(' or ') || 'it';

// The elements worth listing for a person or a model: those with words, an id, or a touch.
function innerWords(n) {
  let desc = null;
  for (const c of walk(n)) {
    if (c.text?.trim()) return { text: c.text.trim() };
    desc ??= c['content-desc']?.trim() || null;
  }
  return desc ? { description: desc } : undefined;
}

export function elements(root) {
  const out = [];
  for (const n of walk(root)) {
    const text = n.text?.trim() || null;
    const description = n['content-desc']?.trim() || null;
    const id = idOf(n) || null;
    const tap = n.clickable === 'true';
    if (!area(n) || !(text || description || (tap && (id || labelOf(n))) || n.class?.endsWith('EditText'))) continue;
    out.push({
      text,
      description,
      id,
      label: tap && !text && !description ? labelOf(n) || null : null,
      // (For one whose words are its children's: the first child's own text, by which it is
      // found again; a description only when no child has text.)
      inner: tap && !text && !description ? innerWords(n) : undefined,
      tap,
      field: n.class?.endsWith('EditText') || undefined,
      focused: n.focused === 'true' || undefined,
      bounds: n.bounds,
    });
  }
  return out;
}

// The app's own screen: what another app draws over it (a notification sliding in, the
// status bar, a keyboard) left out. → a copy of the tree.
export function appOnly(root, pkg) {
  if (!pkg) return root;
  const copy = (n, parent) => {
    const c = { ...n, parent };
    c.children = n.children.filter((k) => !k.package || k.package === pkg).map((k) => copy(k, c));
    return c;
  };
  return copy(root, null);
}

export const packageOf = (root) => {
  const counts = {};
  for (const n of walk(root)) if (n.package) counts[n.package] = (counts[n.package] ?? 0) + area(n);
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};

// One line per element, for `bc android screen` and for a model.
export function screenText(els) {
  return els
    .map((e) => {
      const words = [e.text && `"${e.text}"`, e.description && `(${e.description})`, e.label && `[${e.label}]`].filter(Boolean).join(' ');
      const tags = [e.tap && 'tap', e.field && 'field', e.focused && 'focused', e.id && `id ${e.id}`].filter(Boolean).join(', ');
      return `- ${words || '(no words)'}${tags ? `  · ${tags}` : ''}`;
    })
    .join('\n');
}
