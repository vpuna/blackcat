// Whose address is this? A plugin that knows names for addresses (mail, from the people who
// write to the owner) says so with `names` in its manifest, and any other may ask: the
// calendar, to say who an invitation is from when the invitation gives only an address.
//   names: (ctx, address) => 'Priya Nair' | null
// A name found this way was written by whoever sent the mail: it is for showing, like the
// address beside it, and proves nothing about who they are.
import { loaded, makeCtx } from './registry.js';

const seen = new Map(); // address → name or null, for the life of this process

export function nameOf(address) {
  const a = String(address ?? '')
    .trim()
    .toLowerCase();
  if (!a) return null;
  if (seen.has(a)) return seen.get(a);
  let name = null;
  for (const p of loaded()) {
    if (!p.manifest.names) continue;
    try {
      name = clean(p.manifest.names(makeCtx(p, { caller: 'job' }), a));
    } catch {
      // a plugin that cannot say leaves the address as it is
    }
    if (name) break;
  }
  seen.set(a, name);
  return name;
}
const clean = (s) =>
  String(s ?? '')
    .replace(/[\s<>()]+/g, ' ')
    .trim()
    .slice(0, 80) || null;

// "Priya Nair (priya@work.example)", or the address alone when no name is known.
export const personLabel = ({ name, email } = {}) => {
  const n = name ?? nameOf(email);
  return n && email ? `${n} (${email})` : (n ?? email ?? '');
};
