// Times are this machine's local time throughout: that's the owner's wall clock.

import { describe, nextRun } from './schedule.js';
import { isoLocal, pad, todayAt } from './time.js';

export { isoLocal, todayAt };

export class TimeError extends Error {}

const UNIT = { s: 1, m: 60, h: 3600, d: 86400, w: 7 * 86400 };

// "45m", "3h", "2d", "1w" → seconds
export function parseDuration(s) {
  const m = /^(\d+)\s*([smhdw])$/i.exec(String(s).trim());
  if (!m) throw new TimeError(`Can't read duration "${s}". Use e.g. 45m, 3h, 2d, 1w.`);
  return Number(m[1]) * UNIT[m[2].toLowerCase()];
}

// "2026-10-03 09:00", "2026-10-03T09:00", "2026-10-03" (9:00), or "18:30" (today, or tomorrow if that has passed)
export function parseAt(s, nowMs = Date.now()) {
  const str = String(s).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(str);
  if (m) {
    const d = new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 9, m[5] ? +m[5] : 0);
    if (Number.isNaN(d.getTime())) throw new TimeError(`"${s}" isn't a real date.`);
    return Math.floor(d.getTime() / 1000);
  }
  m = /^(\d{1,2}):(\d{2})$/.exec(str);
  if (m) {
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

// "HH:MM" → today's unix seconds at that time

// "thu", "fri,sat", "daily", "weekdays", "weekend" → [4], [5, 6], … (0 is Sunday)
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export function parseDays(s) {
  const v = String(s).toLowerCase().trim();
  if (v === 'daily' || v === 'every day') return [0, 1, 2, 3, 4, 5, 6];
  if (v === 'weekdays') return [1, 2, 3, 4, 5];
  if (v === 'weekend' || v === 'weekends') return [6, 0];
  const out = v
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((d) => DAY_NAMES.indexOf(d.slice(0, 3)));
  if (!out.length || out.includes(-1)) throw new TimeError(`Can't read days "${s}". Use e.g. thu, "fri,sat", daily, weekdays.`);
  return [...new Set(out)].sort();
}
export const daysText = (days) =>
  days.length === 7 ? 'every day' : days.map((d) => DAY_NAMES[d][0].toUpperCase() + DAY_NAMES[d].slice(1)).join(', ');
