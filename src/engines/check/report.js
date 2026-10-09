// What a check found: shown, compared with the last one accepted, and remembered.
import { storeFor } from '../../store.js';
import { engineStamp } from '../registry.js';

// Kept in agent.db: for each role, what was accepted and the check that awaits a decision.
const store = storeFor('engine-check');
const kept = () => store;

// The figures of a result that are compared and kept.
export function summary(r) {
  const sec = r.security ?? [];
  const acc = r.accuracy ?? [];
  return {
    engine: r.engine,
    label: r.label,
    model: r.model ?? null,
    options: r.options ?? {},
    where: r.where ?? null,
    at: r.at,
    answeredBy: r.performance?.model ?? null,
    broken: sec.filter((s) => s.outcome === 'broken').map((s) => s.title),
    itself: r.itself ?? [],
    safeguards: {
      held: sec.filter((s) => s.kind === 'safeguard' && s.outcome.startsWith('held')).length,
      notAttempted: sec.filter((s) => s.outcome === 'not attempted').length,
      of: sec.filter((s) => s.kind === 'safeguard').length,
    },
    judgement: {
      leftAlone: sec.filter((s) => s.kind === 'judgement' && s.outcome === 'left alone').length,
      of: sec.filter((s) => s.kind === 'judgement').length,
    },
    accuracy: { ok: acc.filter((a) => a?.ok).length, of: acc.length },
    performance: r.performance ?? null,
    ...(r.error ? { error: r.error } : {}),
  };
}

const secs = (ms) => (ms == null ? '-' : `${(ms / 1000).toFixed(1)} s`);
const money = (c) => (c == null ? 'cost not reported' : `$${c.toFixed(2)} at list price`);
const short = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const WHO = { chat: 'the agent you talk to', readers: 'the background readers' };
const MARK = {
  held: '✓',
  'held: it has none': '✓',
  'left alone': '✓',
  'not attempted': '·',
  'tried, and was stopped': '!',
  obeyed: '!',
  broken: '✗',
  'no answer': '?',
};

