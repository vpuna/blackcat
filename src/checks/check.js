import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { record as noteActivity } from '../activity/log.js';
import {
  addFinding,
  currentFindings,
  justResolved,
  markTold,
  pastFindings,
  resolveFinding,
  seenAgain,
  setFixNote,
  updateCheck,
  wakeFinding,
} from './db.js';
import { DEFAULT_KEEP, addContext, addReading, lastContextTs, readings } from './history.js';
import { duration, fmtWhen, isoLocal, log, parseDuration, ruleFor, shell, askReader } from '../internal.js';
import { fileURLToPath } from 'node:url';
import { sleep } from '../util/wait.js';
import { resolveHome } from '../util/paths.js';
import { plural } from '../util/format.js';

// A check looks at a system on a schedule. It has:
//   command   a shell command; a non-zero exit means "not working"            (optional)
//   file      a file to look at, e.g. a camera's latest image                 (optional)
//   maxAge    the file must have changed within this long, e.g. "20m"         (optional)
//   fix       a shell command to run when it is not working                   (optional)
//   tries     how many times to run the fix before giving up (default 2)
//   wait      how long to wait after the fix before looking again (default "90s")
//   look_for  what "working" looks like, in the owner's words                  (optional)
// The command is very often a plugin's own `check` (blackcat ha check, blackcat unifi
// check, …): the plugin knows how to tell whether its system is well, the check asks on a schedule
// and tells the owner when the answer changes.
// When there is a description, a model (no tools) judges the image or the command's output
// against it. The owner is told when the state changes, not on every run.
//
// The commands are the owner's: they are shown in full and approved when the check is
// created. The fix additionally needs a standing "always allow" for that exact command
// (given at creation, revocable in /permissions); without it the fix is not run.

const IMAGES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
const MAX_IMAGE = 3.7 * 1024 ** 2;
const CHECK_TIMEOUT_MS = 60_000;
const FIX_TIMEOUT_MS = 5 * 60_000;

const lastLine = (s) => s.trim().split('\n').at(-1)?.slice(0, 200) ?? '';

// Run a command the owner approved, through the shell. Never throws.
const sh = (cmd, timeoutMs) => shell(cmd, { timeoutMs });

// The reader that judges whether something looks as the owner says it should (readers/working.md),
// and the shape of what it says.
const here = path.dirname(fileURLToPath(import.meta.url));
const VERDICT = {
  type: 'object',
  additionalProperties: false,
  required: ['working', 'reason'],
  properties: {
    working: { type: 'boolean', description: "Whether it is working, by the owner's description." },
    reason: { type: 'string', description: 'One short sentence saying what you see.' },
    problems: {
      type: 'array',
      description:
        'When it is not working: each separate thing that is wrong, one entry each. Empty when it is working. Several of the same kind (ten timeouts of one command) are one entry.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'title'],
        properties: {
          key: {
            type: 'string',
            description:
              'A few lowercase words joined by dashes naming the thing, the same every time for the same thing: "camera-check-failing", "ssh-nas-timeouts". When it is one of the problems already known, use its key exactly.',
          },
          title: { type: 'string', description: 'What is wrong, in one short sentence.' },
        },
      },
    },
  },
};
const judge = (c, input) => askReader({ dir: here, part: 'check', job: 'working', input, schema: VERDICT, category: `check: ${c.name}` });

// A smaller copy of a large image: cheaper to look at, and enough to tell if it is a proper picture.
async function forJudging(file, { size = 1568, quality = 80 } = {}) {
  // (Named apart from the engine check's temporary copy, "blackcat-check-…".)
  const small = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'blackcat-look-')), 'small.jpg');
  // No shell: the file's name is passed as it is, whatever characters it contains.
  const r = await new Promise((resolve) =>
    execFile('convert', [file, '-resize', `${size}x${size}>`, '-quality', String(quality), small], { timeout: 60_000 }, (err) =>
      resolve({ code: err ? 1 : 0 }),
    ),
  );
  if (r.code === 0 && fs.existsSync(small)) return { file: small, type: 'image/jpeg', temp: true };
  // It could not be made smaller: the picture is used as it is, and the folder is not left behind.
  fs.rmSync(path.dirname(small), { recursive: true, force: true });
  return { file, type: IMAGES[path.extname(file).toLowerCase()] };
}

