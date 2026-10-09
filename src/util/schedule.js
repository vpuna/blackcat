// Every repeating schedule in blackcat is cron: the five-field format used by Unix cron
// (minute hour day-of-month month day-of-week), in this machine's local time.
//
//   0 7 * * *          every day at 07:00
//   0 7,18 * * 1-5     07:00 and 18:00, Monday to Friday
//   */15 * * * *       every 15 minutes
//   30 9 * * 6,0       09:30 on Saturday and Sunday
//
// A schedule is a list of expressions, usually one: "07:00 on weekdays and 09:30 at
// weekends" needs two. A moment that happens once (a reminder on 9 October) is a date, not
// a schedule. Nobody has to read cron to use it: describe() says it in English and
// nextRuns() shows when it will next happen.
import { createRequire } from 'node:module';
import { clock } from './time.js';

export class ScheduleError extends Error {}

// Both libraries are loaded the first time a schedule is actually read or described, not
// when a command starts: most commands never touch a schedule.
const need = createRequire(import.meta.url);
let cronLib = null;
let wordsLib = null;
const cron = () => (cronLib ??= need('croner').Cron);
const words = () => (wordsLib ??= need('cronstrue'));

const FIELDS = /^\S+(\s+\S+){4}$/;
function compile(expr) {
  const e = String(expr ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  // Five fields exactly: a sixth would be seconds, and nothing here runs to the second.
  if (!FIELDS.test(e))
    throw new ScheduleError(
      `"${expr}" is not a schedule. Cron has five parts: minute hour day-of-month month day-of-week, e.g. "0 7 * * 1-5" (07:00, Monday to Friday).`,
    );
  try {
    return new (cron())(e, { paused: true });
  } catch (err) {
    throw new ScheduleError(`"${e}" is not a valid schedule: ${String(err.message).replace(/^CronPattern:\s*/, '')}.`);
  }
}

// One expression or several, as text or a list → a list of tidy expressions. Throws ScheduleError.
export function schedule(input) {
  const list = (Array.isArray(input) ? input : [input])
    .map((x) =>
      String(x ?? '')
        .trim()
        .replace(/\s+/g, ' '),
    )
    .filter(Boolean);
  if (!list.length) throw new ScheduleError('Say when: a cron expression such as "0 7 * * *" (every day at 07:00).');
  list.forEach(compile);
  return [...new Set(list)];
}
export const isSchedule = (input) => {
  try {
    schedule(input);
    return true;
  } catch {
    return false;
  }
};

// In English: "At 07:00 and 18:00, Monday through Friday".
export function describe(input) {
  return schedule(input)
    .map((e) => words().toString(e, { use24HourTimeFormat: true, verbose: false }))
    .join('; and ');
}

// The next `n` moments it comes round, as unix seconds, soonest first.
export function nextRuns(input, n = 3, fromMs = Date.now()) {
  const all = schedule(input).flatMap((e) => compile(e).nextRuns(n, new Date(fromMs)));
  return [...new Set(all.map((d) => Math.floor(d.getTime() / 1000)))].sort((a, b) => a - b).slice(0, n);
}
export const nextRun = (input, fromMs = Date.now()) => nextRuns(input, 1, fromMs)[0] ?? null;

// Has a scheduled moment passed since `lastTs` (unix seconds)? → the most recent one that
// has, or null. A moment missed while blackcat was off is reported once, like this.
export function due(input, lastTs, nowMs = Date.now()) {
  const now = Math.floor(nowMs / 1000);
  let latest = null;
  for (const e of schedule(input)) {
    const c = compile(e);
    let t = c.nextRun(new Date(lastTs * 1000));
    // Walk forward to the last moment that is not in the future (bounded: an every-minute
    // schedule left alone for a year must not spin here).
    for (let i = 0; t && t.getTime() / 1000 <= now && i < 100_000; i++) {
      latest = Math.max(latest ?? 0, Math.floor(t.getTime() / 1000));
      const after = c.nextRun(t);
      if (!after || after.getTime() <= t.getTime()) break;
      // Far behind: jump to just before now rather than stepping through every moment.
      if (now - t.getTime() / 1000 > 7 * 86400) {
        t = c.nextRun(new Date((now - 7 * 86400) * 1000));
        continue;
      }
      t = after;
    }
  }
  return latest;
}

// The shortest gap between two runs, in seconds, over the coming runs (for "no more often than…").
export function shortestGap(input, fromMs = Date.now()) {
  const runs = nextRuns(input, 60, fromMs);
  let gap = Infinity;
  for (let i = 1; i < runs.length; i++) gap = Math.min(gap, runs[i] - runs[i - 1]);
  return gap;
}

// ---- the plain ways of saying a schedule, turned into cron ----

const DAY = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
// Days as numbers (0 is Sunday) → the day-of-week field: [1,2,3,4,5] → "1-5", all seven → "*".
function dowField(days) {
  const d = [...new Set(days)].sort((a, b) => a - b);
  if (!d.length || d.length === 7) return '*';
  const runs = [];
  for (const x of d) {
    const last = runs.at(-1);
    if (last && last[1] === x - 1) last[1] = x;
    else runs.push([x, x]);
  }
  return runs.map(([a, b]) => (a === b ? `${a}` : b === a + 1 ? `${a},${b}` : `${a}-${b}`)).join(',');
}
// "mon,wed,fri", "weekdays", "weekend", "daily" → day numbers.
export function daysOf(text) {
  const v = String(text ?? '')
    .toLowerCase()
    .trim();
  if (!v || v === 'daily' || v === 'every day') return [0, 1, 2, 3, 4, 5, 6];
  if (v === 'weekdays') return [1, 2, 3, 4, 5];
  if (v === 'weekend' || v === 'weekends') return [6, 0];
  const out = v
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((d) => DAY[d.slice(0, 3)]);
  if (!out.length || out.includes(undefined))
    throw new ScheduleError(`Can't read days "${text}". Use e.g. thu, "fri,sat", daily, weekdays, weekend.`);
  return out;
}

// Times of day and days of the week → cron. Times that share a minute share an expression:
// ["07:00","18:00"] on weekdays → ["0 7,18 * * 1-5"]; ["07:00","18:30"] → two expressions.
export function fromTimes(times, days) {
  const dow = dowField(Array.isArray(days) ? days : daysOf(days));
  const byMinute = new Map();
  for (const t of [times].flat()) {
    const c = clock(t);
    if (!c) throw new ScheduleError(`"${t}" is not a time. Use 24-hour HH:MM, like 08:00 or 18:30.`);
    const [h, m] = c.split(':').map(Number);
    byMinute.set(m, [...(byMinute.get(m) ?? []), h]);
  }
  if (!byMinute.size) throw new ScheduleError('Say at what time: HH:MM.');
  return [...byMinute.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([m, hours]) => `${m} ${[...new Set(hours)].sort((a, b) => a - b).join(',')} * * ${dow}`);
}

// "15m", "2h", "1d" → cron, on the clock ("every 15 minutes" is at :00, :15, :30, :45).
// Only lengths that divide the hour or the day evenly can be said this way.
export function fromEvery(every) {
  const m = /^(\d+)\s*([mhd])$/i.exec(String(every ?? '').trim());
  if (!m) throw new ScheduleError(`Can't read "${every}". Use e.g. 15m, 2h, 1d.`);
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === 'm' && n >= 1 && n < 60 && 60 % n === 0) return [n === 1 ? '* * * * *' : `*/${n} * * * *`];
  if (unit === 'm' && n % 60 === 0) return fromEvery(`${n / 60}h`);
  if (unit === 'h' && n >= 1 && n < 24 && 24 % n === 0) return [n === 1 ? '0 * * * *' : `0 */${n} * * *`];
  if ((unit === 'h' && n === 24) || (unit === 'd' && n === 1)) return ['0 0 * * *'];
  throw new ScheduleError(
    `"${every}" can't be said as a repeating clock time. Use a length that divides the hour or the day (5m, 10m, 15m, 20m, 30m, 1h, 2h, 3h, 4h, 6h, 8h, 12h, 1d), or give a cron expression.`,
  );
}

