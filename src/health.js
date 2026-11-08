// `bc health`, and /status in the chat: is each thing blackcat reaches working, one line each,
// and since when one has not been. Built on the probes of `bc selftest` (read-only: nothing is
// switched or sent), all asked side by side, so it takes no longer than the slowest. What only
// looks at this machine (a shortcut, a database, a watch) is counted on one line unless it
// fails. What the owner is told of otherwise is left out (`told`: a check tells of itself).
//
// The built-in check "Connections" runs `bc health --json` every 10 minutes: each thing that is
// not working is one of its findings, told once it has lasted half an hour, and in the briefing.
import { AGENT_DB } from './agentdb.js';
import { openSqlite, upgrade, withDb } from './db.js';
import { selftest } from './selftest.js';
import { now, pad } from './util/time.js';
import { asJson, fmtWhen } from './util/when.js';

// What each probe found when it was last asked, and since when it has found that.
const STEPS = [
  (db) =>
    db.exec(
      'CREATE TABLE health (part TEXT NOT NULL, name TEXT NOT NULL, outcome TEXT NOT NULL, since INTEGER NOT NULL, checked INTEGER NOT NULL, PRIMARY KEY (part, name))',
    ),
];
const use = (fn) =>
  withDb(() => {
    const db = openSqlite(AGENT_DB);
    upgrade(db, 'health', STEPS);
    return db;
  }, fn);

// Each result gets `since`: when its probe came to find what it finds now. (A probe that is
// no longer there, something taken out of the settings, is forgotten.)
function remember(parts, t) {
  use((db) =>
    db.transaction(() => {
      const was = new Map(
        db
          .prepare('SELECT * FROM health')
          .all()
          .map((r) => [`${r.part}\n${r.name}`, r]),
      );
      db.prepare('DELETE FROM health').run();
      const put = db.prepare('INSERT INTO health (part, name, outcome, since, checked) VALUES (?, ?, ?, ?, ?)');
      for (const p of parts)
        for (const r of p.results) {
          const w = was.get(`${p.part}\n${r.name}`);
          r.since = w?.outcome === r.outcome ? w.since : t;
          put.run(p.part, r.name, r.outcome, r.since, t);
        }
    })(),
  );
}

// (An account's address is left out of its name: "av (someone@example.com)" is "av".)
const nameOf = (r) => r.name.replace(/\s*\(.*\)$/, '');
const labelOf = (p, r) => (p.results.length > 1 ? `${p.title}: ${nameOf(r)}` : p.title);

// No probe is waited for longer, so that the whole answers within the minute a check is given:
// a mail server slow to answer is one line not working, not the whole of it unanswered.
const PROBE_CAP_MS = 45_000;

// Ask, and keep what was found. → { ok, checked, lines: [{ outcome, label, detail, since }], local: { fine, parts }, problems: [{ key, title, since }] }
export async function health() {
  const t = now();
  const out = await selftest({ untold: true, together: true, capMs: PROBE_CAP_MS });
  remember(out.parts, t);
  const lines = [];
  const local = { fine: 0, parts: [] };
  for (const p of out.parts)
    for (const r of p.results) {
      if (r.local && r.outcome !== 'failed') {
        if (r.outcome === 'ok') local.fine++;
        if (!local.parts.includes(p.title)) local.parts.push(p.title);
        continue;
      }
      lines.push({ outcome: r.outcome, label: labelOf(p, r), detail: r.detail, since: r.since, key: `${p.part}-${nameOf(r)}` });
    }
  const problems = lines
    .filter((l) => l.outcome === 'failed')
    .map((l) => ({ key: l.key, title: `${l.label}: ${l.detail}`, since: l.since }));
  return { ok: !problems.length, checked: t, lines: lines.map(({ key, ...l }) => l), local, problems };
}

const hm = (ts) => {
  const d = new Date(ts * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const MARK = { ok: '✓', failed: '✗', skipped: '·' };
// As said to the owner, in the chat or at a terminal.
export function healthText(h) {
  const bad = h.problems.length;
  return [
    `Health at ${hm(h.checked)}: ${bad ? `${bad} not working` : 'all working'}`,
    ...h.lines.map(
      (l) =>
        `${MARK[l.outcome]} ${l.label}${l.detail ? ` · ${l.detail}` : ''}${l.outcome === 'failed' ? ` · since ${fmtWhen(l.since)}` : ''}`,
    ),
    ...(h.local.fine ? [`✓ On this machine: ${h.local.fine} more working (${h.local.parts.join(', ')})`] : []),
  ].join('\n');
}

// `bc health [--json]`. (With --json, for the check: what is not working, as its findings.)
export async function command(opts) {
  const h = await health();
  const { cameTo } = await import('./activity/command.js');
  cameTo({
    ok: h.ok,
    did: h.ok
      ? `${h.lines.filter((l) => l.outcome === 'ok').length + h.local.fine} working`
      : `not working: ${h.problems.map((p) => p.title.split(':')[0]).join(', ')}`,
  });
  if (opts.json) console.log(asJson(h));
  else console.log(healthText(h));
  // (At once: a probe that never answered must not keep this waiting.)
  process.exit(h.ok ? 0 : 1);
}
