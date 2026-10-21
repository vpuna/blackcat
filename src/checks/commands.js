import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { came, ownerDid, recent, work } from '../activity/log.js';
import { FIXED } from '../activity/problems.js';
import {
  alertText,
  checkText,
  evaluate,
  fixAllowed,
  keepS,
  lasted,
  measured,
  parseAlert,
  parseLimit,
  parseQuiet,
  runCheck,
  stateText,
} from './check.js';
import { addReading, contexts, forget, keepOnly, readings } from './history.js';
import { plural } from '../util/format.js';
import {
  DEFAULT_EVERY,
  addCheck,
  findCheck,
  currentFindings,
  getCheck,
  listChecks,
  openChecksDb,
  pastFindings,
  removeCheck,
  resolveFinding,
  snoozeFinding,
  updateCheck,
  viaOf,
  wakeFinding,
} from './db.js';
import {
  HOME,
  ScheduleError,
  TimeError,
  addRule,
  describeSchedule,
  fmtWhen,
  loaded,
  makeCtx,
  nextRun,
  ownerChat,
  parseDuration,
  parseWhenText,
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
    measure: cur.measure ?? undefined,
    limits: cur.limits ?? undefined,
    context: cur.context ?? undefined,
    keep: cur.keep ?? undefined,
  };
  const text = (v) => String(v).trim() || undefined;
  if (opts.run !== undefined) c.command = text(opts.run);
  if (opts.file !== undefined) c.file = text(opts.file);
  if (opts.maxAge !== undefined) c.maxAge = text(opts.maxAge);
  if (opts.fix === false) c.fix = undefined;
  else if (opts.fix !== undefined) c.fix = text(opts.fix);
  if (opts.tries !== undefined) c.tries = Number(opts.tries);
  if (opts.wait !== undefined) c.wait = text(opts.wait);
  const listOf = (v) =>
    String(v)
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  if (opts.measure === false) c.measure = undefined;
  else if (opts.measure !== undefined) c.measure = listOf(opts.measure);
  if (opts.limit === false) c.limits = undefined;
  else if (opts.limit !== undefined)
    try {
      c.limits = listOf(opts.limit).map(parseLimit);
    } catch (e) {
      throw new Mistake(e.message);
    }
  if (opts.context === false) c.context = undefined;
  else if (opts.context !== undefined) c.context = text(opts.context);
  if (opts.keep !== undefined) c.keep = text(opts.keep);
  if (!c.command && !c.file) throw new Mistake('A check needs something to look at: --run "<command>", --file <path>, or both.');
  if (c.maxAge && !c.file) throw new Mistake('--max-age needs --file.');
  if (c.maxAge) parseDuration(c.maxAge);
  if (c.wait && parseDuration(c.wait) > 600) throw new Mistake('--wait can be at most 10m.');
  if (c.tries != null && !(Number.isInteger(c.tries) && c.tries >= 1 && c.tries <= 5))
    throw new Mistake('--tries is a number from 1 to 5.');
  if (measured(c).length && !c.command) throw new Mistake('--measure and --limit need --run: the figures come from what it prints.');
  if (c.keep && !(parseDuration(c.keep) >= 86400 && parseDuration(c.keep) <= 366 * 86400)) throw new Mistake('--keep is from 1d to 365d.');
  return c;
}

// When the owner is told, from the options: --alert, --quiet / --no-quiet, --remind / --no-remind.
function telling(opts) {
  const out = {};
  try {
    if (opts.alert !== undefined) out.alert = parseAlert(opts.alert);
    if (opts.quiet === false) out.quiet = null;
    else if (opts.quiet !== undefined) out.quiet = parseQuiet(opts.quiet);
  } catch (e) {
    throw new Mistake(e.message);
  }
  if (opts.remind === false) out.remind = null;
  else if (opts.remind !== undefined) {
    const s = parseDuration(String(opts.remind));
    if (s < 600) throw new Mistake('--remind is at least 10m.');
    out.remind = String(opts.remind).trim();
  }
  return out;
}

