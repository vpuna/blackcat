// What looks wrong in the activity record, by plain rules: no model is asked. The built-in
// check "blackcat health" runs `bc activity problems` on a schedule; each problem becomes one
// of its findings, with a key that stays the same while it lasts.
//
// Each rule looks at the last day, and some compare it with the week before. What the owner
// did directly is left out (they saw how it went), and so is what a developer session did.
// Each problem says when its latest sign was (`last`): told it is fixed, the check lets go of
// what came before that.
import { withDb } from '../db.js';
import { dayOf, openActivityDb } from './log.js';

const DAY = 86400;
// Rules, and how far each goes before it says something.
export const RULES = {
  failing: 3, // the same thing failed this many times in a day
  atLimit: 4, // a look took in as much as it may, this many times in a row
  spend: { least: 1, times: 2 }, // a day's cost of one thing: at least $1, and twice its daily average
  perCall: { least: 1, times: 1.5 }, // or each call costing half as much again as it did
  often: { least: 12, times: 2 }, // scheduled work done twice as often as usual, and 12 times more
};
// What the owner and developers did themselves.
const NOT_MINE = "a.kind <> 'owner' AND COALESCE(a.who, '') NOT IN ('dev', 'owner', 'agent')";
const short = (s, n = 90) => {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
const money = (n) => `$${n < 10 ? n.toFixed(2) : Math.round(n)}`;

// When the owner said a check's finding was fixed, the check notes it here (category FIXED,
// data { key }): from then on, that problem is judged only by what happened after it.
export const FIXED = 'check fixed';

// → [{ key, title, last }].
export function problems({ nowS = Math.floor(Date.now() / 1000) } = {}) {
  return withDb(openActivityDb, (db) => {
    const fixed = new Map(
      db
        .prepare(`SELECT json_extract(data, '$.key') AS key, MAX(ts) AS ts FROM activity WHERE category = ? AND ts > ? GROUP BY key`)
        .all(FIXED, nowS - DAY)
        .map((r) => [r.key, r.ts]),
    );
    const found = findProblems(db, nowS);
    // Said to be fixed within the day: is it still so, counting only from then?
    return found.flatMap((p) => {
      const t = fixed.get(p.key);
      if (!t) return [p];
      return findProblems(db, nowS, { from: t }).filter((x) => x.key === p.key);
    });
  });
}

// `from`: count only what happened after this (a fix), rather than the whole last day.
export function findProblems(db, nowS, { from = 0 } = {}) {
  const dayAgo = nowS - DAY;
  const since = Math.max(dayAgo, from);
  const weekFrom = nowS - 8 * DAY;
  const out = [];
  const all = (sql, ...p) => db.prepare(sql).all(...p);

  // An account that is not paired wrote to the bot.
  for (const r of all(
    `SELECT COUNT(*) AS n, MAX(ts) AS last, GROUP_CONCAT(DISTINCT summary) AS what FROM activity a
      WHERE ts > ? AND ts <= ? AND category = 'channel' AND ok = 0 HAVING n > 0`,
    since,
    nowS,
  ))
    out.push({
      key: 'unpaired-writing',
      title: `Accounts that are not paired wrote to the bot ${r.n === 1 ? 'once' : `${r.n} times`}: ${short(r.what, 120)}`,
      last: r.last,
    });

  // A command the agent was refused by policy.
  for (const r of all(
    `SELECT COUNT(*) AS n, MAX(ts) AS last, (SELECT summary FROM activity b WHERE b.kind = 'command' AND b.ts > ? AND b.ts <= ? AND json_extract(b.data, '$.decision') LIKE 'refused%' ORDER BY b.id DESC LIMIT 1) AS what
      FROM activity a WHERE ts > ? AND ts <= ? AND kind = 'command' AND json_extract(data, '$.decision') LIKE 'refused%' AND ${NOT_MINE} HAVING n > 0`,
    since,
    nowS,
    since,
    nowS,
  ))
    out.push({
      key: 'refused',
      title: `${r.n === 1 ? 'A command was' : `${r.n} commands were`} refused by policy, the latest: ${short(r.what)}`,
      last: r.last,
    });

  // A service that stopped by itself, or needs the owner.
  for (const r of all(
    `SELECT category, COUNT(*) AS n, MAX(ts) AS last, (SELECT summary FROM activity b WHERE b.category = a.category AND b.ok = 0 AND b.ts > ? AND b.ts <= ? ORDER BY b.id DESC LIMIT 1) AS what
      FROM activity a WHERE ts > ? AND ts <= ? AND (category LIKE 'service: %' OR category = 'blackcat') AND ok = 0 GROUP BY category`,
    since,
    nowS,
    since,
    nowS,
  ))
    out.push({
      key: `service-${slug(r.category.replace(/^service: /, ''))}`,
      title: `${r.category === 'blackcat' ? 'blackcat' : `The ${r.category.replace(/^service: /, '')} service`} ${r.n === 1 ? short(r.what) : `stopped by itself ${r.n} times, the latest: ${short(r.what)}`}`,
      last: r.last,
    });

  // The same thing failing again and again. (Not a fix a check ran: the check says so itself.)
  for (const r of all(
    `SELECT category, COUNT(*) AS n, MAX(ts) AS last, (SELECT summary FROM activity b WHERE b.category = a.category AND b.ok = 0 AND b.ts > ? AND b.ts <= ? ORDER BY b.id DESC LIMIT 1) AS what
      FROM activity a WHERE ts > ? AND ts <= ? AND ok = 0 AND ${NOT_MINE}
        AND category <> 'channel' AND category <> 'blackcat' AND category NOT LIKE 'service: %' AND COALESCE(summary, '') NOT LIKE 'ran its fix%'
      GROUP BY category HAVING n >= ? ORDER BY n DESC`,
    since,
    nowS,
    since,
    nowS,
    RULES.failing,
  ))
    out.push({
      key: `failing-${slug(r.category)}`,
      title: `${r.category} failed ${r.n} times in the last day, the latest: ${short(r.what)}`,
      last: r.last,
    });

  // A look that keeps taking in as much as it may: more is waiting, or it reads the same again.
  const looks = all(
    `SELECT category, ts, json_extract(data, '$.more') AS more FROM activity
      WHERE kind = 'event' AND lead = 1 AND ts > ? AND ts <= ? AND json_extract(data, '$.read') IS NOT NULL ORDER BY id DESC`,
    Math.max(weekFrom, from),
    nowS,
  );
  const byLook = Map.groupBy(looks, (r) => r.category);
  for (const [category, rs] of byLook) {
    const run = rs.slice(0, RULES.atLimit);
    if (run.length === RULES.atLimit && run.every((r) => r.more))
      out.push({
        key: `at-limit-${slug(category)}`,
        title: `${category} took in as much as it may at each of its last ${RULES.atLimit} looks: more is waiting each time, or it is reading the same messages again`,
        last: run[0].ts,
      });
  }

  // What blackcat does by itself, against the seven days before: cost, cost per call. Compared with a usual day (the middle one) and, for the cost of a call, with the
  // cheapest day, so that a cost creeping up day by day is still found, and does not come and
  // go with the hour.
  // (Only scheduled work: what was asked for in a chat or at a terminal was someone's choice.)
  const MINE = `${NOT_MINE} AND surface = 'job' AND kind = 'model'`;
  const day = all(
    `SELECT category, kind, COUNT(*) AS n, SUM(COALESCE(cost, 0)) AS cost, MAX(ts) AS last FROM activity a
      WHERE ts > ? AND ts <= ? AND ${MINE} GROUP BY category, kind`,
    since,
    nowS,
  );
  const days = Map.groupBy(
    all(
      `SELECT category, kind, CAST((? - ts) / ${DAY} AS INTEGER) AS ago, COUNT(*) AS n, SUM(COALESCE(cost, 0)) AS cost FROM activity a
        WHERE ts > ? AND ts <= ? AND ${MINE} GROUP BY category, kind, ago`,
      dayAgo,
      weekFrom,
      dayAgo,
    ),
    (r) => `${r.kind}\n${r.category}`,
  );
  const middle = (xs) => xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)];
  for (const d of day) {
    const before = days.get(`${d.kind}\n${d.category}`) ?? [];
    // Something to compare with: at least three of those days had some.
    if (before.length < 3) continue;
    if (d.kind === 'model') {
      const usual = middle(before.map((x) => x.cost));
      const each = d.cost / d.n;
      const cheapest = Math.min(...before.filter((x) => x.n >= 3).map((x) => x.cost / x.n));
      const spendUp = d.cost >= RULES.spend.least && d.cost >= RULES.spend.times * usual;
      const callUp = d.cost >= RULES.perCall.least && cheapest > 0 && Number.isFinite(cheapest) && each >= RULES.perCall.times * cheapest;
      if (spendUp || callUp)
        out.push({
          key: `cost-${slug(d.category)}`,
          title: `${d.category} cost ${money(d.cost)} in the last day, against ${money(usual)} on a usual day before (${money(each)} a call, was ${money(cheapest)} at least)`,
          last: d.last,
        });
    }
  }

  // How often scheduled work ran: from the daily totals, which count every run (one that
  // found nothing to do is counted there, not listed: a check that is not working is listed
  // each time, and would seem to run more), for yesterday against the seven days before.
  // What is scheduled work is told by the record: what a schedule set off (not a message
  // coming in, which is how many were sent).
  const midnight = new Date(nowS * 1000).setHours(0, 0, 0, 0) / 1000;
  if (from < midnight) {
    const scheduled = new Set(
      all(
        `SELECT DISTINCT kind, category FROM activity a WHERE ts > ? AND ts < ? AND ${NOT_MINE} AND surface = 'job' AND kind IN ('job', 'event') AND lead = 1`,
        midnight - 8 * DAY,
        midnight,
      ).map((r) => `${r.kind}\n${r.category}`),
    );
    const runs = Map.groupBy(
      all(
        `SELECT category, kind, day, SUM(n) AS n FROM activity_daily
          WHERE day >= ? AND day < ? AND kind IN ('job', 'event') AND who = 'blackcat' GROUP BY category, kind, day`,
        dayOf(midnight - 8 * DAY),
        dayOf(midnight),
      ).filter((r) => scheduled.has(`${r.kind}\n${r.category}`)),
      (r) => `${r.kind}\n${r.category}`,
    );
    const yesterday = dayOf(midnight - DAY);
    for (const rows of runs.values()) {
      const d = rows.find((r) => r.day === yesterday);
      const before = rows.filter((r) => r !== d);
      if (!d || before.length < 3) continue;
      const usual = middle(before.map((x) => x.n));
      if (d.n >= RULES.often.times * usual && d.n >= usual + RULES.often.least)
        out.push({
          key: `often-${slug(d.category)}`,
          title: `${d.category} ran ${d.n} times yesterday, against ${usual} on a usual day before`,
          last: midnight,
        });
    }
  }
  return out;
}
