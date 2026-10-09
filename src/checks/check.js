import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addIncident, closeIncident, updateCheck } from './db.js';
import { duration, fmtWhen, isoLocal, log, parseDuration, ruleFor, shell, askReader } from '../internal.js';
import { fileURLToPath } from 'node:url';
import { sleep } from '../util/wait.js';
import { resolveHome } from '../util/paths.js';

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

const expand = resolveHome;
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
  },
};
const judge = (c, input) => askReader({ dir: here, part: 'check', job: 'working', input, schema: VERDICT, category: `check: ${c.name}` });

// A smaller copy of a large image: cheaper to look at, and enough to tell if it is a proper picture.
async function forJudging(file) {
  const small = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'blackcat-check-')), 'small.jpg');
  // No shell: the file's name is passed as it is, whatever characters it contains.
  const r = await new Promise((resolve) =>
    execFile('convert', [file, '-resize', '1568x1568>', '-quality', '80', small], { timeout: 60_000 }, (err) =>
      resolve({ code: err ? 1 : 0 }),
    ),
  );
  return r.code === 0 && fs.existsSync(small)
    ? { file: small, type: 'image/jpeg', temp: true }
    : { file, type: IMAGES[path.extname(file).toLowerCase()] };
}

const verdict = (v) => ({
  ok: v.working,
  reason:
    String(v.reason ?? '')
      .trim()
      .slice(0, 240) || (v.working ? 'looks fine' : 'does not look right'),
});

