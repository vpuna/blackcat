// Routines: listing, adding, approving, and running one to its confirmation and past it,
// with the owner following along and asked at the press. (Split out of plugin.js.)
import fs from 'node:fs';
import { ago, handOff, holdRestart, now, plural, recordActivity, sleep } from '../../src/api.js';
import {
  appProblems,
  deleteRoutine,
  fingerprint,
  getDevice,
  lastRun,
  listDevices,
  listApps,
  listRoutines,
  loadApp,
  loadRoutine,
  recordRun,
  saveApp,
  saveRoutine,
  setApproved,
  stateOf,
  validate,
  withParams,
} from './routines.js';
import { judgeResult } from './after.js';
import { diagnose } from './recover.js';
import { imageBlock } from './pictures.js';
import { putBack, Runner, session, StepFailed, Stopped } from './runner.js';
import { spoken, spokenAny } from './screen.js';
import { media, chosen, reach, MEDIA } from './shared.js';
import { appPackage } from './learning.js';

// ---------- routines ----------

// One run at a time on a device: there is one screen. A run that died is not waited for.
export function take(ctx, d, what) {
  const key = `running:${d.name}`;
  const mine = { pid: process.pid, what, at: now() };
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const held = ctx.store.update(key, (cur) => (cur && cur.pid !== process.pid && alive(cur.pid) && now() - cur.at < 1800 ? cur : mine));
  if (held.pid !== process.pid) ctx.fail(`The ${d.name} is busy: ${held.what}, since ${ago(held.at)}. Try again when it has finished.`);
  return () => ctx.store.update(key, (cur) => (cur?.pid === process.pid ? undefined : cur));
}

// The "tidy" job: on each device nothing runs on, what a run cut off before its end left.
// (One not connected is passed over: bc health says so.)
export async function tidy(ctx) {
  const done = [];
  for (const d of listDevices(ctx)) {
    let free;
    try {
      free = take(ctx, d, 'putting back what a run left');
    } catch {
      continue; // a run is going
    }
    try {
      const dev = await reach(ctx, d).catch(() => null);
      if (dev && (await putBack(dev))) done.push(d.name);
    } finally {
      free();
    }
  }
  return done.length ? { did: `put back "stay awake while charging" on the ${done.join(', ')}, left on by a run cut off` } : { idle: true };
}

export const sets = (list) =>
  Object.fromEntries(
    (list ?? []).map((kv) => {
      const at = kv.indexOf('=');
      if (at < 1) throw new Error(`--set takes name=value, not "${kv}"`);
      return [
        kv.slice(0, at).trim(),
        kv
          .slice(at + 1)
          .trim()
          .replace(/^"(.*)"$/, '$1'),
      ];
    }),
  );

export function routines(ctx) {
  const rows = listRoutines(ctx).map((name) => {
    try {
      const r = loadRoutine(ctx, name);
      const last = lastRun(ctx, name);
      return {
        name,
        app: r.app,
        device: r.device ?? null,
        goal: r.goal ?? null,
        params: Object.entries(r.params ?? {}).map(([k, v]) => (v.optional ? `${k} (optional)` : k)),
        state: stateOf(ctx, name, r),
        last: last && { at: last.ts, outcome: last.outcome, step: last.step, device: last.device },
      };
    } catch (e) {
      return { name, state: 'has mistakes', problem: e.message };
    }
  });
  const apps = listApps(ctx).map(
    (a) =>
      `${a.label ?? a.package} (${a.package}): ${plural(a.popups.length, 'pop-up', 'pop-ups')} cleared, ${a.commit.length ? `asks before ${a.commit.map((c) => `"${c}"`).join(', ')}` : 'nothing it books, pays or sends'}`,
  );
  if (!rows.length) return { text: ['No routines yet. bc android add <file> adds one.', ...apps].join('\n'), data: [] };
  return {
    text: [
      ...rows.map(
        (r) =>
          `${r.name} · ${r.state}${r.app ? ` · ${r.app}` : ''}${r.device ? ` on the ${r.device}` : ''}${r.params?.length ? ` · takes ${r.params.join(', ')}` : ''}${r.last ? ` · last run ${ago(r.last.at)}: ${r.last.outcome}` : ''}${r.goal ? `\n   ${r.goal}` : ''}${r.problem ? `\n   ${r.problem}` : ''}`,
      ),
      ...(apps.length ? ['', 'Apps:', ...apps.map((x) => `  ${x}`)] : []),
    ].join('\n'),
    data: rows,
  };
}

