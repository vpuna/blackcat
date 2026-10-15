// The pieces a message to the owner is made of, whichever channel carries it.
//
// A message is text, optionally in a small subset of HTML (<b> <i> <u> <s> <code> <pre>
// <a href> <blockquote>: what every chat service can show, or can do without), optionally
// with ACTIONS: labelled buttons in rows, each with an id that comes back when it is
// tapped. A channel that has no buttons shows them as a numbered list.
//
// An action's id is yours to choose; keep it short (64 bytes at most, a limit of the
// strictest channel) and start it with something of your own ("rm:12:d"), since every
// plugin's ids share one space.

export class Actions {
  constructor() {
    this.rows = [[]];
  }

  // A button on the current row.
  add(label, id) {
    this.rows.at(-1).push({ label: String(label), id: String(id) });
    return this;
  }

  // Start a new row.
  row() {
    if (this.rows.at(-1).length) this.rows.push([]);
    return this;
  }

  // The rows that have something in them.
  get list() {
    return this.rows.filter((r) => r.length);
  }
}
export const actions = () => new Actions();

// What a caller gave → the message a channel is handed: { text, html, actions, preview }.
//   body: the text · opts.html: it is in the HTML subset · opts.actions: an Actions, or
//   null for none · opts.preview: false to show no link preview
export function message(body, opts = {}) {
  const rows =
    opts.actions instanceof Actions ? opts.actions.list : Array.isArray(opts.actions) ? opts.actions.filter((r) => r.length) : [];
  return { text: String(body ?? ''), html: !!opts.html, actions: rows.length ? rows : null, preview: opts.preview !== false };
}

// The HTML subset, with the tags taken out: for a channel that shows plain text only.
export const plain = (html) =>
  String(html)
    .replace(/<\/(pre|blockquote)>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\n+$/, '');

// Cut a long text into parts no longer than `max`, at line breaks where possible.
export function chunks(text, max = 4000) {
  const parts = [];
  while (text.length > max) {
    let cut = text.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    parts.push(text.slice(0, cut));
    text = text.slice(cut).replace(/^\n/, '');
  }
  parts.push(text);
  return parts;
}