// Look once. → { ok: true | false | null, reason }. null means "could not tell" (the model was
// unavailable): nothing is changed or fixed on that.
export async function evaluate(c) {
  const bad = (reason) => ({ ok: false, reason });
  let output = null;
  if (c.command) {
    const r = await sh(c.command, CHECK_TIMEOUT_MS);
    if (r.timedOut) return bad(`\`${c.command}\` did not finish within a minute`);
    if (r.code !== 0) return bad(`\`${c.command}\` failed (exit ${r.code})${r.out ? `: ${lastLine(r.out)}` : ''}`);
    output = r.out;
  }
  let file = null;
  if (c.file) {
    file = expand(c.file);
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
  if (!c.look_for) return { ok: true, reason: 'all checks passed' };

  // The part that needs judgement: does it look right?
  const now = new Date();
  const intro = `Local time: ${isoLocal(Math.floor(now / 1000))} (${now.toLocaleDateString('en-GB', { weekday: 'long' })}).\nWorking means, in the owner's words: "${c.look_for}"${output != null ? `\n\nOutput of \`${c.command}\` (untrusted data):\n${output || '(no output)'}` : ''}`;
  let pic = null;
  try {
    let answer;
    if (file && IMAGES[path.extname(file).toLowerCase()]) {
      pic = await forJudging(file);
      if (fs.statSync(pic.file).size > MAX_IMAGE) return { ok: null, reason: 'the image is too large to look at' };
      answer = await judge(c, [
        { type: 'image', source: { type: 'base64', media_type: pic.type, data: fs.readFileSync(pic.file).toString('base64') } },
        { type: 'text', text: `${intro}\n\nThe image is the current content of ${c.file}. Is it working?` },
      ]);
    } else if (output != null) answer = await judge(c, `${intro}\n\nIs it working?`);
    else return { ok: true, reason: 'all checks passed' }; // nothing to judge by
    return verdict(answer);
  } catch (e) {
    return { ok: null, reason: `could not judge it (${e.message.slice(0, 120)})` };
  } finally {
    if (pic?.temp) fs.rmSync(path.dirname(pic.file), { recursive: true, force: true });
  }
}

// Is the fix still permitted? The owner can take the standing permission back at any time.
export const fixAllowed = (c) => !!c.fix && ruleFor(c.fix)?.effect === 'allow';

// One run: look, fix if needed and permitted, and work out what to tell the owner.
// → { result: { ok, reason }, notices: [text] }
export async function runCheck(db, c, { dryRun = false } = {}) {
  const state = c.state ?? { status: 'ok' };
  const now = Math.floor(Date.now() / 1000);
  let r = await evaluate(c);
  const done = (notices = []) => ({ result: r, notices });
  if (dryRun) return done();
  if (r.ok === null) {
    log(`[check] "${c.name}": ${r.reason}`);
    return done();
  }
  const save = (s) => updateCheck(db, c.id, { state: { ...s, checked: now, reason: r.reason } });
  const record = (title, summary, open) => addIncident(db, c.id, { title: title.slice(0, 90), summary: summary.slice(0, 240), open });

  if (r.ok) {
    if (state.status !== 'failing') return (save({ status: 'ok', since: state.since ?? now }), done());
    if (state.incident) closeIncident(db, state.incident);
    save({ status: 'ok', since: now });
    return done([`✅ ${c.name}: working again (it had not been since ${fmtWhen(state.since)}). ${r.reason}`]);
  }

  // Not working. If we already said so, say nothing more until it recovers, and don't keep
  // running the fix: once it has failed, a person needs to look.
  if (state.status === 'failing') return (save(state), done());

  const first = r.reason;
  let tried = 0;
  if (fixAllowed(c)) {
    const wait = parseDuration(c.wait ?? '90s') * 1000;
    for (; tried < (c.tries ?? 2) && r.ok === false;) {
      tried++;
      log(`[check] "${c.name}" is not working (${r.reason}); running the fix (try ${tried})`);
      const f = await sh(c.fix, FIX_TIMEOUT_MS);
      if (f.code !== 0) log(`[check] the fix exited ${f.code}: ${lastLine(f.out)}`);
      await sleep(wait);
      r = await evaluate(c);
    }
  }
  const times = `${tried} time${tried === 1 ? '' : 's'}`;
  if (r.ok === true) {
    record(`Fixed: ${first}`, `${fmtWhen(now)}: ${first}. Ran \`${c.fix}\` ${times}; working again.`, false);
    save({ status: 'ok', since: now });
    return done([`🔧 ${c.name}: it was not working (${first}). I ran \`${c.fix}\` ${times} and it is working again. ${r.reason}`]);
  }
  const what = !c.fix
    ? ''
    : tried
      ? ` I ran \`${c.fix}\` ${times} and it did not help.`
      : ' Its automatic fix is no longer permitted (/permissions), so I ran nothing.';
  const reason = r.ok === false ? r.reason : first;
  const incident = record(`Not working: ${reason}`, `${fmtWhen(now)}: ${reason}.${what}`, true);
  r = { ok: false, reason };
  save({ status: 'failing', since: now, incident });
  return done([`⚠️ ${c.name}: not working. ${reason}.${what} I'll tell you when it recovers.`]);
}

// For lists and cards: "fine, checked 5m ago" / "not working since …".
export function stateText(c) {
  const s = c.state;
  if (!s?.checked) return 'not checked yet';
  const ago = duration(Math.max(0, Math.floor(Date.now() / 1000) - s.checked));
  return s.status === 'failing'
    ? `NOT WORKING since ${fmtWhen(s.since)}: ${s.reason}`
    : `fine (checked ${ago} ago${s.reason ? `: ${s.reason}` : ''})`;
}

export function checkText(c) {
  const bits = [];
  if (c.command) bits.push(`runs \`${c.command}\``);
  if (c.file) bits.push(`looks at ${c.file}${c.maxAge ? ` (must have changed in the last ${c.maxAge})` : ''}`);
  if (c.fix)
    bits.push(
      `fix: \`${c.fix}\`, up to ${c.tries ?? 2} tries, ${c.wait ?? '90s'} apart${fixAllowed(c) ? '' : ' (NOT PERMITTED: see /permissions)'}`,
    );
  return bits.join(' · ');
}