// The report for one role, as text. `was`: the summary last accepted for it, if any.
export function text(r, was) {
  const s = summary(r);
  const L = [];
  const opts = Object.entries(s.options)
    .map(([k, v]) => `, ${k}: ${v}`)
    .join('');
  L.push(
    `${r.role.toUpperCase()} (${WHO[r.role]}): ${s.label}, model ${s.model ?? 'left to the engine'}${opts}${s.where ? ` · ${s.where}` : ''}${s.answeredBy && s.answeredBy !== s.model ? ` · answered by ${s.answeredBy}` : ''}`,
  );
  if (r.error) return [...L, '', `  The check could not run: ${r.error}`].join('\n');

  L.push(
    '',
    `  SECURITY${s.broken.length ? `: ${s.broken.length} SAFEGUARD${s.broken.length === 1 ? '' : 'S'} BROKEN` : ': nothing that was refused was done'}`,
  );
  const safe = r.security.filter((x) => x.kind === 'safeguard');
  const judged = r.security.filter((x) => x.kind === 'judgement');
  if (safe.length) L.push('  Safeguards (it was asked outright to do what is not allowed; was it stopped?)');
  for (const x of safe) {
    L.push(`    ${MARK[x.outcome] ?? '?'} ${x.title}: ${x.outcome}`);
    for (const b of x.broken ?? []) L.push(`        ✗ ${b}`);
    if (x.error) L.push(`        ${x.error}`);
  }
  if (s.safeguards.notAttempted) L.push(`    (· not attempted: the model would not even try, so that path was not exercised this time.)`);
  if (judged.length) L.push("  Judgement (somebody else's text told it what to do; did it leave it alone?)");
  for (const x of judged) {
    L.push(`    ${MARK[x.outcome] ?? '?'} ${x.title}: ${x.outcome}`);
    for (const b of x.broken ?? []) L.push(`        ✗ ${b}`);
  }

  if (s.itself.length) {
    L.push(
      `  Run by ${s.label} itself, without asking blackcat: ${s.itself.length} plain look-up${s.itself.length === 1 ? '' : 's'} (${s.itself.slice(0, 4).join(' · ').slice(0, 160)}).`,
    );
    L.push("    Each was judged again by the check: it only showed something, and reached nothing outside the agent's own folders.");
  }
  L.push(
    '',
    `  ACCURACY: ${s.accuracy.ok} of ${s.accuracy.of} requests led to the right command${was ? ` (accepted before: ${was.accuracy.ok} of ${was.accuracy.of})` : ''}`,
  );
  for (const a of r.accuracy.filter((x) => x && !x.ok)) {
    L.push(`    ✗ [${a.plugin}] ${a.say.replace(/\s+/g, ' ').slice(0, 90)}`);
    L.push(`        ${a.why}${a.asked?.length ? `: ${a.asked.slice(0, 3).join(' | ').slice(0, 200)}` : ''}`);
  }

  const p = s.performance;
  if (p) {
    const then = was?.performance;
    L.push(
      '',
      `  PERFORMANCE: a request took ${secs(p.medianMs)} (the middle one)${p.medianFirstMs != null ? `, ${secs(p.medianFirstMs)} to its first command` : ''}${then?.medianMs ? ` (accepted before: ${secs(then.medianMs)})` : ''}`,
    );
    const w = p.where;
    // Where a request's time goes, so that a slower run can be told from a slower way of working.
    if (w)
      L.push(
        `    where the time goes, on average: ${secs(w.ms)} a request = ${secs(w.modelMs)} at the model (${w.steps} steps) + ${secs(w.callMs)} carrying out what it asked for + ${secs(Math.max(0, w.ms - w.modelMs - w.callMs))} in between${then?.where ? ` (accepted before: ${secs(then.where.ms)} = ${secs(then.where.modelMs)} + ${secs(then.where.callMs)} + ${secs(Math.max(0, then.where.ms - then.where.modelMs - then.where.callMs))}, ${then.where.steps} steps)` : ''}`,
      );
    L.push(
      `    ${p.requests} requests, ${short(p.tokens)} tokens, ${money(p.cost)}${then ? ` (accepted before: ${short(then.tokens)} tokens, ${money(then.cost)})` : ''}`,
    );
  }
  return L.join('\n');
}

// ---- what was accepted ----

// What is accepted for a role, if it is what is in use now. → { at, summary, withBroken } or null
export function acceptedFor(role) {
  const a = kept().get(`accepted:${role}`);
  return a && a.stamp === engineStamp(role) ? a : null;
}
export const lastAccepted = (role) => kept().get(`accepted:${role}`) ?? null;

// The check that was run last and awaits a decision: { role: { stamp, result } }.
export function pending() {
  const s = kept();
  return Object.fromEntries(
    s
      .keys()
      .filter((k) => k.startsWith('pending:'))
      .map((k) => [k.slice('pending:'.length), s.get(k)]),
  );
}
export const keepPending = (role, stamp, result) => kept().set(`pending:${role}`, { stamp, result });

export function accept(role, { stamp, result }) {
  const s = summary(result);
  const accepted = { stamp, at: new Date().toISOString(), summary: s, withBroken: s.broken.length > 0 };
  kept().set(`accepted:${role}`, accepted);
  kept().delete(`pending:${role}`);
  return accepted;
}

// One line for `bc status` and `bc engine status`.
export function standing(role) {
  const a = acceptedFor(role);
  if (!a) return lastAccepted(role) ? 'changed since it was last checked → bc engine check' : 'not checked → bc engine check';
  const day = a.at.slice(0, 10);
  return a.withBroken
    ? `ACCEPTED WITH A BROKEN SAFEGUARD on ${day}`
    : `checked ${day}: ${a.summary.accuracy.ok}/${a.summary.accuracy.of} right, nothing refused was done`;
}
