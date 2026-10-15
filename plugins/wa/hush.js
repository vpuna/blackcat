// The library that does WhatsApp's encryption prints a whole session, keys included, when
// it opens or closes one ("Closing session:", then the session). That would put keys in
// the log. What it says is kept; what it prints after it is not.
let hushed = false;
export function hushSessions(con = console) {
  if (hushed && con === console) return;
  if (con === console) hushed = true;
  for (const level of ['info', 'warn']) {
    const print = con[level].bind(con);
    con[level] = (...args) => print(...args.filter((a) => a == null || typeof a !== 'object' || a instanceof Error));
  }
}
