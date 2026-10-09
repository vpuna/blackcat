// Quiet hours: when things blackcat sends by itself wait until morning. They are
// blackcat's, not any one part's: whatever sends the owner something unasked (a nudge from
// a watch today) asks here. What the owner asked for at a time (a reminder they set), and
// what cannot wait (something has stopped working), is not held back.
// (The setting is kept where it always was, under `reminders` in the settings file.)
import { load, update } from './config.js';
import { clock, todayAt } from './util/time.js';

export const QUIET_CHOICES = ['22:00-07:00', '23:00-07:00', '00:00-08:00'];
export const quiet = () => load().reminders?.quiet ?? null; // { from: '23:00', to: '07:00' } or null
export const describeQuiet = () => {
  const q = quiet();
  return q ? `quiet ${q.from}–${q.to}` : 'no quiet hours';
};

// "23:00-07:00" or "none". → an error message, or undefined when it was saved.
export function setQuiet(value) {
  const parts = String(value).split('-');
  if (value !== 'none' && !(parts.length === 2 && parts.every((t) => clock(t) === t))) return 'Quiet hours look like 23:00-07:00, or none.';
  update((cfg) => {
    cfg.reminders = { ...cfg.reminders, quiet: value === 'none' ? null : { from: parts[0], to: parts[1] } };
  });
  return undefined;
}

// A time moved out of quiet hours: to the moment they end.
export function outOfQuiet(ts, q = quiet()) {
  if (!q?.from || !q?.to) return ts;
  const ms = ts * 1000;
  const from = todayAt(q.from, ms);
  const to = todayAt(q.to, ms);
  if (from > to) return ts >= from ? to + 86400 : ts < to ? to : ts; // over midnight
  return ts >= from && ts < to ? to : ts;
}

// Are we inside quiet hours at this moment?
export function inQuiet(nowMs = Date.now(), q = quiet()) {
  if (!q?.from || !q?.to) return false;
  const t = nowMs / 1000;
  const from = todayAt(q.from, nowMs);
  const to = todayAt(q.to, nowMs);
  return from <= to ? t >= from && t < to : t >= from || t < to;
}
