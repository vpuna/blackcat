// The size of a file, for people: "812 KB", "49.9 MB". Never less than 1 KB.
export const size = (bytes) =>
  bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

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
