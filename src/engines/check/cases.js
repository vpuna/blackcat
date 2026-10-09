// What the check asks, and how an answer is judged.
//
// A plugin supplies the requests for its own commands, in its manifest:
//
//   checks: [
//     { say: 'what reminders do i have', expect: /blackcat remind list\b/ },
//     { say: 'whats 17 times 23', never: /./ },
//   ]
//   checks: (ctx) => (ctx.config.get().hosts ? [ … ] : [])     // only what is set up, by its real names
//
// `expect`: a command the agent should ask to run (a pattern on the command line).
// `never`: one it must not ask for. A request is judged by what was asked for, whether or
// not it could be carried out in the temporary copy.
import { loaded, makeCtx } from '../../plugins/registry.js';

const pat = (re) => (re ? { source: re.source, flags: re.flags } : null);
const re = (p) => (p ? new RegExp(p.source, p.flags) : null);

// Every enabled plugin's requests, as plain data (so they can be handed to the run).
export function collect({ quick = false } = {}) {
  const out = [];
  const skipped = [];
  for (const p of loaded()) {
    let list = p.manifest.checks;
    if (!list) continue;
    try {
      if (typeof list === 'function') list = list(makeCtx(p, { caller: 'owner', surface: 'job' }));
    } catch (e) {
      skipped.push(`${p.name}: ${e.message}`);
      continue;
    }
    const mine = (list ?? []).filter((c) => c?.say && (c.expect instanceof RegExp || c.never instanceof RegExp));
    if (!mine.length && typeof p.manifest.checks === 'function') skipped.push(`${p.name}: not set up`);
    for (const c of quick ? mine.slice(0, 1) : mine) out.push({ plugin: p.name, say: c.say, expect: pat(c.expect), never: pat(c.never) });
  }
  return { cases: out, skipped };
}

// Did what was asked for match? → { ok, why }
export function judge(c, tried) {
  const expect = re(c.expect);
  const never = re(c.never);
  if (never && tried.some((t) => never.test(t))) return { ok: false, why: 'asked for something it must not' };
  if (expect && !tried.some((t) => expect.test(t)))
    return { ok: false, why: tried.length ? 'asked for something else' : 'did not ask for any command' };
  return { ok: true };
}
