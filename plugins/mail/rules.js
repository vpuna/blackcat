// Which mail is worth keeping in full, decided from the headers alone: no AI is involved.
// Everything else is kept as a header line only (who, when, subject), and its text is
// never fetched or stored.

export const addrOf = (a) =>
  String(a ?? '')
    .trim()
    .toLowerCase();
export const domainOf = (a) => addrOf(a).split('@')[1] ?? '';

// A rule is an address ("billing@dewa.gov.ae") or a domain ("school.example", which also
// covers its subdomains).
export function matches(rule, address) {
  const r = addrOf(rule).replace(/^@/, '');
  const a = addrOf(address);
  if (r.includes('@')) return a === r;
  const d = domainOf(a);
  return d === r || d.endsWith(`.${r}`);
}
export const validRule = (r) => /^@?([a-z0-9._%+-]+@)?[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(String(r).trim());

// Sent in bulk or by a machine: newsletters, marketing, notifications. Standard headers.
export function bulk(headers) {
  const h = (n) => String(headers[n] ?? '').toLowerCase();
  if (h('list-unsubscribe') || h('list-id')) return 'a mailing list or newsletter';
  if (/bulk|list|junk/.test(h('precedence'))) return 'sent in bulk';
  if (h('auto-submitted') && h('auto-submitted') !== 'no') return 'sent automatically';
  return null;
}

// → { keep: true|false, reason }. Order matters: your own rules first.
export function judge(m, { allow = [], block = [], known = new Set(), gmail = false }) {
  if (block.some((r) => matches(r, m.from))) return { keep: false, reason: 'a sender you blocked' };
  if (allow.some((r) => matches(r, m.from))) return { keep: true, reason: 'a sender you chose' };
  if (m.fromMe) return { keep: true, reason: 'from you' };
  if (known.has(addrOf(m.from))) return { keep: true, reason: 'someone you have written to' };
  if (m.bulk) return { keep: false, reason: m.bulk };
  if (gmail && !m.primary) return { keep: false, reason: "not in Gmail's Primary tab" };
  return { keep: true, reason: gmail ? 'in Primary, from a person' : 'from a person' };
}

// The mail server for an address, for the common providers.
export const HOSTS = {
  'gmail.com': 'imap.gmail.com',
  'googlemail.com': 'imap.gmail.com',
  'icloud.com': 'imap.mail.me.com',
  'me.com': 'imap.mail.me.com',
  'mac.com': 'imap.mail.me.com',
  'yahoo.com': 'imap.mail.yahoo.com',
  'fastmail.com': 'imap.fastmail.com',
  'zoho.com': 'imap.zoho.com',
  'aol.com': 'imap.aol.com',
};
export const hostFor = (address) => HOSTS[address.split('@')[1]?.toLowerCase()] ?? `imap.${address.split('@')[1]}`;

// Can this fetch stop after one look at the mailbox? Only when the server reports the Inbox
// exactly as it was last time (`seen` also carries the rules and how far back mail is kept,
// so changing either counts as a change), no kept mail is still waiting for its text, the
// list of people written to is not due for a refresh, and everything has been gone through
// in full recently enough. Asked for by hand (`full`), never.
export const FULL_EVERY_S = 6 * 3600;
export function unchanged({ state, seen, waiting, knownDue, full, nowS }) {
  if (full || waiting || knownDue) return false;
  if (!state?.mark || state.mark !== seen) return false;
  return nowS - (state.full_at ?? 0) < FULL_EVERY_S;
}