// One routine, or what is kept for an app (by its package), whole: --json gives what `add`
// takes back after it is edited.
export function show(ctx, i) {
  if (/\./.test(i.name)) {
    const a = loadApp(ctx, i.name);
    return { text: JSON.stringify(a, null, 2), data: a };
  }
  const r = loadRoutine(ctx, i.name);
  return { text: `${r.name} · ${stateOf(ctx, r.name, r)}\n${JSON.stringify(r, null, 2)}`, data: r };
}

// A routine, or an app's pop-ups and buttons, from a file: checked, then saved. A routine
// saved is a draft, until it is tried and approved again.
export function add(ctx, i) {
  let x;
  try {
    x = JSON.parse(fs.readFileSync(i.file, 'utf8'));
  } catch (e) {
    ctx.fail(`${i.file} cannot be read as JSON: ${e.message}`);
  }
  if (x && x.package && !x.steps) {
    const problems = appProblems(x);
    if (problems.length) ctx.fail(`Not saved. It has mistakes:\n- ${problems.join('\n- ')}`);
    saveApp(ctx, x);
    return `Saved what is kept for ${x.package}. Routines for it use it from their next run.`;
  }
  const problems = validate(x, loadApp(ctx, x?.app));
  if (problems.length) ctx.fail(`Not added. The routine has mistakes:\n- ${problems.join('\n- ')}`);
  const replaced = saveRoutine(ctx, x);
  const unknown = x.device && !getDevice(ctx, x.device) ? `\nNo device is paired as "${x.device}" yet.` : '';
  // (A change only to what is looked at after the press keeps it approved.)
  if (replaced && stateOf(ctx, x.name, x) === 'approved')
    return `Replaced "${x.name}". The change only looks, so it stays approved.${unknown}`;
  return `${replaced ? 'Replaced' : 'Added'} "${x.name}", as a draft. Try it: bc android run ${x.name} --dry, then bc android approve ${x.name}.${unknown}`;
}

export function remove(ctx, i) {
  if (!deleteRoutine(ctx, i.name)) ctx.fail(`There is no routine called "${i.name}".`);
  return `Removed "${i.name}". Its past runs are kept in the activity record.`;
}

export function approve(ctx, i) {
  const r = loadRoutine(ctx, i.name);
  const last = lastRun(ctx, i.name);
  // (One with no confirmation books nothing: a dry run of it goes to its end.)
  const confirms = r.steps.some((s) => s.do === 'confirm');
  const tried = confirms ? ['cancelled', 'expired', 'declined', 'unasked'] : ['finished'];
  if (!last || last.fingerprint !== fingerprint(r, loadApp(ctx, r.app)) || !tried.includes(last.outcome))
    ctx.fail(`Run it ${confirms ? 'to its confirmation screen' : 'to its end'} first, as it is now: bc android run ${i.name} --dry`);
  setApproved(ctx, i.name, r);
  const button = r.steps.at(-1).do === 'confirm' ? r.steps.at(-1).button : null;
  return `"${i.name}" is approved. The agent may run it${button ? `; it still asks you before it presses ${spoken(button)}` : ''}.`;
}

