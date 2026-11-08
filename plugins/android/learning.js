// Learning a routine on the device from a goal or pictures, and changing one in words.
// (Split out of plugin.js.)
import { recordActivity } from '../../src/api.js';
import { PACKAGE } from './device.js';
import { commits, loadApp, loadRoutine, NAME, saveApp, saveRoutine, setApproved, stateOf, validate, withParams } from './routines.js';
import { changes, planEdit, spliced } from './edit.js';
import { diagnose } from './recover.js';
import { Learner, PATTERNS, think } from './learn.js';
import { resultFromPicture, study, takePictures } from './pictures.js';
import { Runner, session, StepFailed } from './runner.js';
import { spoken, spokenAny } from './screen.js';
import { media, chosen, reach, MEDIA } from './shared.js';

import { take, run, withResult, sets, atTerminal } from './running.js';

// ---------- learning ----------

// The app a word names: its package, or the one installed package that has the word in it.
export async function appPackage(ctx, dev, word) {
  if (!word) ctx.fail('Say which app: --app and a word of its name, or its package (com.example.app).');
  if (PACKAGE.test(word) && (await dev.installed(word))) return word;
  const all = (await dev.shell('pm list packages')).split('\n').map((l) => l.replace(/^package:/, '').trim());
  const found = all.filter((p) => p.toLowerCase().includes(String(word).toLowerCase()));
  if (found.length === 1) return found[0];
  if (!found.length)
    ctx.fail(`No app on the device has "${word}" in its name. Its package names: bc android adb <device> shell 'pm list packages -3'`);
  return ctx.fail(`Several apps have "${word}" in their names: ${found.slice(0, 8).join(', ')}. Give its package with --app.`);
}

// The owner's pictures of the app (--picture), looked at once by a model. → what they show
// ({ notes, after_confirm }), or null when none were given.
export async function looked(ctx, files, { goal, app, routine = null, log }) {
  if (!files?.length) return null;
  let pictures;
  try {
    pictures = await takePictures(files, MEDIA);
  } catch (e) {
    ctx.fail(e.message);
  }
  const seen = await study(ctx, { pictures, goal, app, routine });
  if (seen) log(`the pictures: ${seen.notes}`);
  return seen;
}

