// The size of a file, for people: "812 KB", "49.9 MB". Never less than 1 KB.
export const size = (bytes) =>
  bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

// A count and what it counts: "1 message", "3 messages", "2 entries" (plural('entry', 'entries')).
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// How long something took: "850ms", "4.2s", "1.5m".
export const took = (ms) =>
  ms == null ? '' : ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;

// A count of tokens or the like, short: "950", "36.0k", "1.2M".
export const count = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n ?? 0));

// Dollars: "$0.13", "$12".
export const usd = (x) => `$${(x ?? 0).toFixed(x >= 10 ? 0 : 2)}`;

// Text made safe to put inside an HTML message.
export const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

// What went wrong, in a sentence. A plugin that knows a kind of error better than its
// message says (a chat service's own, with a number for a reason) explains it:
// explainErrors((e) => 'a sentence' | null). The first that has something to say is used.
const explainers = [];
export const explainErrors = (fn) => void (typeof fn === 'function' && !explainers.includes(fn) && explainers.push(fn));
export function errMsg(e) {
  for (const fn of explainers) {
    try {
      const said = fn(e);
      if (typeof said === 'string' && said) return said;
    } catch {}
  }
  return e?.message ?? String(e);
}