// Run a routine to its end, or to its confirmation screen and the owner's answer there.
export async function run(ctx, i) {
  const base = loadRoutine(ctx, i.name);
  const r = withParams(base, sets(i.set));
  const app = loadApp(ctx, r.app);
  const d = chosen(ctx, i.on, r);
  const dry = !!i.dry;
  const dev = await reach(ctx, d);
  const free = take(ctx, d, `the routine "${r.name}"`);
  // (A restart waits for it: cut off, it would leave the app at its screen and the owner's answer unheard.)
  const unhold = holdRestart(`${r.name} on the ${d.name}`);
  media();
  const log = (m) => {
    if (process.stderr.isTTY && !i.json) console.error(`  ${m}`);
  };
  const confirm = r.steps.at(-1);
  let unasked = null;
  // At the confirmation screen: the owner is asked, with what was read and a picture, and only
  // their answer presses the button. (Where they are: this terminal, or the channel in use.)
  const answer = async ({ values, shot, seconds }) => {
    if (dry) return 'declined';
    const facts = Object.entries(values).map(([k, v]) => `${k}: ${v ?? '(not found)'}`);
    const a = await ctx.askOwner({
      text: [
        `"${r.name}" is at its confirmation screen on the ${d.name}, ${seconds}s after it started.`,
        ...facts,
        `Press ${spoken(confirm.button)}?`,
      ].join('\n'),
      picture: shot,
      choices: ['✅ Press it', '✖ Cancel'],
      expiresIn: confirm.expires ?? 120,
    });
    if (a.how === 'unasked') unasked = a.why;
    return a.answer === '✅ Press it' ? 'confirm' : a.how === 'expired' ? 'timeout' : 'cancel';
  };
  let result;
  // The owner, when not at this terminal, follows it in one message, step by step, in each
  // step's own words (its `why`).
  const follow = atTerminal() ? null : await following(ctx, r, d, dry);
  // (A step that fails is looked at by a model, which may get past what is in the way: recover.js.)
  const runner = new Runner(dev, r, app, {
    answer: async (x) => {
      await follow?.at(dry ? 'at the confirmation screen' : 'at the confirmation screen: asking you');
      return answer(x);
    },
    log,
    media: MEDIA,
    recover: async (x) => (follow?.note(`step ${x.n} had trouble: looking at the screen`), diagnose(ctx, x)),
    onStep: (x) => follow?.start(x),
    onDone: (x) => follow?.end(x),
    // (A routine that does not yet say which screen comes last after the press: a model looks.)
    judge: confirm?.result?.shows ? null : (x) => judgeResult(ctx, { routine: r, button: spoken(confirm.button), imageBlock, ...x }),
    onWait: (secs) => follow?.waiting(`pressed: waiting for ${app.label ?? 'the app'} to finish${secs ? ` (${secs}s)` : ''}`),
  });
  try {
    result = await session(dev, r, () => runner.run(), { log, tv: d.tv });
  } catch (e) {
    if (e instanceof Stopped) result = { outcome: 'stopped', error: e.message, step: e.step, steps: runner.steps };
    else if (!(e instanceof StepFailed)) throw e;
    else result = { outcome: 'failed', error: e.message, step: e.step, shot: e.shot, steps: runner.steps };
  } finally {
    free();
    unhold();
  }
  if (result.outcome === 'cancelled' && dry) result.outcome = 'declined';
  if (result.outcome === 'cancelled' && unasked) result.outcome = 'unasked';
  await follow?.finish(
    {
      declined: '✓ Reached the confirmation screen (a dry run: nothing pressed)',
      confirmed: '✓ Pressed, on your word',
      cancelled: '✖ Cancelled: nothing pressed',
      expired: '⌛ No answer: nothing pressed',
      unasked: '✖ You could not be asked: nothing pressed',
      finished: '✓ Done',
      stopped: `■ Stopped: ${result.error}`,
      failed: `✖ Stopped at step ${result.step}`,
    }[result.outcome] ?? result.outcome,
  );
  // (`picture: false`: no picture of the screen after the press either.)
  const after = result.after ? { ...result.after, ...(base.picture === false ? { shot: null } : {}) } : null;
  if (after) await follow?.waited(`✓ ${app.label ?? 'The app'} after the press: ${after.seconds}s`);
  const afterLines = after ? await tellAfter(ctx, { base, d, confirm, after, send: !atTerminal() }) : [];
  const trouble = runner.recoveries;
  recordRun(ctx, base, { ...result, dry, device: d.name, recoveries: trouble });
  recordActivity({
    kind: 'event',
    category: 'android',
    summary: `routine ${r.name} on the ${d.name}: ${result.outcome}${result.step ? ` at step ${result.step}` : ''}`,
    ok: result.outcome !== 'failed',
  });
  const said = {
    declined: `Reached the confirmation screen in ${result.seconds}s and declined, as asked (--dry). Nothing was pressed.`,
    cancelled: 'Cancelled at the confirmation screen. Nothing was pressed.',
    unasked: `At the confirmation screen, but you could not be asked (${unasked}). Nothing was pressed.`,
    expired: 'No answer in time at the confirmation screen. Nothing was pressed.',
    confirmed: `Pressed, on your word, ${result.seconds}s after the start.`,
    finished: `Done in ${result.seconds}s.${result.shot ? `\nThe screen at the end: ${result.shot}` : result.noShot ? `\nNo picture of the screen at the end: ${result.noShot}` : ''}`,
    failed: `${result.error}\nThe screen when it stopped: ${result.shot ?? '(no picture)'}`,
    stopped: `Stopped at step ${result.step}, as the routine says: ${result.error}. Nothing was pressed.`,
  }[result.outcome];
  if (result.outcome === 'failed') process.exitCode = 1;
  const values = result.values ? Object.entries(result.values).map(([k, v]) => `${k}: ${v ?? '(not found)'}`) : [];
  const got = trouble.map(
    (t) =>
      `${t.did ? `Got past something at step ${t.n}` : `At step ${t.n}`}: ${t.summary}${t.did ? ` (${t.did})` : t.refused && t.refused !== 'nothing to do' ? ` (${t.refused})` : ''}`,
  );
  // (Run as a step of a shortcut that shows its own steps: the picture is handed to it, to go
  // after its last step rather than before.)
  const handOn = process.env.BLACKCAT_PROGRESS === 'off';
  const sentEnd = result.outcome === 'finished' && result.shot && !atTerminal() && !handOn;
  if (sentEnd) await ctx.notify(`${runTitle() ?? `${r.name} on the ${d.name}`} · ${whenTaken()}`, { picture: result.shot });
  // (Run by a shortcut, and the owner has been sent how it ended: the shortcut need not say it again.)
  const told = !!runTitle() && (sentEnd || (!!after && !atTerminal()));
  await tellAndKeep(ctx, { r, base, app, d, result, trouble, said });
  if (handOn && result.outcome === 'finished' && result.shot) handOff({ picture: result.shot });
  if (told) handOff({ told: true });
  return {
    text: [said, ...got, ...values, ...afterLines].join('\n'),
    data: {
      routine: r.name,
      device: d.name,
      outcome: result.outcome,
      values: result.values ?? null,
      seconds: result.seconds ?? null,
      step: result.step ?? null,
      path: result.shot ?? null,
      steps: result.steps,
      recoveries: trouble.map(({ shot, ...t }) => ({ ...t, path: shot })),
      after: after && { values: after.values, words: after.words, seconds: after.seconds, shown: after.shown, path: after.shot },
    },
  };
}