// Learn a routine from words, try it again by itself, and ask the owner to approve it.
export async function learnCmd(ctx, i) {
  if (!NAME.test(i.name ?? '')) ctx.fail('A routine is named in lowercase letters, digits and dashes: bc android learn shop-order …');
  if (!i.goal?.trim()) ctx.fail('Say what to do, and where to stop, in words: --goal "…"');
  const values = sets(i.set);
  for (const k of Object.keys(values))
    if (!/^[a-z][a-zA-Z0-9]*$/.test(k)) ctx.fail(`"${k}": a value's name is one word, like item or deliveryDay`);
  const d = chosen(ctx, i.on);
  const dev = await reach(ctx, d);
  const pkg = await appPackage(ctx, dev, i.app);
  const app = loadApp(ctx, pkg);
  // The button the owner said to stop at: never tapped while learning, and the only one the
  // confirmation screen may be found by.
  const stopAt = i.stopAt?.trim() || null;
  if (stopAt && !commits(app, { text: stopAt })) app.commit = [...app.commit, stopAt];
  media();
  const log = (m) => !i.json && console.error(`  ${m}`);
  const seen = await looked(ctx, i.picture, { goal: i.goal, app, log });
  // Watched step by step: each step is shown, with the screen, and done only on the owner's word.
  const confirmEach = i.step
    ? async (what, shot) =>
        (
          await ctx.askOwner({
            text: `Learning "${i.name}". Next: ${what}`,
            picture: shot ?? undefined,
            choices: ['▶ Go on', '✋ Stop'],
            expiresIn: 300,
          })
        ).answer === '▶ Go on'
    : null;
  const learner = new Learner(dev, {
    app,
    goal: i.goal,
    values,
    stopAt,
    think: (x) => think(ctx, x),
    confirmEach,
    log,
    media: MEDIA,
    told: seen?.notes,
  });
  const free = take(ctx, d, `learning "${i.name}"`);
  let got;
  try {
    got = await session(dev, { app: pkg, name: i.name, after: d.tv ? 'stay' : 'sleep' }, () => learner.run(), { log, tv: d.tv });
  } finally {
    free();
  }
  recordActivity({
    kind: 'event',
    category: 'android',
    summary: `learning ${i.name}: ${got.ended} after ${learner.actions} actions`,
    ok: ['confirm', 'done'].includes(got.ended),
  });
  const so = learner.steps.map((x, k) => `  ${k + 1}. ${x.do} ${JSON.stringify(x.target ?? x.text ?? x.key ?? x.until)}`);
  if (!['confirm', 'done'].includes(got.ended)) {
    const why = {
      'no-model': 'no model could be asked (bc engine status)',
      stuck: `it could not see a way: ${got.why}`,
      stopped: 'you stopped it',
      budget: `it had not got there after ${learner.actions} steps`,
    }[got.ended];
    process.exitCode = 1;
    if (!atTerminal()) await ctx.notify(`🤖 Learning "${i.name}" stopped: ${why}. Nothing was saved.`, { picture: got.shot ?? undefined });
    return {
      text: [`Not learned: ${why}. Nothing was saved.`, ...(so.length ? ['The steps that had worked:', ...so] : [])].join('\n'),
      data: { ended: got.ended, steps: learner.steps },
    };
  }
  // The button that commits: the owner says whether the model has it right, and it joins the app's.
  const now = loadApp(ctx, pkg);
  if (stopAt && !commits(now, { text: stopAt })) now.commit = [...now.commit, stopAt];
  if (got.ended === 'confirm' && !commits(now, { text: got.label })) {
    const a = await ctx.askOwner({
      text: `Learning "${i.name}": it stopped at the screen in the picture, before "${got.label}". Is "${got.label}" the button that books, buys, pays or sends? It is never pressed without your word.`,
      picture: got.shot ?? undefined,
      choices: ['✅ Yes, that is it', '✖ No'],
      expiresIn: 300,
    });
    if (a.answer !== '✅ Yes, that is it')
      return {
        text: `Not saved: ${a.answer ? 'that was not the screen that commits' : 'no answer about the button'}. Try again with a clearer --goal.`,
        data: { ended: 'not-confirmed', steps: learner.steps },
      };
    now.commit = [...now.commit, got.label];
  }
  saveApp(ctx, {
    ...now,
    popups: [...now.popups, ...learner.popups.filter((p) => !now.popups.some((q) => JSON.stringify(q.when) === JSON.stringify(p.when)))],
  });
  // (The screen after the press, from the owner's pictures: learning never gets there.)
  const after = seen?.after_confirm ? resultFromPicture(seen.after_confirm, PATTERNS) : null;
  const steps = got.ended === 'confirm' ? [...learner.steps, { ...got.confirm, ...(after ? { result: after } : {}) }] : learner.steps;
  const used = Object.keys(values).filter((k) => JSON.stringify(steps).includes(`{{${k}}}`));
  const routine = {
    name: i.name,
    app: pkg,
    goal: i.goal,
    ...(used.length ? { params: Object.fromEntries(used.map((k) => [k, { summary: `${k}, such as "${values[k]}"` }])) } : {}),
    ...(i.on ? { device: d.name } : {}),
    steps,
  };
  const problems = validate(routine, loadApp(ctx, pkg));
  if (problems.length)
    return {
      text: `Learned, but not saved: it has mistakes:\n- ${problems.join('\n- ')}\n${JSON.stringify(routine, null, 2)}`,
      data: { ended: 'mistakes', routine },
    };
  saveRoutine(ctx, routine);
  // Gone through again by itself, with no model, to the confirmation screen.
  const offered = await tryAndOffer(ctx, {
    routine,
    on: d.name,
    values,
    what: `Learned "${i.name}" in ${steps.length} steps.`,
    label: got.label ? `"${got.label}"` : null,
  });
  return {
    text: [
      `Learned "${i.name}" (${pkg}) in ${steps.length} steps, from ${learner.actions} tries${used.length ? `; it takes ${used.join(', ')}` : ''}.`,
      ...steps.map((x, k) => `  ${k + 1}. ${x.do} ${JSON.stringify(x.target ?? x.button ?? x.text ?? x.key ?? x.until)}`),
      learner.popups.length ? `Pop-ups kept for the app: ${learner.popups.map((p) => JSON.stringify(p.when)).join(', ')}` : null,
      after ? `After "${got.label}" it waits for ${spokenAny(after.shows)} (from your pictures), and sends you that screen.` : null,
      offered.text,
    ]
      .filter(Boolean)
      .join('\n'),
    data: { ended: got.ended, routine, tried: offered.tried, approved: offered.approved },
  };
}