// What a person or a plugin may write, in any of the accepted forms → cron expressions.
//   { cron: '0 7 * * *' | [..] }   { at: '07:00' | [..], days?: 'weekdays' | [1,2] }   { every: '15m' }
export function toSchedule(spec) {
  if (typeof spec === 'string' || Array.isArray(spec)) return schedule(spec);
  if (spec?.cron) return schedule(spec.cron);
  if (spec?.at) return schedule(fromTimes(spec.at, spec.days ?? 'daily'));
  if (spec?.every) return schedule(fromEvery(spec.every));
  throw new ScheduleError('Say when: { cron }, { at, days } or { every }.');
}

// For showing: "At 07:00, Monday through Friday (next: Tue 6 Oct 07:00)".
export function summary(input, fromMs = Date.now()) {
  const next = nextRun(input, fromMs);
  const when = next
    ? new Date(next * 1000).toLocaleString('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : 'never';
  return `${describe(input)} (next: ${when})`;
}

// A quick look at a job's schedule as written, without loading the cron library: it runs for
// every plugin at the start of every command. The full check happens when the schedule is
// first used (and in the tests, for every bundled plugin). → what is wrong, or null.
export function jobShapeProblem(job) {
  const texts = typeof job.cron === 'function' ? [] : [job.cron].flat().filter((x) => x != null);
  for (const t of texts)
    if (typeof t !== 'string' || !FIELDS.test(t.trim().replace(/\s+/g, ' ')))
      return `"${t}" is not cron (five parts: minute hour day-of-month month day-of-week)`;
  if (job.every != null && !/^\d+[mhd]$/.test(String(job.every))) return `every "${job.every}" is not a length like 15m, 2h or 1d`;
  return null;
}

// A plugin job's schedule. `cron` is the way to write it (text, a list, or a function of
// ctx returning either, for a time that comes from settings); `every: '15m'` and
// `at: ['08:00']` are accepted as shorthand and mean the same as their cron.
export function jobSchedule(job, ctx) {
  const pick = (v) => (typeof v === 'function' ? v(ctx) : v);
  if (job.cron != null) return schedule(pick(job.cron));
  if (job.at != null) return schedule(fromTimes([pick(job.at)].flat().filter(Boolean), 'daily'));
  return schedule(fromEvery(job.every));
}

// What a person types for "when": cron ("0 8 * * 1-5", several separated by ";"), times of
// day ("08:00, 20:00"), or a length ("15m"). → cron expressions.
export function parseWhenText(text, { days = 'daily' } = {}) {
  const t = String(text ?? '').trim();
  if (!t) throw new ScheduleError('Say when: times like "08:00, 20:00", a length like "15m", or a cron expression like "0 8 * * 1-5".');
  const parts = t
    .split(';')
    .map((x) => x.trim())
    .filter(Boolean);
  if (parts.every((x) => FIELDS.test(x))) return schedule(parts);
  if (/^\d+\s*[mhd]$/i.test(t)) return schedule(fromEvery(t.replace(/\s/g, '')));
  return schedule(fromTimes(t.split(/[\s,]+/).filter(Boolean), days));
}

// A stored schedule ({ cron: [...] }) → its cron expressions, or `fallback` when there is
// none or it cannot be read.
export function storedSchedule(spec, fallback = ['*/15 * * * *']) {
  try {
    if (spec?.cron) return schedule(spec.cron);
  } catch {
    // unreadable: fall through
  }
  return fallback;
}

// A schedule that is just times of day, every day → those times (["08:00", "20:00"]); anything else → null.
export function asTimes(input) {
  const out = [];
  for (const e of schedule(input)) {
    const m = /^(\d+) (\d+(?:,\d+)*) \* \* \*$/.exec(e);
    if (!m) return null;
    for (const h of m[2].split(',')) out.push(`${h.padStart(2, '0')}:${m[1].padStart(2, '0')}`);
  }
  return [...new Set(out)].sort();
}
// As a person would type it back: times when it is only times, otherwise the cron itself.
export const asText = (input) => asTimes(input)?.join(', ') ?? schedule(input).join('; ');