// After the press: the owner is sent the app's last screen and what was read on it (`send`;
// at this terminal it is printed). When a model found which screen that is, for a routine that
// did not say, they are asked whether to keep it. → the lines for the command's own answer.
export async function tellAfter(ctx, { base, d, confirm, after, send }) {
  const button = spoken(confirm.button);
  // (A value only some of its screens have, such as when the driver arrives, is left out when not there.)
  const facts = Object.entries(after.values).flatMap(([k, v]) => (v == null ? [] : [`${k}: ${v}`]));
  const lines = [
    !after.changed ? `The screen did not change after the press: ${button} may not have worked. Look at the app.` : null,
    after.shown === false ? `${spokenAny(confirm.result.shows)} did not show in ${after.seconds}s; this is the screen then.` : null,
    after.judged?.summary ?? null,
    ...(facts.length ? facts : after.words),
  ].filter(Boolean);
  if (send)
    await ctx.notify([`🤖 ${base.name} on the ${d.name}, ${after.seconds}s after ${button}:`, ...lines].join('\n'), {
      picture: after.shot ?? undefined,
    });
  const keep = after.judged?.final ? after.judged.result : null;
  if (keep) {
    const what = [`wait for ${spokenAny(keep.shows)}`, keep.read ? `read ${Object.keys(keep.read).join(', ')}` : null]
      .filter(Boolean)
      .join(', and ');
    const a = await ctx.askOwner({
      text: `Keep this as the screen after ${button} in "${base.name}", for next time: ${what}? It only looks, so the routine stays approved.`,
      picture: after.shot ?? undefined,
      choices: ['✅ Keep it', '✖ No'],
      expiresIn: 180,
    });
    if (a.answer === '✅ Keep it') saveRoutine(ctx, withResult(base, keep));
  }
  return [`After the press (${after.seconds}s):`, ...lines.map((l) => `  ${l}`), ...(after.shot ? [`  The screen: ${after.shot}`] : [])];
}