// A routine changed in words (and pictures): made in its steps, or learned in the app from
// where the change goes, or (the screen after the press) from a picture; then tried again by
// itself and offered to the owner to approve. When the try fails, it is put back as it was.
export async function editCmd(ctx, i) {
  if (!i.change?.trim()) ctx.fail('Say what to change, in words: --change "…"');
  const r = loadRoutine(ctx, i.name);
  const app = loadApp(ctx, r.app);
  media();
  const log = (m) => !i.json && console.error(`  ${m}`);
  const seen = await looked(ctx, i.picture, { goal: i.change, app, routine: r, log });
  const plan = await planEdit(ctx, { routine: r, app, change: i.change, told: seen?.notes, picture: !!seen?.after_confirm });
  if (!plan) ctx.fail('No model could be asked how to make the change (bc engine status).');
  log(`the change: ${plan.how}: ${plan.summary}`);
  if (plan.how === 'unclear')
    return { text: `Not changed. ${plan.question ?? plan.summary}`, data: { how: 'unclear', question: plan.question } };
  const confirm = r.steps.at(-1)?.do === 'confirm' ? r.steps.at(-1) : null;
  // (The screen after the press, when a picture is of it: kept whatever else the change is.)
  const after = confirm && seen?.after_confirm ? resultFromPicture(seen.after_confirm, PATTERNS) : null;
  const afterSaid = after
    ? `After ${spoken(confirm.button)} it ${[`waits for ${spokenAny(after.shows)}${after.waiting ? ` (past ${spokenAny(after.waiting)})` : ''}`, after.read ? `reads ${Object.keys(after.read).join(', ')}` : null].filter(Boolean).join(' and ')}, and sends you that screen.`
    : null;
  if (plan.how === 'after_confirm') {
    if (!confirm || !after)
      ctx.fail(
        confirm
          ? 'Send a picture of the screen after the press (--picture), or confirm one for real: it then asks whether to keep that screen.'
          : `"${r.name}" presses nothing for you to confirm, so there is no screen after a press.`,
      );
    saveRoutine(ctx, withResult(r, after));
    return {
      text: `Changed "${r.name}". ${afterSaid} It only looks, so the routine stays ${stateOf(ctx, r.name, r)}. (It is first seen on the device the next time you confirm one.)`,
      data: { how: plan.how, result: after },
    };
  }
  const values = sets(i.set);
  let steps;
  let params = r.params;
  let popups = [];
  if (plan.how === 'steps') {
    try {
      steps = JSON.parse(plan.steps ?? '');
      if (plan.params) params = JSON.parse(plan.params);
    } catch {
      ctx.fail(`The change could not be made: ${plan.summary}`);
    }
  } else {
    // In the app: gone through up to where the new steps go, and they are learned from there.
    const last = confirm ? r.steps.length - 1 : r.steps.length;
    const at = Math.min(plan.at ?? last, last);
    const replace = Math.min(plan.replace ?? 0, last - at);
    const d = chosen(ctx, i.on, r);
    // (A value that is new with the change is typed while learning, and becomes one of the routine's.)
    const filled = withParams(r, Object.fromEntries(Object.entries(values).filter(([k]) => r.params?.[k])));
    const dev = await reach(ctx, d);
    const runner = new Runner(dev, { ...filled, steps: filled.steps.slice(0, at) }, app, {
      answer: async () => 'cancel',
      log,
      media: MEDIA,
      recover: (x) => diagnose(ctx, x),
    });
    const learner = new Learner(dev, {
      app,
      goal: plan.goal ?? i.change,
      values: Object.fromEntries(Object.entries({ ...filled.values, ...values }).filter(([, v]) => v)),
      think: (x) => think(ctx, x),
      log,
      media: MEDIA,
      told: seen?.notes,
      goingOn: { before: r.steps.slice(0, at), next: r.steps[at + replace] ?? null },
    });
    const free = take(ctx, d, `changing "${r.name}"`);
    let got;
    try {
      got = await session(
        dev,
        { app: r.app, name: r.name, after: d.tv ? 'stay' : 'sleep' },
        async () => (await runner.run(), learner.run()),
        {
          log,
          tv: d.tv,
        },
      );
    } catch (e) {
      if (!(e instanceof StepFailed)) throw e;
      ctx.fail(`Not changed: going through "${r.name}" up to the change, ${e.message}`);
    } finally {
      free();
    }
    if (got.ended !== 'done')
      return {
        text: `Not changed: the new steps were not learned (${got.ended}${got.why ? `: ${got.why}` : ''}). "${r.name}" is as it was.`,
        data: { how: plan.how, ended: got.ended, steps: learner.steps },
      };
    steps = spliced(r.steps, at, replace, learner.steps);
    popups = learner.popups;
    const added = Object.keys(values).filter((k) => !params?.[k] && JSON.stringify(steps).includes(`{{${k}}}`));
    if (added.length) params = { ...params, ...Object.fromEntries(added.map((k) => [k, { summary: `${k}, such as "${values[k]}"` }])) };
  }
  const edited = { ...r, ...(params ? { params } : {}), steps };
  const changed = after ? withResult(edited, after) : edited;
  const problems = validate(changed, app);
  if (problems.length)
    ctx.fail(`Not changed: the routine would have mistakes:
- ${problems.join('\n- ')}`);
  try {
    withParams(changed, values); // (it is tried again with these)
  } catch (e) {
    ctx.fail(`Not changed: to try it again after the change, ${e.message}`);
  }
  const lines = changes(r.steps, steps).concat(afterSaid ? [`+ ${afterSaid}`] : []);
  if (!lines.length && JSON.stringify(params) === JSON.stringify(r.params)) return `Nothing to change in "${r.name}": ${plan.summary}`;
  if (popups.length)
    saveApp(ctx, {
      ...app,
      popups: [...app.popups, ...popups.filter((p) => !app.popups.some((q) => JSON.stringify(q.when) === JSON.stringify(p.when)))],
    });
  saveRoutine(ctx, changed);
  const offered = await tryAndOffer(ctx, {
    routine: changed,
    on: i.on,
    values,
    what: `Changed "${r.name}": ${plan.summary}\n${lines.join('\n')}`,
    back: r,
  });
  return {
    text: [`${plan.summary}`, ...lines.map((l) => `  ${l}`), offered.text].join('\n'),
    data: { how: plan.how, routine: offered.kept ? changed : r, tried: offered.tried, approved: offered.approved, kept: offered.kept },
  };
}

