import pc from 'picocolors';
import { checkText, evaluate, fixAllowed, runCheck, stateText } from './check.js';
import {
  DEFAULT_EVERY,
  addCheck,
  findCheck,
  getCheck,
  incidents,
  listChecks,
  openChecksDb,
  removeCheck,
  updateCheck,
  viaOf,
} from './db.js';
import {
  ScheduleError,
  TimeError,
  addRule,
  describeSchedule,
  fmtWhen,
  nextRun,
  ownerChat,
  parseDuration,
  parseWhenText,
  recordActivity,
  removeRule,
  ruleFor,
  scheduleDue,
  shortestGap,
  withDb as withOpen,
} from '../internal.js';

class Mistake extends Error {}
// A mistake in what was typed is said plainly, not thrown at the owner.
const guard = (fn) => async (i, fail) => {
  try {
    return await fn(i, fail);
  } catch (e) {
    if (e instanceof Mistake || e instanceof TimeError || e instanceof ScheduleError) return fail(e.message);
    throw e;
  }
};

const withDb = async (fn) => withOpen(openChecksDb, fn);
function must(db, ref) {
  const c = findCheck(db, ref);
  if (!c) throw new Mistake(`No single check matches "${ref}". See: bc check list`);
  return c;
}

// When it looks, as typed (a length, times of day, or cron) → cron. Never more often than every 5 minutes.
function everyOpt(text) {
  const cron = parseWhenText(text);
  if (shortestGap(cron) < 300) throw new Mistake('A check can look no more often than every 5 minutes.');
  return cron;
}

// What it looks at and what it may do, from the options, validated. `cur` is the check as it is, when changing one.
function build(opts, cur = {}) {
  const c = {
    command: cur.command ?? undefined,
    file: cur.file ?? undefined,
    maxAge: cur.maxAge ?? undefined,
    fix: cur.fix ?? undefined,
    tries: cur.tries ?? undefined,
    wait: cur.wait ?? undefined,
  };
  const text = (v) => String(v).trim() || undefined;
  if (opts.run !== undefined) c.command = text(opts.run);
  if (opts.file !== undefined) c.file = text(opts.file);
  if (opts.maxAge !== undefined) c.maxAge = text(opts.maxAge);
  if (opts.fix === false) c.fix = undefined;
  else if (opts.fix !== undefined) c.fix = text(opts.fix);
  if (opts.tries !== undefined) c.tries = Number(opts.tries);
  if (opts.wait !== undefined) c.wait = text(opts.wait);
  if (!c.command && !c.file) throw new Mistake('A check needs something to look at: --run "<command>", --file <path>, or both.');
  if (c.maxAge && !c.file) throw new Mistake('--max-age needs --file.');
  if (c.maxAge) parseDuration(c.maxAge);
  if (c.wait && parseDuration(c.wait) > 600) throw new Mistake('--wait can be at most 10m.');
  if (c.tries != null && !(Number.isInteger(c.tries) && c.tries >= 1 && c.tries <= 5))
    throw new Mistake('--tries is a number from 1 to 5.');
  return c;
}

// A check, as it is shown and as the agent gets it.
export function view(c) {
  return {
    id: c.id,
    name: c.name,
    active: c.active,
    runs: c.command ?? null,
    file: c.file ?? null,
    maxAge: c.maxAge ?? null,
    fix: c.fix ?? null,
    fixPermitted: c.fix ? fixAllowed(c) : null,
    tries: c.fix ? (c.tries ?? 2) : null,
    wait: c.fix ? (c.wait ?? '90s') : null,
    lookFor: c.look_for || null,
    what: checkText(c),
    looks: describeSchedule(c.every).replace(/^./, (x) => x.toLowerCase()),
    every: { cron: c.every, next: nextRun(c.every) },
    state: c.state?.status === 'failing' ? 'failing' : c.state?.checked ? 'working' : 'unknown',
    stateText: stateText(c),
  };
}

const lines = (c) => [
  `   looks at: ${checkText(c)}`,
  ...(c.look_for ? [`   working means: ${c.look_for}`] : []),
  `   looks:    ${view(c).looks}`,
  `   state:    ${c.state?.status === 'failing' ? pc.red(stateText(c)) : stateText(c)}`,
];