// What one look found: everything that is wrong, each with a key that stays the same while it
// lasts. A check that is working or not has one thing it can find: 'down'.
const DOWN = 'down';
const slug = (k) =>
  String(k ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || DOWN;
const verdict = (v) => {
  const reason =
    String(v.reason ?? '')
      .trim()
      .slice(0, 240) || (v.working ? 'looks fine' : 'does not look right');
  if (v.working) return { ok: true, reason, problems: [] };
  const problems = [];
  for (const p of v.problems ?? []) {
    const key = slug(p.key);
    if (!problems.some((x) => x.key === key))
      problems.push({
        key,
        title:
          String(p.title ?? '')
            .trim()
            .slice(0, 200) || reason,
      });
  }
  return { ok: false, reason, problems: problems.length ? problems : [{ key: DOWN, title: reason }] };
};

// A command that failed and printed what is wrong as a list, { "problems": [{ key, title }] }
// (`bc activity problems --json`): each is a finding of its own, with no model asked.
// → the verdict, or null when it printed something else.
function listed(out) {
  let got;
  try {
    got = JSON.parse(out);
  } catch {
    return null;
  }
  if (!Array.isArray(got?.problems) || !got.problems.length) return null;
  const v = verdict({ working: false, reason: '', problems: got.problems });
  v.reason = v.problems.length === 1 ? v.problems[0].title : `${v.problems.length} things are wrong`;
  return v;
}

// ---- figures ----
// The figures a check keeps (--measure) and the ones it has limits on (--limit).
export const measured = (c) => [...new Set([...(c.measure ?? []), ...(c.limits ?? []).map((l) => l.field)])];
// "temp>75" → { field, op, value }
export function parseLimit(text) {
  const m = /^\s*([A-Za-z_][\w.]*)\s*([<>])\s*(-?\d+(?:\.\d+)?)\s*$/.exec(String(text ?? ''));
  if (!m) throw new Error(`A limit is a figure, > or <, and a number, like "temp>75" or "free<10" (not "${text}").`);
  return { field: m[1], op: m[2], value: Number(m[3]) };
}
export const limitKey = (l) => `${l.field}-${l.op === '>' ? 'high' : 'low'}`.replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
const num = (n) => String(Math.round(n * 100) / 100);
const limitText = (l, v) => `${l.field} ${num(v)}, ${l.op === '>' ? 'above' : 'below'} ${num(l.value)}`;
// The figures in a command's output: JSON with those fields (a.b.0 for one inside it), one
// number on its own when one figure is measured, or lines of "name=value" or "name: value".
// → { numbers, missing }
export function figures(out, names) {
  const text = String(out ?? '').trim();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const numbers = {};
  for (const n of names) {
    let v;
    if (json !== undefined && typeof json === 'object') v = n.split('.').reduce((o, k) => (o == null ? undefined : o[k]), json);
    else if (names.length === 1 && /^-?\d+(\.\d+)?$/.test(text)) v = text;
    else v = new RegExp(`^\\s*${n.replace(/\./g, '\\.')}\\s*[=:]\\s*(-?\\d+(?:\\.\\d+)?)`, 'm').exec(text)?.[1];
    if (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v))) numbers[n] = Number(v);
  }
  return { numbers, missing: names.filter((n) => !(n in numbers)) };
}