// A finding, as it is shown and as the agent gets it.
export function findingView(f) {
  return {
    id: f.id,
    key: f.key,
    title: f.title,
    state: f.state,
    since: fmtWhen(f.first_seen),
    lastSeen: fmtWhen(f.last_seen),
    times: f.times,
    ...(f.state === 'snoozed' ? { snoozedUntil: f.snoozed_until ? fmtWhen(f.snoozed_until) : 'until it works again' } : {}),
    ...(f.resolved_ts ? { resolved: fmtWhen(f.resolved_ts), lasted: lasted(f.resolved_ts - f.first_seen) } : {}),
    ...(f.fix_note ? { fix: f.fix_note } : {}),
    ...(f.detail && f.detail !== f.title ? { detail: f.detail } : {}),
  };
}
export const findingLine = (f, n) =>
  `${n != null ? `${n}. ` : ''}${f.title} · since ${fmtWhen(f.first_seen)}${f.times > 1 ? `, found ${f.times} times` : ''}${
    f.state === 'snoozed' ? ` · snoozed ${f.snoozed_until ? `until ${fmtWhen(f.snoozed_until)}` : 'until it works again'}` : ''
  }${f.fix_note ? ` · ${f.fix_note}` : ''}`;

// A check, as it is shown and as the agent gets it.
export function view(c) {
  return {
    id: c.id,
    name: c.name,
    ...(c.builtin ? { builtin: true } : {}),
    active: c.active,
    runs: c.command ?? null,
    file: c.file ?? null,
    maxAge: c.maxAge ?? null,
    fix: c.fix ?? null,
    fixPermitted: c.fix ? fixAllowed(c) : null,
    tries: c.fix ? (c.tries ?? 2) : null,
    wait: c.fix ? (c.wait ?? '90s') : null,
    lookFor: c.look_for || null,
    measure: c.measure ?? null,
    limits: c.limits?.map((l) => `${l.field}${l.op}${l.value}`) ?? null,
    context: c.context ?? null,
    keep: c.keep ?? null,
    what: checkText(c),
    looks: describeSchedule(c.every).replace(/^./, (x) => x.toLowerCase()),
    every: { cron: c.every, next: nextRun(c.every) },
    alert: alertText(c.alert),
    quiet: c.quiet,
    remind: c.remind,
    state: c.wrong ? (c.wrong.open ? 'failing' : 'snoozed') : c.state?.checked ? 'working' : 'unknown',
    stateText: stateText(c),
  };
}

const lines = (c, opts) => [
  `   looks at: ${checkText(c, opts)}`,
  ...(c.look_for ? [`   working means: ${c.look_for}`] : []),
  `   looks:    ${view(c).looks}`,
  `   state:    ${c.wrong?.open ? pc.red(stateText(c)) : stateText(c)}`,
];