// Look once, straight away, so a check that is wrong is found out now rather than by its fix
// being run for no reason. The fix itself is never run as a test.
async function test(db, c) {
  const r = await evaluate(c);
  const now = Math.floor(Date.now() / 1000);
  if (r.ok === true) updateCheck(db, c.id, { state: { status: 'ok', since: now, checked: now, reason: r.reason }, last_run: now });
  return r;
}
const testLine = (r) =>
  r.ok === true
    ? `${pc.green('Tested now: working.')} ${r.reason}`
    : r.ok === false
      ? `${pc.red('Tested now: NOT working.')} ${r.reason}`
      : `${pc.yellow('Tested now: could not tell.')} ${r.reason}`;

// Take back the standing permission a check was given for its fix (not one the owner gave separately).
function dropFixRule(c, fix = c.fix) {
  const rule = fix ? ruleFor(fix) : null;
  if (rule?.via === viaOf(c.id)) removeRule(rule.id);
}

export const add = guard((i) =>
  withDb(async (db) => {
    const name = (i.name ?? []).join(' ').trim();
    if (!name) throw new Mistake('Give the check a name: bc check add "Camera" --run "<command>"');
    if (listChecks(db).some((c) => c.name.toLowerCase() === name.toLowerCase()))
      throw new Mistake(`There is already a check called "${name}". Change it: bc check edit "${name}" …`);
    const made = addCheck(db, {
      chatId: ownerChat(),
      name,
      look_for: i.lookFor || '',
      ...build(i),
      every: i.every ? everyOpt(i.every) : DEFAULT_EVERY,
    });
    // Creating the check is the owner's approval of its commands. The fix also gets a standing
    // "always allow", which the owner can take back in /permissions to stop it being run.
    if (made.fix) addRule('allow', made.fix, { via: viaOf(made.id) });
    // If it doesn't pass its first look, either the thing really is down or the check is
    // wrong. Either way it starts paused, so the fix isn't run on a check nobody has seen pass.
    const tested = await test(db, made);
    const paused = tested.ok !== true;
    if (paused) updateCheck(db, made.id, { active: false });
    const c = getCheck(db, made.id);
    const advice = `It is paused, and its fix has not been run. If the check is wrong, correct it (bc check edit ${c.id} --run …). If the thing really is down, fix it, or start the check anyway: bc check edit ${c.id} --resume`;
    return {
      text: [
        `${pc.green('✓')} Check ${c.id} "${c.name}" created${paused ? pc.yellow(' (paused)') : ''}.`,
        ...lines(c),
        `   ${testLine(tested)}`,
        ...(paused ? [pc.yellow(`   ${advice}`)] : []),
        ...(c.fix ? [pc.dim('   The fix may now run without asking. Take that back any time: bc permissions')] : []),
        pc.dim(`   Look again, without fixing anything: bc check run ${c.id} --dry-run`),
      ].join('\n'),
      data: { ...view(c), tested, ...(paused ? { paused: true, advice } : {}) },
    };
  }),
);

export const list = guard(() =>
  withDb((db) => {
    const all = listChecks(db);
    if (!all.length)
      return {
        text: 'No checks yet. Have one look at something on a schedule: bc check add "<name>" --run "<command>"',
        data: { checks: [] },
      };
    return {
      text: all
        .map((c) =>
          [
            `${pc.bold(String(c.id).padStart(3))}  ${pc.bold(c.name)}${c.active ? '' : pc.yellow(' (paused)')}`,
            ...lines(c).map((l) => `  ${l}`),
          ].join('\n'),
        )
        .join('\n'),
      data: { checks: all.map(view) },
    };
  }),
);

export const show = guard((i) =>
  withDb((db) => {
    const c = must(db, i.check);
    const past = incidents(db, c.id);
    return {
      text: [
        `${pc.bold(c.name)}${c.active ? '' : pc.yellow(' (paused)')}`,
        ...lines(c),
        '',
        past.length ? 'What went wrong, most recent first:' : 'Nothing has gone wrong since it was set up.',
        ...past.map(
          (p) => `   ${fmtWhen(p.ts)}  ${p.title}${p.open ? pc.red('  (still so)') : ''}${p.summary ? pc.dim(`\n      ${p.summary}`) : ''}`,
        ),
      ].join('\n'),
      data: { ...view(c), incidents: past.map((p) => ({ at: fmtWhen(p.ts), title: p.title, summary: p.summary, open: !!p.open })) },
    };
  }),
);

