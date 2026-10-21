// Times are this machine's local time throughout: that's the owner's wall clock.

import { describe, nextRun } from './schedule.js';
import { clock, pad } from './time.js';

export class TimeError extends Error {}

const UNIT = { s: 1, m: 60, h: 3600, d: 86400, w: 7 * 86400, mo: 30 * 86400 };

// "45m", "3h", "2d", "1w" → seconds
// (m is minutes, everywhere: months are mo.)
export function parseDuration(s) {
  const m = /^(\d+)\s*(mo|[smhdw])$/i.exec(String(s).trim());
  if (!m) throw new TimeError(`Can't read duration "${s}". Use e.g. 45m, 3h, 2d, 1w, 2mo.`);
  return Number(m[1]) * UNIT[m[2].toLowerCase()];
}

// A day, as written: a date that does not exist (2026-02-31) is refused, not moved on.
function dayAt(y, mo, d, h = 0, mi = 0) {
  const t = new Date(y, mo - 1, d, h, mi);
  if (t.getFullYear() !== y || t.getMonth() !== mo - 1 || t.getDate() !== d || t.getHours() !== h || t.getMinutes() !== mi) return null;
  return Math.floor(t.getTime() / 1000);
}

// How far back, for every --since: "45m", "24h", "7d", "2mo", or a day ("2026-09-01", from
// its start; "2026-09-01 14:00"). → seconds since 1970.
export function sinceTs(s, nowMs = Date.now()) {
  const str = String(s ?? '').trim();
  if (/^\d+\s*(mo|[smhdw])$/i.test(str)) return Math.floor(nowMs / 1000) - parseDuration(str);
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(str);
  const ts = m && dayAt(+m[1], +m[2], +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
  if (ts == null) throw new TimeError(`Can't read "${s}" as how far back. Use e.g. 45m, 24h, 7d, 2mo, or a day like 2026-09-01.`);
  return ts;
}

// "2026-10-03 09:00", "2026-10-03T09:00", "2026-10-03" (9:00), or "18:30" (today, or tomorrow if that has passed)
export function parseAt(s, nowMs = Date.now()) {
  const str = String(s).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(str);
  if (m) {
    const ts = dayAt(+m[1], +m[2], +m[3], m[4] ? +m[4] : 9, m[5] ? +m[5] : 0);
    if (ts == null) throw new TimeError(`"${s}" isn't a real date and time.`);
    return ts;
  }
  m = /^(\d{1,2}):(\d{2})$/.exec(str);
  if (m) {
    if (!clock(str)) throw new TimeError(`"${s}" isn't a time of day.`);
    const d = new Date(nowMs);
    d.setHours(+m[1], +m[2], 0, 0);
    if (d.getTime() <= nowMs) d.setDate(d.getDate() + 1);
    return Math.floor(d.getTime() / 1000);
  }
  throw new TimeError(`Can't read time "${s}". Use "YYYY-MM-DD HH:MM", "YYYY-MM-DD" or "HH:MM".`);
}

export function parseWhen({ at, in: inn }) {
  if (at && inn) throw new TimeError('Give either --at or --in, not both.');
  if (inn) return Math.floor(Date.now() / 1000) + parseDuration(inn);
  if (at) return parseAt(at);
  throw new TimeError('When? Give --at "YYYY-MM-DD HH:MM" or --in 2d.');
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "Sat 3 Oct, 09:00", with "today"/"tomorrow" when that's clearer.
export function fmtWhen(ts, nowMs = Date.now()) {
  const d = new Date(ts * 1000);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(new Date(nowMs))) / 86400000);
  if (diff === 0) return `today ${time}`;
  if (diff === 1) return `tomorrow ${time}`;
  if (diff === -1) return `yesterday ${time}`;
  const year = d.getFullYear() === new Date(nowMs).getFullYear() ? '' : ` ${d.getFullYear()}`;
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}${year}, ${time}`;
}

// For the agent, which cannot read a Unix time: every value under a key that names a time
// (ts, next, since, last, newest, oldest, until, due, and …Ts, …_ts, …_at, …At, …Since,
// …Until), in seconds or milliseconds, as a date ("Mon 19 Oct 2026 06:00"). Anything else,
// and a number too small or large to be a time, is left as it is.
const TIME_KEY = /^(ts|next|since|last|newest|oldest|until|due)$|(Ts|_ts|_at|At|Since|Until)$/;
export function readableTimes(v, key = '') {
  if (Array.isArray(v)) return v.map((x) => readableTimes(x, key));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, readableTimes(x, k)]));
  if (!TIME_KEY.test(key)) return v;
  const n = typeof v === 'string' && /^\d{10}(\d{3})?$/.test(v) ? Number(v) : v;
  if (typeof n !== 'number') return v;
  const secs = n >= 1e12 && n < 1e13 ? n / 1000 : n >= 1e9 && n < 1e10 ? n : null;
  if (secs == null) return v;
  const d = new Date(secs * 1000);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// A command's --json, as the one who ran it reads it: dates for the agent, numbers for a script.
export const asJson = (v) => JSON.stringify(process.env.BLACKCAT_CALLER === 'agent' ? readableTimes(v) : v, null, 2);

// When a repeating reminder comes round next, after it fires at `ts`. `repeat` is cron
// (several expressions separated by ";"). The words daily, weekdays, weekly and monthly are
// how it was kept before, and still work for reminders made then.
export function nextRepeat(ts, repeat) {
  if (!repeat) return null;
  if (!REPEAT_WORDS.includes(repeat)) {
    try {
      return nextRun(String(repeat).split(';'), ts * 1000);
    } catch {
      return null;
    }
  }
  const d = new Date(ts * 1000);
  if (repeat === 'daily') d.setDate(d.getDate() + 1);
  else if (repeat === 'weekly') d.setDate(d.getDate() + 7);
  else if (repeat === 'monthly') d.setMonth(d.getMonth() + 1);
  else
    do d.setDate(d.getDate() + 1);
    while (d.getDay() === 0 || d.getDay() === 6);
  return Math.floor(d.getTime() / 1000);
}
export const REPEAT_WORDS = ['daily', 'weekdays', 'weekly', 'monthly'];
// "weekly", for a reminder first due at `ts` → the cron that repeats it: "0 20 * * 1".
export function repeatCron(word, ts) {
  const d = new Date(ts * 1000);
  const hm = `${d.getMinutes()} ${d.getHours()}`;
  return (
    { daily: `${hm} * * *`, weekdays: `${hm} * * 1-5`, weekly: `${hm} * * ${d.getDay()}`, monthly: `${hm} ${d.getDate()} * *` }[word] ??
    null
  );
}
// A repeat, in words: "at 20:00, only on Monday".
export function repeatText(repeat) {
  if (!repeat || REPEAT_WORDS.includes(repeat)) return repeat ?? null;
  try {
    return describe(String(repeat).split(';')).replace(/^./, (c) => c.toLowerCase());
  } catch {
    return repeat;
  }
}
