// Dates and times, in one place. Everything is this machine's local time: that is the
// owner's wall clock. Timestamps are unix seconds unless a name says `Ms`.

export const now = () => Math.floor(Date.now() / 1000);
export const pad = (n) => String(n).padStart(2, '0');

// "2026-10-04" for a moment given in milliseconds, or for a Date.
export function ymd(when = Date.now()) {
  const d = when instanceof Date ? when : new Date(when);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// "09:05" for a time in seconds.
export function hm(ts) {
  const d = new Date(ts * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// "2026-10-04 09:05" for a time in seconds.
export const isoLocal = (ts) => `${ymd(ts * 1000)} ${hm(ts)}`;

// A time of day as the owner may type it ("8:00", "08:00", " 18:30 ") → "08:00", or null
// if it is not one. The one rule for what counts as a time of day.
export function clock(s) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(s ?? '').trim());
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}

// Today's "HH:MM" as a time in seconds.
export function todayAt(hhmm, nowMs = Date.now()) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(nowMs);
  d.setHours(h, m, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

// The most recent of today's "HH:MM" times that has already passed, in seconds, or null.
export function latestSlot(times, nowMs = Date.now()) {
  const passed = times.map((t) => todayAt(t, nowMs)).filter((ts) => ts <= nowMs / 1000);
  return passed.length ? Math.max(...passed) : null;
}

// How long ago, in words: "just now", "12 min ago", "3 h ago", "5 days ago".
export function ago(ts) {
  const m = Math.round((now() - ts) / 60);
  return m < 2 ? 'just now' : m < 90 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
}

// How long ago, short, for columns: "5m ago", "3h ago", "12d ago", then the date; "never" for nothing.
export function agoShort(ts) {
  if (!ts) return 'never';
  const s = now() - ts;
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 30 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return ymd(ts * 1000);
}