export const edit = guard((i) =>
  withDb(async (db) => {
    const c = must(db, i.check);
    const patch = {};
    if (i.name) patch.name = String(i.name).trim();
    if (i.lookFor === false) patch.look_for = '';
    else if (i.lookFor !== undefined) patch.look_for = String(i.lookFor).trim();
    if (i.every) patch.every = everyOpt(i.every);
    if (i.pause) patch.active = false;
    if (i.resume) patch.active = true;
    const changes = ['run', 'file', 'maxAge', 'fix', 'tries', 'wait'].some((k) => i[k] !== undefined);
    if (changes) Object.assign(patch, Object.fromEntries(Object.entries(build(i, c)).map(([k, v]) => [k, v ?? null])));
    if (!Object.keys(patch).length)
      throw new Mistake(
        'Say what to change: --run, --file, --max-age, --fix, --no-fix, --tries, --wait, --every, --look-for, --name, --pause or --resume.',
      );
    if (changes && (patch.fix ?? null) !== (c.fix ?? null)) {
      dropFixRule(c);
      if (patch.fix) addRule('allow', patch.fix, { via: viaOf(c.id) });
    }
    let out = updateCheck(db, c.id, patch);
    // A changed check is looked at once straight away, so a mistake shows now.
    const tested = changes || i.lookFor !== undefined ? await test(db, out) : null;
    out = getCheck(db, c.id);
    return {
      text: [
        `Check ${out.id} "${out.name}" updated${out.active ? '' : pc.yellow(' (paused)')}.`,
        ...lines(out),
        ...(tested ? [`   ${testLine(tested)}`] : []),
      ].join('\n'),
      data: { ...view(out), ...(tested ? { tested } : {}) },
    };
  }),
);

export const remove = guard((i) =>
  withDb((db) => {
    const c = must(db, i.check);
    dropFixRule(c);
    removeCheck(db, c.id);
    return { text: `Check "${c.name}" removed${c.fix ? ', and its fix may no longer run by itself' : ''}.`, data: { removed: c.name } };
  }),
);

// The checks whose turn it is: a scheduled moment has passed since each last looked.
export const dueChecks = (db, nowMs = Date.now()) =>
  listChecks(db, { activeOnly: true }).filter((c) => !c.last_run || scheduleDue(c.every, c.last_run, nowMs));

// Look now: one check, those whose turn it is (--due, used by the scheduler), or all that are running.
export const run = guard((i) =>
  withDb(async (db) => {
    const targets = i.check ? [must(db, i.check)] : i.due ? dueChecks(db) : listChecks(db, { activeOnly: true });
    const out = [];
    const text = [];
    for (const c of targets) {
      // Marked before looking, so a slow or failing look isn't started again every minute.
      if (!i.dryRun) updateCheck(db, c.id, { last_run: Math.floor(Date.now() / 1000) });
      const began = Date.now();
      const r = await runCheck(db, c, { dryRun: !!i.dryRun });
      // On the record only when it is not working: a look that found all well is not noted.
      if (!i.dryRun && r.result.ok === false)
        recordActivity({
          kind: 'event',
          category: `check: ${c.name}`,
          surface: 'job',
          ms: Date.now() - began,
          ok: false,
          summary: 'not working',
        });
      out.push({ id: c.id, name: c.name, chatId: c.chat_id, result: r.result, notices: r.notices });
      const mark = r.result.ok === true ? pc.green('working') : r.result.ok === false ? pc.red('NOT WORKING') : pc.yellow('could not tell');
      text.push(
        `${pc.bold(c.name)}: ${mark}. ${r.result.reason}${i.dryRun && r.result.ok === false && c.fix ? pc.dim(' (dry run: the fix was not run)') : ''}`,
        ...r.notices.map((n) => `   ${n}`),
      );
    }
    return { text: text.join('\n') || (i.due ? 'No check is due.' : 'No checks are running.'), data: { checks: out } };
  }),
);