// Look once, straight away, so a check that is wrong is found out now rather than by its fix
// being run for no reason. The fix itself is never run as a test.
// Working: what was wrong is over (it was changed so that it works, say).
async function test(db, c) {
  const known = currentFindings(db, c.id);
  const r = await evaluate(c, known);
  const now = Math.floor(Date.now() / 1000);
  // (What it read is its first reading.)
  if (r.numbers) addReading(c.id, r.numbers, keepS(c));
  if (r.ok === true) {
    updateCheck(db, c.id, { state: { ok: true, checked: now, reason: r.reason }, last_run: now });
    known.forEach((f) => resolveFinding(db, f.id));
    if (known.length) r.reason = `${r.reason} (what was wrong is now over)`;
  }
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

// ---- checks that plugins offer ----
// A plugin may offer checks ready to switch on, in its manifest (`checks`). None runs until
// the owner adds it; then it is a check like any other. → [{ ref: 'ssh:nas-heat', plugin, … }]
export function offers() {
  const out = [];
  for (const p of loaded()) {
    let list = p.manifest.checks;
    if (!list) continue;
    try {
      if (typeof list === 'function') list = list(makeCtx(p, { caller: 'owner', surface: 'job' }));
    } catch {
      continue;
    }
    for (const o of list ?? []) if (o?.id && o.name && o.run) out.push({ ...o, plugin: p.name, ref: `${p.name}:${o.id}` });
  }
  return out;
}
// `--from ssh:nas-heat`: what the offer says, under what the owner typed. Its name unless they gave one.
async function fromOffer(i) {
  const o = offers().find((x) => x.ref === String(i.from).trim());
  if (!o) throw new Mistake(`Nothing is offered as "${i.from}". See: bc check offered`);
  const pick = (k, v) => (i[k] !== undefined ? i[k] : v);
  return {
    ...i,
    name: i.name?.length ? i.name : [o.name],
    run: pick('run', o.run),
    file: pick('file', o.file),
    maxAge: pick('maxAge', o.maxAge),
    measure: pick('measure', o.measure?.join(',')),
    limit: pick('limit', o.limit?.join(',')),
    context: pick('context', o.context),
    every: pick('every', o.every),
  };
}

export const offered = guard(() => {
  const all = offers();
  if (!all.length) return { text: 'No plugin that is switched on offers a check.', data: { offered: [] } };
  return {
    text: [
      ...all.map(
        (o) => `${pc.bold(o.ref)}  ${o.name}\n   ${o.summary ?? ''}${o.limit?.length ? pc.dim(` · limit ${o.limit.join(', ')}`) : ''}`,
      ),
      '',
      pc.dim('Add one, with limits of your own if you like: bc check add --from <ref> [--limit "temp>70"]'),
    ].join('\n'),
    data: {
      offered: all.map(({ ref, plugin, name, summary, run, measure, limit, context, every }) => ({
        ref,
        plugin,
        name,
        summary,
        run,
        measure,
        limit,
        context,
        every,
      })),
    },
  };
});

export const add = guard((i) =>
  withDb(async (db) => {
    if (i.from) i = await fromOffer(i);
    const name = (i.name ?? []).join(' ').trim();
    if (!name) throw new Mistake('Give the check a name: bc check add "Camera" --run "<command>"');
    if (listChecks(db).some((c) => c.name.toLowerCase() === name.toLowerCase()))
      throw new Mistake(`There is already a check called "${name}". Change it: bc check edit "${name}" …`);
    const made = addCheck(db, {
      chatId: ownerChat(),
      name,
      look_for: i.lookFor || '',
      ...build(i),
      ...telling(i),
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
        ...lines(c, { short: true }),
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
            ...lines(c, { short: true }).map((l) => `  ${l}`),
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
    const now = currentFindings(db, c.id);
    const past = pastFindings(db, c.id).filter((f) => f.state === 'resolved');
    return {
      text: [
        `${pc.bold(c.name)}${c.active ? '' : pc.yellow(' (paused)')}`,
        ...lines(c),
        ...(now.length
          ? ['', 'Wrong now:', ...now.map((f, n) => `   ${f.state === 'open' ? pc.red(findingLine(f, n + 1)) : findingLine(f, n + 1)}`)]
          : []),
        ...(now.length
          ? [
              pc.dim(
                `   Snooze: bc check snooze ${c.id}${now.length > 1 ? ' [-n <number>]' : ''} --for 4h · fixed it: bc check fixed ${c.id}`,
              ),
            ]
          : []),
        '',
        past.length ? 'Before, most recent first:' : 'Nothing has gone wrong since it was set up.',
        ...past.map(
          (f) =>
            `   ${fmtWhen(f.first_seen)}  ${f.title} · ${f.resolved_ts ? `over after ${lasted(f.resolved_ts - f.first_seen)}` : 'over'}${f.fix_note ? pc.dim(` · ${f.fix_note}`) : ''}`,
        ),
      ].join('\n'),
      data: { ...view(c), now: now.map(findingView), before: past.map(findingView) },
    };
  }),
);

export const edit = guard((i) =>
  withDb(async (db) => {
    const c = must(db, i.check);
    if (
      c.builtin &&
      (['run', 'file', 'maxAge', 'fix', 'tries', 'wait', 'measure', 'limit', 'context'].some((k) => i[k] !== undefined) ||
        i.lookFor !== undefined)
    )
      throw new Mistake(
        `"${c.name}" is part of blackcat: what it looks at stays as it is. You can change when it looks (--every), when you are told (--alert, --quiet, --remind), its name, or pause it.`,
      );
    const patch = {};
    if (i.name) patch.name = String(i.name).trim();
    if (i.lookFor === false) patch.look_for = '';
    else if (i.lookFor !== undefined) patch.look_for = String(i.lookFor).trim();
    if (i.every) patch.every = everyOpt(i.every);
    if (i.pause) patch.active = false;
    if (i.resume) patch.active = true;
    Object.assign(patch, telling(i));
    const changes = ['run', 'file', 'maxAge', 'fix', 'tries', 'wait', 'measure', 'limit', 'context', 'keep'].some(
      (k) => i[k] !== undefined,
    );
    if (changes) Object.assign(patch, Object.fromEntries(Object.entries(build(i, c)).map(([k, v]) => [k, v ?? null])));
    if (!Object.keys(patch).length)
      throw new Mistake(
        'Say what to change: --run, --file, --max-age, --fix, --no-fix, --tries, --wait, --measure, --limit, --context, --keep, --every, --look-for, --alert, --quiet, --remind, --name, --pause or --resume.',
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
    if (c.builtin)
      throw new Mistake(`"${c.name}" is part of blackcat and can't be removed. Pause it instead: bc check edit ${c.id} --pause`);
    dropFixRule(c);
    forget(c.id);
    removeCheck(db, c.id);
    return { text: `Check "${c.name}" removed${c.fix ? ', and its fix may no longer run by itself' : ''}.`, data: { removed: c.name } };
  }),
);

// ---- history ----
const span = (vs) => {
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const r = (n) => String(Math.round(n * 100) / 100);
  return lo === hi ? r(lo) : `${r(lo)} to ${r(hi)}`;
};
// What a check saw over a while: its figures in brief, and each time it was not working with
// what was going on then, and what blackcat itself did in the half hour before.
export const history = guard((i) =>
  withDb((db) => {
    const c = must(db, i.check);
    const now = Math.floor(Date.now() / 1000);
    const since = now - parseDuration(String(i.since ?? '24h'));
    const rs = readings(c.id, since, now);
    const fields = [...new Set(rs.flatMap((r) => Object.keys(r.numbers)))];
    const figuresNow = fields.map((f) => {
      const vs = rs.map((r) => r.numbers[f]).filter((v) => v != null);
      return { field: f, range: span(vs), now: vs.at(-1), readings: vs.length };
    });
    const wrong = pastFindings(db, c.id, 100).filter((f) => (f.resolved_ts ?? now) >= since);
    const pics = [];
    // (Where the agent works, so that it can send them.)
    const folder = path.join(HOME, 'agent', 'check-pictures');
    const incidents = wrong.reverse().map((f) => {
      const end = f.resolved_ts ?? now;
      const kept = contexts(c.id, f.first_seen - 60, end, { files: !!i.pictures });
      for (const k of kept)
        if (k.file) {
          fs.mkdirSync(folder, { recursive: true });
          const file = path.join(folder, `${c.id}-${k.ts}.jpg`);
          fs.writeFileSync(file, k.file);
          pics.push(file);
          k.picture = file;
        }
      const before = recent({ sinceTs: f.first_seen - 1800, limit: 500 })
        .filter((e) => e.ts <= f.first_seen && e.kind !== 'model' && e.category !== `check: ${c.name}`)
        .slice(0, 15)
        .reverse()
        .map((e) => `${fmtWhen(e.ts)} ${e.category}${e.summary ? `: ${e.summary}` : ''}${e.ok === false ? ' (failed)' : ''}`);
      return {
        title: f.title,
        from: fmtWhen(f.first_seen),
        to: f.resolved_ts ? fmtWhen(f.resolved_ts) : null,
        lasted: lasted(end - f.first_seen),
        ...(f.fix_note ? { fix: f.fix_note } : {}),
        context: kept.map((k) => ({ at: fmtWhen(k.ts), output: k.output, picture: k.picture ?? (k.file_type ? 'kept' : null) })),
        blackcatBefore: before,
      };
    });
    const text = [
      `${pc.bold(c.name)} · since ${fmtWhen(since)}`,
      ...(figuresNow.length
        ? figuresNow.map((f) => `   ${f.field}: ${f.range}, now ${f.now} (${plural(f.readings, 'reading')})`)
        : [pc.dim('   No figures kept (bc check edit … --measure or --limit).')]),
      '',
      incidents.length ? 'Not working:' : 'Working all that time.',
      ...incidents.flatMap((n) => [
        `   ${n.from}${n.to ? ` to ${n.to}` : ', still'} (${n.lasted}): ${n.title}${n.fix ? pc.dim(` · ${n.fix}`) : ''}`,
        ...n.context.flatMap((k) => [
          `      What was going on, ${k.at}:`,
          ...(k.output ?? '')
            .split('\n')
            .slice(0, 40)
            .map((l) => `        ${l}`),
          ...(k.picture ? [`        picture: ${k.picture === 'kept' ? 'kept (--pictures to save it)' : k.picture}`] : []),
        ]),
        ...(n.blackcatBefore.length
          ? ['      What blackcat did in the half hour before:', ...n.blackcatBefore.map((l) => `        ${l}`)]
          : []),
      ]),
    ].join('\n');
    // (For the agent: the readings themselves too, at most a hundred, evenly spread.)
    const step = Math.max(1, Math.ceil(rs.length / 100));
    return {
      text,
      data: {
        check: c.name,
        since: fmtWhen(since),
        figures: figuresNow,
        readings: rs.filter((_, n) => n % step === 0).map((r) => ({ at: fmtWhen(r.ts), ...r.numbers })),
        incidents,
        ...(pics.length ? { pictures: pics } : {}),
      },
    };
  }),
);

// The checks whose turn it is: a scheduled moment has passed since each last looked.
export const dueChecks = (db, nowMs = Date.now()) =>
  listChecks(db, { activeOnly: true }).filter((c) => !c.last_run || scheduleDue(c.every, c.last_run, nowMs));

// Look now: one check, those whose turn it is (--due, used by the scheduler), or all that are running.
export const run = guard((i) =>
  withDb(async (db) => {
    const targets = i.check ? [must(db, i.check)] : i.due ? dueChecks(db) : listChecks(db, { activeOnly: true });
    // (What is left of a check removed while blackcat was stopping goes now.)
    if (i.due && targets.length) keepOnly(listChecks(db).map((c) => c.id));
    const out = [];
    const text = [];
    for (const c of targets) {
      // Marked before looking, so a slow or failing look isn't started again every minute.
      if (!i.dryRun) updateCheck(db, c.id, { last_run: Math.floor(Date.now() / 1000) });
      // On the record: a look that found all well is counted, with its time, and not listed.
      const look = () => runCheck(db, c, { dryRun: !!i.dryRun });
      const r = i.dryRun
        ? await look()
        : await work({ kind: 'event', category: `check: ${c.name}`, surface: 'job' }, async () => {
            const got = await look();
            return came({
              ...got,
              // (A check that found something wrong worked: what it found is said, and the owner is told.)
              ok: got.result.ok !== null,
              idle: got.result.ok === true && !got.changed,
              did: got.changed ?? (got.result.ok === false ? 'not working' : got.result.ok === true ? 'working' : 'could not tell'),
            });
          });
      out.push({ id: c.id, name: c.name, chatId: c.chat_id, result: r.result, notices: r.notices });
      const mark = r.result.ok === true ? pc.green('working') : r.result.ok === false ? pc.red('NOT WORKING') : pc.yellow('could not tell');
      text.push(
        `${pc.bold(c.name)}: ${mark}. ${r.result.reason}${i.dryRun && r.result.ok === false && c.fix ? pc.dim(' (dry run: the fix was not run)') : ''}`,
        ...r.notices.map((n) => `   ${n.text}`),
      );
    }
    return { text: text.join('\n') || (i.due ? 'No check is due.' : 'No checks are running.'), data: { checks: out } };
  }),
);

// ---- what the owner does about a finding ----

// The findings of a check that are meant: the nth of what is wrong now, or all of it.
function meant(db, c, n) {
  const now = currentFindings(db, c.id);
  if (!now.length) throw new Mistake(`Nothing is wrong with "${c.name}" just now.`);
  if (n == null) return now;
  const f = now[Number(n) - 1];
  if (!f)
    throw new Mistake(
      `"${c.name}" has ${now.length} thing${now.length === 1 ? '' : 's'} wrong: give a number from 1 to ${now.length} (bc check show ${c.id}).`,
    );
  return [f];
}

// Until when a snooze lasts: a length, until it works again (null), or tomorrow morning.
export const MORNING_HOUR = 8;
export function snoozeEnd({ for: len, untilFixed } = {}, nowMs = Date.now()) {
  if (untilFixed) return null;
  if (len) {
    const s = parseDuration(String(len));
    if (s < 600) throw new Mistake('A snooze is at least 10m.');
    return Math.floor(nowMs / 1000) + s;
  }
  const d = new Date(nowMs);
  d.setHours(MORNING_HOUR, 0, 0, 0);
  if (d.getTime() <= nowMs) d.setDate(d.getDate() + 1);
  return Math.floor(d.getTime() / 1000);
}
export const untilText = (until) => (until == null ? 'until it works again' : `until ${fmtWhen(until)}`);

// Snooze findings by their ids (the chat's buttons) → how many.
export function snoozeIds(db, ids, until) {
  return ids.reduce((n, id) => n + snoozeFinding(db, id, until), 0);
}

export const snooze = guard((i) =>
  withDb((db) => {
    const c = must(db, i.check);
    const until = snoozeEnd(i);
    const fs = meant(db, c, i.n);
    snoozeIds(
      db,
      fs.map((f) => f.id),
      until,
    );
    return {
      text: `Snoozed ${untilText(until)}: ${fs.map((f) => f.title).join('; ')}. You'll be told when it works again${until ? ', or if it is still wrong then' : ''}.`,
      data: { check: c.name, snoozed: fs.map((f) => f.id), until: until == null ? null : fmtWhen(until) },
    };
  }),
);

export const unsnooze = guard((i) =>
  withDb((db) => {
    const c = must(db, i.check);
    const fs = meant(db, c, i.n).filter((f) => f.state === 'snoozed');
    if (!fs.length) throw new Mistake(`Nothing of "${c.name}" is snoozed.`);
    fs.forEach((f) => wakeFinding(db, f.id));
    return { text: `Not snoozed any more: ${fs.map((f) => f.title).join('; ')}.`, data: { check: c.name, woken: fs.map((f) => f.id) } };
  }),
);

// "I fixed it": look now, and when it is still wrong, again after a minute and after a few more
// (a service takes a moment to come back). `fixed`: the findings the owner said were fixed (all
// that are wrong, by default), noted on the activity record: a check that judges by what
// happened over a day (bc activity problems) counts only from now for those.
// → { result, notices, tries }
export async function lookAgain(db, c, { waits = [60, 120], onWait, fixed = currentFindings(db, c.id) } = {}) {
  for (const f of fixed) ownerDid(FIXED, f.title.slice(0, 160), { data: { check: c.name, key: f.key } });
  let r;
  let tries = 0;
  for (;;) {
    tries++;
    updateCheck(db, c.id, { last_run: Math.floor(Date.now() / 1000) });
    r = await runCheck(db, getCheck(db, c.id));
    if (r.result.ok !== false || tries > waits.length) return { ...r, tries };
    const s = waits[tries - 1];
    await onWait?.(s, r);
    await new Promise((res) => setTimeout(res, s * 1000));
  }
}

const said = (c, r) =>
  r.result.ok === true
    ? r.notices.length
      ? r.notices.map((n) => n.text).join('\n')
      : `✅ ${c.name}: working. ${r.result.reason}`
    : r.result.ok === false
      ? `✗ ${c.name}: still not working. ${r.result.reason}`
      : `❔ ${c.name}: could not tell. ${r.result.reason}`;

export const fixed = guard((i) =>
  withDb(async (db) => {
    const c = must(db, i.check);
    const r = await lookAgain(db, c, {
      waits: i.wait === false ? [] : [60, 120],
      onWait: (s) => process.stderr.write(pc.dim(`Still not working; looking again in ${lasted(s)}…\n`)),
    });
    return { text: said(c, r), data: { check: c.name, working: r.result.ok, reason: r.result.reason, looks: r.tries } };
  }),
);

// Run the fix again now, whatever it did before, and look.
export async function fixNow(db, c) {
  if (!c.fix) throw new Mistake(`"${c.name}" has no fix. Add one: bc check edit ${c.id} --fix "<command>"`);
  if (!fixAllowed(c)) throw new Mistake(`The fix of "${c.name}" is no longer permitted (bc permissions), so it is not run.`);
  updateCheck(db, c.id, { last_run: Math.floor(Date.now() / 1000) });
  return runCheck(db, c, { fixAgain: true });
}
export const fix = guard((i) =>
  withDb(async (db) => {
    const c = must(db, i.check);
    const r = await fixNow(db, c);
    return { text: said(c, r), data: { check: c.name, working: r.result.ok, reason: r.result.reason } };
  }),
);