// The routine with its confirmation step's `result` (the screen after the press) as given.
export function withResult(routine, result) {
  const copy = structuredClone(routine);
  const last = copy.steps.at(-1);
  if (last?.do !== 'confirm') return copy;
  // (How long to wait, and a screen named as one it shows while still working, stay unless given again.)
  const kept = Object.fromEntries(['wait', 'waiting'].filter((k) => last.result?.[k]).map((k) => [k, last.result[k]]));
  last.result = { ...kept, ...result };
  return copy;
}

// The owner at this terminal sees it all as the run prints it; anywhere else they are sent the
// picture and what was found when a run had trouble, so they need not ask what happened.
// What a shortcut that started this run is for (its description), if one did.
export const runTitle = () => process.env.BLACKCAT_TITLE?.trim() || null;
export const whenTaken = () => new Date().toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
export const atTerminal = () => !!process.stdout.isTTY && process.env.BLACKCAT_CALLER !== 'agent' && !process.env.BLACKCAT_CHAT_ID;

// The message the owner follows a run in: what it is for, then each step in its own words,
// ticked as it is done. Long routines show their last steps.
export async function following(ctx, r, d, dry) {
  // (Started by a shortcut: by what the shortcut is for, in the owner's words. Else by its name
  // and the values given.)
  const title = runTitle();
  const head = [
    `🤖 ${title ?? `${r.name} on the ${d.name}`}${dry ? ' (a dry run)' : ''}`,
    title
      ? ''
      : Object.entries(r.values ?? {})
          .filter(([, v]) => v != null && v !== '')
          .map(([k, v]) => `${k}: ${v}`)
          .join(' · '),
  ].filter(Boolean);
  const p = await ctx.progress([...head, '⏳ starting the app'].join('\n'));
  if (!p) return null;
  let wait = null;
  const lines = [];
  const say = (s) =>
    s.why ?? `${s.do.replace('_', ' ')}${s.target ? ` ${spoken(s.target)}` : s.text ? ` "${s.text}"` : s.number ? ` ${s.number}` : ''}`;
  const show = () => [...head, ...lines.slice(-10)].join('\n');
  const set = (n, text) => {
    const at = lines.findIndex((l) => l.startsWith(`${n}·`) || l.includes(` ${n}. `));
    const line = `${text}`;
    if (at >= 0) lines[at] = line;
    else lines.push(line);
  };
  return {
    start: ({ n, step }) => {
      if (step.do === 'confirm') return;
      set(n, `⏳ ${n}. ${say(step)}`);
      p.update(show());
    },
    end: ({ n, step, skipped }) => {
      if (step.do === 'confirm') return;
      set(n, `${skipped ? '–' : '✓'} ${n}. ${say(step)}${skipped ? ' (not needed)' : ''}`);
      p.update(show());
    },
    note: (text) => {
      lines.push(`⚠️ ${text}`);
      p.update(show());
    },
    at: async (text) => {
      lines.push(`⏳ ${text}`);
      await p.done(show());
    },
    // (A message of its own: the one above was finished when the owner was asked.)
    waiting: async (text) => {
      wait ??= await ctx.progress(`⏳ ${text}`);
      wait?.update(`⏳ ${text}`);
    },
    waited: async (text) => wait?.done(text),
    finish: async (text) => {
      if (lines.at(-1)?.startsWith('⏳ at the confirmation screen')) lines.pop();
      lines.push(text);
      await p.done(show());
    },
  };
}