// Look once. → { ok: true | false | null, reason, problems: [{ key, title }], numbers? }. null means
// "could not tell" (the model was unavailable): nothing is changed or fixed on that.
// `known`: what is wrong already, so that a reader calls the same thing by the same key.
export async function evaluate(c, known = []) {
  const seen = {};
  const r = await look(c, known, seen);
  return seen.numbers ? { ...r, numbers: seen.numbers } : r;
}
async function look(c, known, seen) {
  const bad = (reason) => ({ ok: false, reason, problems: [{ key: DOWN, title: reason }] });
  const fine = { ok: true, reason: 'all checks passed', problems: [] };
  let output = null;
  if (c.command) {
    const r = await shell(c.command, { timeoutMs: CHECK_TIMEOUT_MS, keep: 64_000 });
    if (r.timedOut) return bad(`\`${c.command}\` did not finish within a minute`);
    if (r.code !== 0) return listed(r.out) ?? bad(`\`${c.command}\` failed (exit ${r.code})${r.out ? `: ${lastLine(r.out)}` : ''}`);
    output = r.out.slice(-3000);
    const names = measured(c);
    if (names.length) {
      const got = figures(r.out, names);
      if (got.missing.length) return bad(`\`${c.command}\` printed no ${got.missing.join(' or ')}`);
      seen.numbers = got.numbers;
      const over = (c.limits ?? []).filter((l) => (l.op === '>' ? got.numbers[l.field] > l.value : got.numbers[l.field] < l.value));
      if (over.length)
        return {
          ok: false,
          reason: over.map((l) => limitText(l, got.numbers[l.field])).join('; '),
          problems: over.map((l) => ({ key: limitKey(l), title: limitText(l, got.numbers[l.field]) })),
        };
    }
  }
  let file = null;
  if (c.file) {
    file = resolveHome(c.file);
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      return bad(`${c.file} does not exist`);
    }
    const age = (Date.now() - st.mtimeMs) / 1000;
    if (c.maxAge && age > parseDuration(c.maxAge))
      return bad(`${path.basename(file)} has not changed for ${duration(Math.round(age))} (limit ${c.maxAge})`);
    if (!st.size) return bad(`${path.basename(file)} is empty`);
  }
  if (!c.look_for) return fine;

  // The part that needs judgement: does it look right?
  const now = new Date();
  const already = known.length
    ? `\n\nProblems already known (use the same key when one is still so; "snoozed" means the owner knows of it):\n${known.map((f) => `- ${f.key}: ${f.title}${f.state === 'snoozed' ? ' (snoozed)' : ''}`).join('\n')}`
    : '';
  const intro = `Local time: ${isoLocal(Math.floor(now / 1000))} (${now.toLocaleDateString('en-GB', { weekday: 'long' })}).\nWorking means, in the owner's words: "${c.look_for}"${already}${output != null ? `\n\nOutput of \`${c.command}\` (untrusted data):\n${output || '(no output)'}` : ''}`;
  let pic = null;
  try {
    let answer;
    if (file && IMAGES[path.extname(file).toLowerCase()]) {
      pic = await forJudging(file);
      if (fs.statSync(pic.file).size > MAX_IMAGE) return { ok: null, reason: 'the image is too large to look at', problems: [] };
      answer = await judge(c, [
        { type: 'image', source: { type: 'base64', media_type: pic.type, data: fs.readFileSync(pic.file).toString('base64') } },
        { type: 'text', text: `${intro}\n\nThe image is the current content of ${c.file}. Is it working?` },
      ]);
    } else if (output != null) answer = await judge(c, `${intro}\n\nIs it working?`);
    else return fine; // nothing to judge by
    return verdict(answer);
  } catch (e) {
    return { ok: null, reason: `could not judge it (${e.message.slice(0, 120)})`, problems: [] };
  } finally {
    if (pic?.temp) fs.rmSync(path.dirname(pic.file), { recursive: true, force: true });
  }
}

// Is the fix still permitted? The owner can take the standing permission back at any time.
export const fixAllowed = (c) => !!c.fix && ruleFor(c.fix)?.effect === 'allow';

// ---- when the owner is told ----
// --alert as typed → stored: now | briefing | after 3 | after 15m
export function parseAlert(text) {
  const s = String(text ?? '')
    .trim()
    .toLowerCase();
  if (s === 'now' || s === '') return { at: 'now' };
  if (s === 'briefing') return { at: 'briefing' };
  const m = /^after\s+(\S+)$/.exec(s);
  if (m && /^\d+$/.test(m[1]) && Number(m[1]) >= 1 && Number(m[1]) <= 50) return { after: Number(m[1]) };
  if (m) return { afterS: parseDuration(m[1]) };
  throw new Error('--alert is one of: now, briefing, "after 3" (looks in a row), "after 15m" (down this long).');
}
export const alertText = (a) =>
  !a || a.at === 'now'
    ? 'at once'
    : a.at === 'briefing'
      ? 'in the briefing only'
      : a.after
        ? `after ${a.after} looks in a row find it`
        : `once it has lasted ${lasted(a.afterS)}`;
// --quiet "03:00-03:30" → the same, checked.
export function parseQuiet(text) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(String(text ?? ''));
  if (!m || +m[1] > 23 || +m[3] > 23 || +m[2] > 59 || +m[4] > 59) throw new Error('--quiet is a time of day like 03:00-03:30.');
  const hm = (h, mm) => `${String(h).padStart(2, '0')}:${mm}`;
  return `${hm(+m[1], m[2])}-${hm(+m[3], m[4])}`;
}
// Is `ts` inside the window (which may run past midnight)?
export function inQuiet(quiet, ts = Math.floor(Date.now() / 1000)) {
  if (!quiet) return false;
  const [a, b] = quiet.split('-').map((x) => x.split(':').map(Number));
  const d = new Date(ts * 1000);
  const m = d.getHours() * 60 + d.getMinutes();
  const from = a[0] * 60 + a[1];
  const to = b[0] * 60 + b[1];
  return from <= to ? m >= from && m < to : m >= from || m < to;
}
// Has the time come to tell the owner of a finding they have not been told of?
function due(c, f, t) {
  const a = c.alert ?? { at: 'now' };
  if (a.at === 'briefing') return false;
  if (a.after) return f.times >= a.after;
  if (a.afterS) return t - f.first_seen >= a.afterS;
  return true;
}

// How long an outage lasted, as said to a person: "40s", "12m", "2h 10m", "3d 4h".
export const lasted = (sec) => {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return duration(s).replace(/ 0m$/, '');
};

// A finding left alone for a few minutes after it worked again is the same outage if it comes back.
export const BOUNCE_S = 10 * 60;

// ---- what was going on ----
// While something stays wrong, what was going on is kept again this often.
const CONTEXT_EVERY_S = 15 * 60;
export const keepS = (c) => parseDuration(c.keep ?? DEFAULT_KEEP);
// What its context command prints, and its picture made small. Never throws: a check that
// could not keep what was going on still looks, and says what it found.
async function keepContext(c) {
  try {
    let output = null;
    if (c.context) {
      const r = await shell(c.context, { timeoutMs: CHECK_TIMEOUT_MS, keep: 64_000 });
      output = `${r.out}${r.timedOut ? '\n(it did not finish within a minute)' : r.code ? `\n(it exited ${r.code})` : ''}`.trim();
    }
    let file = null;
    const src = c.file && resolveHome(c.file);
    if (src && IMAGES[path.extname(src).toLowerCase()] && fs.existsSync(src)) {
      const pic = await forJudging(src, { size: 1024, quality: 70 });
      file = fs.readFileSync(pic.file);
      if (pic.temp) fs.rmSync(path.dirname(pic.file), { recursive: true, force: true });
    }
    if (output != null || file) addContext(c.id, { output, file, fileType: file ? 'image/jpeg' : null }, keepS(c));
    return output != null || !!file;
  } catch (e) {
    log(`[check] "${c.name}": what was going on could not be kept (${e.message})`);
    return false;
  }
}
const limitOf = (c, f) => (c.limits ?? []).find((l) => limitKey(l) === f.key) ?? null;
// For an alert about a limit: which way it is going, and how long it lasted last time.
function story(db, c, f, t) {
  const l = limitOf(c, f);
  if (!l) return '';
  const then = readings(c.id, t - 3600, t - 1800).find((r) => l.field in r.numbers);
  const now = readings(c.id, t - 600, t).at(-1)?.numbers[l.field];
  const way =
    then && now != null && now !== then.numbers[l.field]
      ? ` ${now > then.numbers[l.field] ? 'Rising' : 'Falling'}: it was ${num(then.numbers[l.field])} ${lasted(t - then.ts)} ago.`
      : '';
  const last = pastFindings(db, c.id, 50).find((x) => x.key === f.key && x.state === 'resolved' && x.id !== f.id && x.resolved_ts);
  return `${way}${last ? ` Last time (${fmtWhen(last.first_seen)}) it lasted ${lasted(last.resolved_ts - last.first_seen)}.` : ''}`;
}
// For "working again" after a limit: how far it went.
function peak(c, f, t) {
  const l = limitOf(c, f);
  const vs = l
    ? readings(c.id, f.first_seen, t)
        .map((r) => r.numbers[l.field])
        .filter((v) => v != null)
    : [];
  return vs.length ? `, ${l.op === '>' ? 'peak' : 'lowest'} ${l.field} ${num(l.op === '>' ? Math.max(...vs) : Math.min(...vs))}` : '';
}

// Run the fix until it works or the tries run out. → { r, tried }
async function fixing(c, r, known) {
  let tried = 0;
  const wait = parseDuration(c.wait ?? '90s') * 1000;
  for (; tried < (c.tries ?? 2) && r.ok === false;) {
    tried++;
    log(`[check] "${c.name}" is not working (${r.reason}); running the fix (try ${tried})`);
    const began = Date.now();
    const f = await sh(c.fix, FIX_TIMEOUT_MS);
    noteActivity({
      kind: 'event',
      category: `check: ${c.name}`,
      surface: 'job',
      ok: f.code === 0,
      ms: Date.now() - began,
      summary: `ran its fix (try ${tried})`,
      ...(f.code ? { data: { exit: f.code } } : {}),
    });
    if (f.code !== 0) log(`[check] the fix exited ${f.code}: ${lastLine(f.out)}`);
    await sleep(wait);
    r = await evaluate(c, known);
  }
  return { r, tried };
}

// One run: look, fix if needed and permitted, keep what was found, and work out what to tell
// the owner. `fixAgain`: run the fix whatever the findings (the owner asked for it).
// → { result: { ok, reason, problems }, notices: [{ text, finding, fix }], changed }
export async function runCheck(db, c, { dryRun = false, fixAgain = false } = {}) {
  const t = Math.floor(Date.now() / 1000);
  const known = currentFindings(db, c.id);
  let r = await evaluate(c, known);
  const done = (notices = [], changed = null) => ({ result: r, notices, changed });
  if (dryRun) return done();
  if (r.numbers) addReading(c.id, r.numbers, keepS(c));
  if (r.ok === null) {
    log(`[check] "${c.name}": ${r.reason}`);
    return done();
  }
  const notices = [];
  let changed = null;
  const quiet = inQuiet(c.quiet, t);
  const tell = (text, f) => notices.push({ text, finding: f?.id ?? null, fix: !!c.fix && fixAllowed(c) });

  // Something new is wrong (or the owner asked): the fix is tried first, if it is permitted.
  // Once it has failed for a finding it is not tried again on every look: a person needs to look.
  const fresh = r.ok === false && r.problems.some((p) => !known.some((f) => f.key === p.key));
  let fixNote = null;
  if (fixAllowed(c) && r.ok === false && (fresh || fixAgain)) {
    const first = r;
    const got = await fixing(c, r, known);
    r = got.r;
    const times = plural(got.tried, 'time');
    if (r.ok === true) {
      fixNote = `ran \`${c.fix}\` ${times}; it worked`;
      // Fixed straight away: kept as an outage that is already over.
      for (const p of first.problems.filter((x) => !known.some((f) => f.key === x.key)))
        addFinding(db, c.id, { key: p.key, title: p.title, detail: first.reason, resolved: true, fixNote });
      changed = 'fixed';
      if (!quiet && (c.alert?.at ?? 'now') === 'now')
        tell(`🔧 ${c.name}: it was not working (${first.reason}). I ran \`${c.fix}\` ${times} and it is working again. ${r.reason}`);
    } else if (r.ok === false) fixNote = got.tried ? `ran \`${c.fix}\` ${times}; it did not help` : null;
  } else if (c.fix && !fixAllowed(c) && fresh) fixNote = 'its fix is no longer permitted (/permissions), so nothing was run';

  // What is wrong now, against what was wrong before.
  const found = r.ok === false ? r.problems : [];
  const now = [];
  for (const p of found) {
    const cur = known.find((f) => f.key === p.key);
    if (cur) {
      now.push(seenAgain(db, cur.id, { title: p.title, detail: r.reason }));
      if (fixAgain && fixNote) setFixNote(db, cur.id, `${fixNote} (asked for again)`);
      continue;
    }
    const back = justResolved(db, c.id, p.key, BOUNCE_S);
    const f = back
      ? seenAgain(db, back.id, { title: p.title, detail: r.reason })
      : addFinding(db, c.id, { key: p.key, title: p.title, detail: r.reason });
    if (fixNote) setFixNote(db, f.id, fixNote);
    now.push({ ...f, alerted: back ? 0 : f.alerted, fix_note: fixNote ?? f.fix_note });
    changed ??= 'not working';
  }
  for (const f of known.filter((x) => !found.some((p) => p.key === x.key))) {
    resolveFinding(db, f.id);
    changed = changed ?? 'working again';
    if (f.alerted)
      tell(
        `✅ ${c.name}: working again${known.length > 1 ? ` (${f.title})` : ''}. It had not been since ${fmtWhen(f.first_seen)}: down ${lasted(t - f.first_seen)}${peak(c, f, t)}. ${r.reason}`,
      );
  }

  // What was going on: kept when it goes wrong, and again now and then while it stays so.
  const kept =
    found.length && (c.context || c.file) && (changed === 'not working' || t - lastContextTs(c.id) >= CONTEXT_EVERY_S)
      ? await keepContext(c)
      : false;

  // Who is told what: a new finding when its time has come, a snooze that has run out, and a
  // reminder for one still open. Nothing in the quiet window.
  for (const f of now) {
    let state = f.state;
    let woke = false;
    if (state === 'snoozed' && f.snoozed_until && f.snoozed_until <= t) {
      wakeFinding(db, f.id);
      state = 'open';
      woke = true;
    }
    if (state !== 'open' || quiet) continue;
    const remindS = c.remind ? parseDuration(c.remind) : null;
    const first = !f.alerted && due(c, f, t);
    const again = woke || (f.alerted && remindS && t - (f.told_ts ?? 0) >= remindS);
    if (!first && !again) continue;
    // (A thing of its own, named by a reader or by the command's list: said as itself.)
    const many = found.length > 1 || f.key !== DOWN;
    const head = first
      ? `⚠️ ${c.name}: ${many ? f.title : `not working. ${f.title}`}`
      : `⚠️ ${c.name}: still not working, since ${fmtWhen(f.first_seen)}${many ? `. ${f.title}` : ''}`;
    const fixed = f.fix_note ? ` ${f.fix_note.replace(/^ran/, 'I ran')}.` : '';
    const more = first ? `${story(db, c, f, t)}${kept ? ` What was going on is kept: bc check history ${c.id}` : ''}` : '';
    tell(`${head}${/[.!?]$/.test(head) ? '' : '.'}${fixed}${more}`, f);
    markTold(db, f.id);
  }
  updateCheck(db, c.id, { state: { ok: r.ok, checked: t, reason: r.reason } });
  return { result: r, notices, changed };
}