// A routine saved as a draft is gone through again by itself (--dry) and offered to the owner
// to approve. `back`: the routine as it was before a change, put back when the try fails or the
// owner says so. → { text, tried, approved, kept }
export async function tryAndOffer(ctx, { routine, on, values, what, back = null, label = null }) {
  const used = Object.keys(routine.params ?? {}).filter((k) => values[k] != null && values[k] !== '');
  const tried = await run(ctx, { name: routine.name, set: used.map((k) => `${k}=${values[k]}`), dry: true, on, json: true }).catch((e) => ({
    text: e.message,
    data: { outcome: 'failed' },
  }));
  const ok = ['declined', 'finished'].includes(tried.data.outcome);
  const putBack = () => back && (saveRoutine(ctx, back), true);
  if (!ok) {
    const restored = putBack();
    return {
      text: `Tried again by itself, it did not get there: ${tried.text.split('\n')[0]}${restored ? `\n"${routine.name}" is put back as it was.` : `\nIt needs fixing before it can be approved: bc android show ${routine.name} --json`}`,
      tried: tried.data.outcome,
      approved: false,
      kept: !restored,
    };
  }
  const press = label ?? (routine.steps.at(-1).do === 'confirm' ? spoken(routine.steps.at(-1).button) : null);
  const a = await ctx.askOwner({
    text: `${what}\nTried again by itself: ${tried.text.split('\n')[0]}${used.length ? ` It takes: ${used.join(', ')}.` : ''}\nDid it do what you meant? Approving it lets the agent run it${press ? `; it still asks you before ${press}` : ''}.`,
    picture: tried.data.path ?? undefined,
    choices: back ? ['✅ Approve it', '📝 Keep as a draft', '↩ Put it back'] : ['✅ Approve it', '✖ Not yet'],
    expiresIn: 300,
  });
  if (a.answer === '✅ Approve it') {
    setApproved(ctx, routine.name, loadRoutine(ctx, routine.name));
    return {
      text: `Tried again by itself: ${tried.text.split('\n')[0]}\nApproved: the agent may run it.`,
      tried: tried.data.outcome,
      approved: true,
      kept: true,
    };
  }
  if (a.answer === '↩ Put it back' && putBack())
    return { text: `"${routine.name}" is put back as it was.`, tried: tried.data.outcome, approved: false, kept: false };
  return {
    text: `Tried again by itself: ${tried.text.split('\n')[0]}\nNot approved yet: bc android approve ${routine.name}`,
    tried: tried.data.outcome,
    approved: false,
    kept: true,
  };
}