// After a run that had trouble: the owner is told, with the picture, and asked whether to keep
// each fix the model found for next time. A pop-up goes into the app's file (the routine stays
// approved); a step that names something else now makes the routine a draft again.
export async function tellAndKeep(ctx, { r, base, app, d, result, trouble, said }) {
  const failed = result.outcome === 'failed';
  // Each piece of trouble is on the activity record, whatever is sent: asked later what went
  // wrong on a run, the agent finds it there.
  for (const t of trouble)
    recordActivity({
      kind: 'event',
      category: 'android',
      ok: !!t.did,
      summary: `routine ${r.name} on the ${d.name}, step ${t.n}: ${t.summary}${t.did ? ` It ${t.did} and went on.` : t.refused ? ` Nothing done (${t.refused}).` : ''}`,
    });
  // Sent only when it matters to the owner: the run failed, or there is a fix to keep or not.
  // Trouble that was got past with nothing to decide is in the record, and in the steps' list.
  if (!atTerminal() && (failed || trouble.some((t) => t.fix))) {
    const last = trouble.at(-1);
    const what = [
      `🤖 "${r.name}" on the ${d.name}: ${failed ? `stopped at step ${result.step}.` : 'had trouble on the way, and got past it.'}`,
      ...trouble.map((t) => `Step ${t.n}: ${t.summary}${t.did ? ` I ${t.did} and went on.` : ''}`),
      failed && !trouble.length ? result.error : null,
      failed ? '' : null,
      failed ? said.split('\n')[0] : null,
    ]
      .filter((x) => x != null)
      .join('\n');
    await ctx.notify(what, { picture: result.shot ?? last?.shot });
  }
  for (const t of trouble) {
    if (!t.fix) continue;
    const question =
      t.fix.kind === 'popup'
        ? `Keep this for ${app.label ?? app.package}, for next time: ${t.fix.said}?`
        : `Change step ${t.n} of "${r.name}": ${t.fix.said}? It becomes a draft again, to be tried (--dry) and approved.`;
    const a = await ctx.askOwner({ text: question, picture: t.shot ?? undefined, choices: ['✅ Keep it', '✖ No'], expiresIn: 180 });
    if (a.answer !== '✅ Keep it') continue;
    if (t.fix.kind === 'popup') {
      const now = loadApp(ctx, app.package);
      saveApp(ctx, { ...now, popups: [...now.popups, t.fix.popup] });
    } else {
      const edited = withTarget(base, t.n, t.fix.target);
      if (edited) saveRoutine(ctx, edited);
    }
  }
}

// The routine with step `n` ("3", "6.1") looking for `target` instead. → null for a step it cannot reach.
export function withTarget(routine, n, target) {
  const copy = structuredClone(routine);
  let steps = copy.steps;
  const path = String(n).split('.').map(Number);
  for (const [k, i] of path.entries()) {
    const s = steps?.[i - 1];
    if (!s) return null;
    if (k === path.length - 1) {
      if (!('target' in s)) return null;
      s.target = target;
      return copy;
    }
    steps = s.then;
  }
  return null;
}

// For a shortcut or a check: succeed only once the device is as said (an app in front, the
// screen on or off), looking again each second for up to `--wait` seconds.
export const MAX_WAIT_S = 120;
export async function check(ctx, i) {
  const d = chosen(ctx, i.on);
  const screen = i.screen == null ? null : String(i.screen).toLowerCase();
  if (screen != null && screen !== 'on' && screen !== 'off') ctx.fail('--screen is on or off.');
  if (!i.app && screen == null) ctx.fail('Say what to check: --app <app> (a word of its package), --screen on|off.');
  const wait = i.wait == null ? 0 : Number(i.wait);
  if (!Number.isInteger(wait) || wait < 0 || wait > MAX_WAIT_S) ctx.fail(`--wait is a whole number of seconds, 0 to ${MAX_WAIT_S}.`);
  const dev = await reach(ctx, d);
  const pkg = i.app ? await appPackage(ctx, dev, i.app) : null;
  const t0 = Date.now();
  for (;;) {
    const awake = (await dev.wakefulness()) === 'Awake';
    const front = pkg ? await dev.foreground() : null;
    const wrong = [
      screen && (screen === 'on') !== awake ? `its screen is ${awake ? 'on' : 'off'}` : null,
      pkg && front !== pkg ? `${front ?? 'nothing'} is in front, not ${pkg}` : null,
    ].filter(Boolean);
    const took = Math.round((Date.now() - t0) / 1000);
    if (!wrong.length)
      return {
        text: `The ${d.name}: ${[screen ? `its screen is ${screen}` : null, pkg ? `${pkg} is in front` : null].filter(Boolean).join(', ')}${took ? ` (after ${took}s)` : ''}.`,
        data: { device: d.name, ok: true, awake, front, seconds: took },
      };
    if (Date.now() - t0 >= wait * 1000) return ctx.fail(`The ${d.name}: ${wrong.join(', ')}${wait ? `, after ${took}s` : ''}.`);
    await sleep(1000);
  }
}