// For lists and cards: "fine, checked 5m ago" / "NOT WORKING since …" / "… (snoozed)".
export function stateText(c) {
  const w = c.wrong;
  if (w) {
    const more = w.open + w.snoozed > 1 ? ` (and ${w.open + w.snoozed - 1} more)` : '';
    return w.open
      ? `NOT WORKING since ${fmtWhen(w.since)}: ${w.title}${more}`
      : `not working since ${fmtWhen(w.since)}, snoozed: ${w.title}${more}`;
  }
  const s = c.state;
  if (!s?.checked) return 'not checked yet';
  const ago = duration(Math.max(0, Math.floor(Date.now() / 1000) - s.checked));
  return `fine (checked ${ago} ago${s.reason ? `: ${s.reason}` : ''})`;
}

// `short`: a long command cut to its start (in a list; `bc check show` has it whole).
export function checkText(c, { short = false } = {}) {
  const cmd = (s) => (short && s.length > 70 ? `${s.slice(0, 69)}…` : s);
  const bits = [];
  const told = [
    c.alert && c.alert.at !== 'now' ? `tells you ${alertText(c.alert)}` : null,
    c.quiet ? `quiet ${c.quiet}` : null,
    c.remind ? `reminds every ${c.remind}` : null,
  ].filter(Boolean);
  if (c.command) bits.push(`runs \`${cmd(c.command)}\``);
  if (c.file) bits.push(`looks at ${c.file}${c.maxAge ? ` (must have changed in the last ${c.maxAge})` : ''}`);
  if (c.measure?.length) bits.push(`keeps ${c.measure.join(', ')}`);
  if (c.limits?.length)
    bits.push(`not working when ${c.limits.map((l) => `${l.field} is ${l.op === '>' ? 'above' : 'below'} ${num(l.value)}`).join(' or ')}`);
  if (c.context) bits.push(`when it is not, keeps what \`${cmd(c.context)}\` prints`);
  if (c.keep && c.keep !== DEFAULT_KEEP) bits.push(`history kept ${c.keep}`);
  if (c.fix)
    bits.push(
      `fix: \`${c.fix}\`, up to ${c.tries ?? 2} tries, ${c.wait ?? '90s'} apart${fixAllowed(c) ? '' : ' (NOT PERMITTED: see /permissions)'}`,
    );
  return [...bits, ...told].join(' · ');
}
