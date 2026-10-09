// Shortcuts: commands you define yourself. A shortcut is a short recipe (run these
// commands, then send back this file or what they printed) stored as data and run with no
// AI involved: `/door` in the bot, `bc shortcut run door` in a terminal. Any command can be a
// step, including blackcat's own, so a shortcut can use SSH, UniFi or any other plugin.
import fs from 'node:fs';
import path from 'node:path';
import { dataPath, expandHome, shell } from '../../src/api.js';

// Each shortcut gets a folder of its own for files it fetches: {dir} in a step or a path.
const FILES = dataPath('shortcut-files');
const NAME = /^[a-z][a-z0-9_]{1,24}$/;
const STEP_TIMEOUT_MS = 3 * 60_000;
const MANY = { many: true };

const all = (ctx) => ctx.config.get().shortcuts ?? {};
const dirOf = (name) => path.join(FILES, name);
const fill = (s, name) => expandHome(String(s).replaceAll('{dir}', dirOf(name)));
const sh = (cmd) => shell(cmd, { timeoutMs: STEP_TIMEOUT_MS, keep: 3500 });

// A shortcut may have actions: words of its own after its name, each with steps of its own
// (/waves pause, /waves stop). One with actions and no steps of its own is a menu: /waves
// shows what it has. An action is kept in the same shape as a shortcut's own steps.
const ACTION = /^[a-z][a-z0-9_]{0,24}$/;
const actionsOf = (sc) => sc.actions ?? {};
const hasOwn = (sc) => !!((sc.run ?? []).length || (sc.send ?? []).length);
const menuOf = (name, sc) => Object.keys(actionsOf(sc)).map((a) => `/${name} ${a}`);
// Everything that can be sent by itself: a shortcut's own steps, and each of its actions.
// → [{ label: 'waves play', name, action | null, part, description }]
const everyPart = (shortcuts) =>
  Object.entries(shortcuts).flatMap(([name, sc]) => [
    { label: name, name, action: null, part: sc, description: sc.description },
    ...Object.entries(actionsOf(sc)).map(([action, part]) => ({
      label: `${name} ${action}`,
      name,
      action,
      part,
      description: part.description ?? `${sc.description}: ${action}`,
    })),
  ]);
// The same shortcuts with one of those changed.
const withPart = (shortcuts, t, part) =>
  t.action
    ? { ...shortcuts, [t.name]: { ...shortcuts[t.name], actions: { ...actionsOf(shortcuts[t.name]), [t.action]: part } } }
    : { ...shortcuts, [t.name]: part };
// What was typed after its name → what to do: { run: steps } | { menu: true } | { unknown: word }
function choose(sc, word) {
  if (word == null || word === '') return hasOwn(sc) ? { run: sc } : { menu: true };
  const a = actionsOf(sc)[word];
  return a ? { run: a, action: word } : { unknown: word };
}

// Names the bot already uses can't be taken by a shortcut.
async function taken() {
  const { chatCommands, directCommands } = await import('../../src/api.js');
  return new Set([...chatCommands({ own: false }), ...directCommands()].map((c) => c.command).concat(['start', 'cancel', 'bc']));
}

// Carry a shortcut out. → { ok, text, files: [paths], failed? }
export async function runShortcut(name, sc) {
  fs.mkdirSync(dirOf(name), { recursive: true, mode: 0o700 });
  let last = '';
  for (const step of sc.run ?? []) {
    const r = await sh(fill(step, name).replaceAll(dirOf(name), `'${dirOf(name)}'`));
    if (r.code !== 0)
      return {
        ok: false,
        files: [],
        text: `"${step}" ${r.timedOut ? 'took too long' : `failed (exit ${r.code})`}${r.out ? `:\n${r.out.split('\n').slice(-6).join('\n')}` : ''}`,
      };
    last = r.out;
  }
  const files = [];
  for (const f of sc.send ?? []) {
    const file = fill(f, name);
    if (!fs.existsSync(file)) return { ok: false, files, text: `There is no file at ${f}.` };
    files.push(file);
  }
  const text = sc.reply === 'none' || (files.length && !sc.reply) ? '' : last;
  return { ok: true, files, text, caption: sc.caption ?? null };
}

const LATE_S = 3 * 3600; // a time missed by more than this (blackcat was off) is skipped, not sent late

// "--at 08:00 --days mon,fri" or "--cron '0 8 * * 1,5'" → { cron: ['0 8 * * 1,5'], since }, or a message saying what is wrong.
async function schedule(ctx, at, days, cron = []) {
  const { fromTimes, schedule: check } = await import('../../src/api.js');
  try {
    // `since`: times before the schedule was set are never caught up on.
    return {
      cron: cron.length
        ? check(cron)
        : check(
            fromTimes(
              at
                .flatMap((t) => String(t).split(','))
                .map((t) => t.trim())
                .filter(Boolean),
              days ?? 'daily',
            ),
          ),
      since: Math.floor(Date.now() / 1000),
    };
  } catch (e) {
    return ctx.fail(e.message);
  }
}
// A shortcut's repeating schedule as cron, or null. (`at` and `days` are how it was kept before schedules were cron.)
const cronOf = (sc) => (sc.cron?.length ? sc.cron : null);
// One-off times: "2026-10-09 21:00", "21:00" (the next time it comes round), or in: "2h".
async function onceTimes(ctx, once, inn) {
  const { parseAt, parseDuration } = await import('../../src/api.js');
  const now = Math.floor(Date.now() / 1000);
  try {
    const out = [...once.map((t) => parseAt(t)), ...(inn ? [now + parseDuration(inn)] : [])];
    const past = out.find((t) => t <= now);
    if (past) ctx.fail('That time has already passed.');
    return out;
  } catch (e) {
    return ctx.fail(e.message);
  }
}
const whenText = async (sc) => {
  const api = await import('../../src/api.js');
  const cron = cronOf(sc);
  const parts = [
    cron ? api.describeSchedule(cron).replace(/^./, (c) => c.toLowerCase()) : null,
    ...(sc.once ?? [])
      .filter((t) => t > Date.now() / 1000 - LATE_S)
      .sort()
      .map((t) => `once, ${api.fmtWhen(t)}`),
  ].filter(Boolean);
  return parts.length ? parts.join('; ') : null;
};

const steps = (part, pad = '  ') =>
  [
    ...(part.run ?? []).map((s, i) => `${pad}${i + 1}. run: ${s}`),
    ...(part.send ?? []).map((f) => `${pad}then send: ${f}`),
    (part.run ?? []).length && (!(part.send ?? []).length || part.reply === 'output') && part.reply !== 'none'
      ? `${pad}then reply with what the last command printed`
      : null,
  ].filter(Boolean);
const describe = (name, sc, when, whens) =>
  [
    `/${name}: ${sc.description}`,
    ...(hasOwn(sc) ? steps(sc) : ['  (no steps of its own: it shows its actions)']),
    ...Object.entries(actionsOf(sc)).flatMap(([a, part]) => [
      `  /${name} ${a}${part.description ? `: ${part.description}` : ''}`,
      ...steps(part, '    '),
      whens?.[a] ? `    sent to you by itself: ${whens[a]}` : null,
    ]),
    when ? `  sent to you by itself: ${when}` : null,
  ]
    .filter(Boolean)
    .join('\n');

// A recipe runs commands by itself whenever its name is typed, so the agent may only
// create or change one with the owner's approval, which shows it in full.
const recipe = {
  level: 'ask',
  describe: 'create or change a shortcut: a command you can then run with one tap, which runs these steps as you',
};

export default {
  api: 1,
  name: 'shortcut',
  default: true,
  title: 'Shortcuts',
  description: 'commands you define yourself: a recipe of steps run with one tap, with no AI involved',
  help: `Examples:
  bc shortcut add door --description "Front door camera" \\
      --run "blackcat unifi snapshot 'Front Door'" --send ~/blackcat/data/unifi-media/Front_Door.jpg
  bc shortcut add plot --description "Today's power plot" \\
      --run "blackcat ssh get nas '/srv/plots/today.png' {dir}/plot.png" --send {dir}/plot.png
  bc shortcut add uptime --description "How long Unraid has been up" --run "blackcat ssh run unraid uptime"
  bc shortcut run door

{dir} is a private folder for that shortcut's files. Steps run in order and stop at the
first that fails. In the bot, a shortcut is /<its name>.`,

  commands: {
    add: {
      summary: 'create a shortcut, or replace one of the same name',
      access: () => recipe,
      usage: '<name>',
      options: [
        ['--description <text>', "what it does, shown in the bot's menu"],
        ['--run <command>', 'a command to run (repeatable, in order)', [], MANY],
        ['--send <file>', 'a file to send back afterwards (repeatable)', [], MANY],
        ['--caption <text>', 'a caption for the file'],
        ['--at <HH:MM>', 'also send it to you by itself at this time (repeatable)', [], MANY],
        ['--cron <expr>', 'the same, as cron: "0 19 * * 6,0" (repeatable)', [], MANY],
        ['--days <list>', 'with --at: only on these days (mon,tue… weekdays, weekends)'],
        ['--reply <what>', 'output: also reply with what the last command printed; none: say nothing'],
        ['--no-test', "don't try it once now"],
      ],
      run: async (ctx, i) => {
        if (!NAME.test(i.name))
          ctx.fail("A shortcut's name is 2 to 25 lowercase letters, digits or underscores, starting with a letter: sky, front_door.");
        if ((await taken()).has(i.name)) ctx.fail(`/${i.name} is already a blackcat command. Choose another name.`);
        if (!i.run.length && !i.send.length) ctx.fail('A shortcut needs something to do: --run "<command>", --send <file>, or both.');
        if (i.reply && !['output', 'none'].includes(i.reply)) ctx.fail('--reply is output or none.');
        if (i.days && !i.at.length) ctx.fail('--days goes with --at.');
        const when = i.at.length || i.cron.length ? await schedule(ctx, i.at, i.days, i.cron) : {};
        const sc = {
          ...(all(ctx)[i.name]?.actions ? { actions: all(ctx)[i.name].actions } : {}),
          description: i.description ?? all(ctx)[i.name]?.description ?? `Run ${i.name}`,
          ...(i.run.length ? { run: i.run } : {}),
          ...(i.send.length ? { send: i.send } : {}),
          ...(i.caption ? { caption: i.caption } : {}),
          ...(i.reply ? { reply: i.reply } : {}),
          ...when,
        };
        // Files it sends must be somewhere the bot is allowed to send from.
        const { sendable } = await import('../../src/api.js');
        let tested = null;
        if (i.test !== false) {
          tested = await runShortcut(i.name, sc);
          const outside = tested.ok ? tested.files.find((f) => !sendable(f)) : null;
          if (outside)
            tested = {
              ok: false,
              files: [],
              text: `${outside} is outside the folders files may be sent from. Fetch it into {dir} with a step, or add its folder to agent.readDirs.`,
            };
        }
        ctx.config.set({ shortcuts: { ...all(ctx), [i.name]: sc } });
        await (await import('../../src/api.js')).refreshMenu();
        const result = !tested
          ? 'Not tested.'
          : tested.ok
            ? `Tested now: it works${tested.files.length ? ` (${tested.files.map((f) => path.basename(f)).join(', ')})` : tested.text ? `:\n${tested.text.split('\n').slice(0, 6).join('\n')}` : ''}.`
            : `Tested now: it FAILED. ${tested.text}\nIt is saved; correct it by adding it again.`;
        return {
          text: `Saved.\n${describe(i.name, sc, await whenText(sc))}\n\n${result}\nUse it: /${i.name} in the bot, or bc shortcut run ${i.name}`,
          data: { name: i.name, shortcut: sc, tested: tested ? { ok: tested.ok, detail: tested.text } : null },
        };
      },
    },

    list: {
      summary: 'your shortcuts',
      access: 'allow',
      untrusted: false,
      run: async (ctx) => {
        const s = all(ctx);
        const parts = [];
        for (const [n, sc] of Object.entries(s)) {
          const whens = {};
          for (const [a, part] of Object.entries(actionsOf(sc))) whens[a] = await whenText(part);
          parts.push(describe(n, sc, await whenText(sc), whens));
        }
        return {
          text: parts.length ? parts.join('\n\n') : 'No shortcuts yet. Create one with `bc shortcut add`, or ask me to build one.',
          data: { shortcuts: s },
        };
      },
    },

    run: {
      summary: 'run a shortcut, or one of its actions',
      // Its steps were approved when it was made, and it does only those.
      access: 'allow',
      usage: '<name> [action]',
      run: async (ctx, i) => {
        const sc = all(ctx)[i.name];
        if (!sc) ctx.fail(`There is no shortcut called "${i.name}". See: bc shortcut list`);
        const what = choose(sc, i.action);
        const has = menuOf(i.name, sc);
        if (what.unknown)
          ctx.fail(
            has.length ? `/${i.name} has no "${what.unknown}". It has: ${has.join(', ')}` : `/${i.name} takes nothing after its name.`,
          );
        if (what.menu)
          return {
            text: `/${i.name}: ${sc.description}\nIt has: ${has.join(', ')}`,
            data: { output: '', files: [], caption: null, actions: Object.keys(actionsOf(sc)) },
          };
        const r = await runShortcut(i.name, what.run);
        if (!r.ok) ctx.fail(r.text);
        return {
          text: [r.text, ...r.files.map((f) => `file: ${f}`)].filter(Boolean).join('\n') || 'Done.',
          data: { output: r.text, files: r.files, caption: r.caption },
        };
      },
    },

    action: {
      summary: 'give a shortcut an action: a word after its name with steps of its own (/waves pause), or take one away',
      access: () => recipe,
      usage: '<name> <action>',
      options: [
        ['--run <command>', 'a command to run (repeatable, in order)', [], MANY],
        ['--send <file>', 'a file to send back afterwards (repeatable)', [], MANY],
        ['--caption <text>', 'a caption for the file'],
        ['--reply <how>', 'output: also reply with what the last command printed; none: say nothing'],
        ['--description <text>', 'what this action does (and, for a new shortcut, what the shortcut is)'],
        ['--main', "make the shortcut's own steps this action instead, leaving the shortcut as a menu of its actions"],
        ['--remove', 'take this action away'],
        ['--no-test', "don't try it now"],
      ],
      run: async (ctx, i) => {
        if (!NAME.test(i.name))
          ctx.fail("A shortcut's name is 2 to 25 lowercase letters, digits or underscores, starting with a letter: sky, front_door.");
        if (!ACTION.test(i.action))
          ctx.fail('An action is one word: lowercase letters, digits or underscores, starting with a letter: pause, stop, volume_up.');
        const was = all(ctx)[i.name];
        if (!was && (await taken()).has(i.name)) ctx.fail(`/${i.name} is already a blackcat command. Choose another name.`);
        const { refreshMenu, sendable } = await import('../../src/api.js');
        const keep = async (sc, text, data) => {
          ctx.config.set({ shortcuts: { ...all(ctx), [i.name]: sc } });
          await refreshMenu();
          return {
            text: `${text}\n${describe(i.name, sc, await whenText(sc))}`,
            data: { name: i.name, action: i.action, shortcut: sc, ...data },
          };
        };
        if (i.remove) {
          if (!was?.actions?.[i.action]) ctx.fail(`/${i.name} has no "${i.action}".`);
          const { [i.action]: _gone, ...left } = was.actions;
          const { actions: _a, ...rest } = was;
          const sc = { ...rest, ...(Object.keys(left).length ? { actions: left } : {}) };
          if (!hasOwn(sc) && !Object.keys(left).length)
            ctx.fail(`That would leave /${i.name} with nothing to do. Remove the shortcut itself: bc shortcut remove ${i.name}`);
          return keep(sc, `Removed /${i.name} ${i.action}.`);
        }
        if (i.main) {
          if (i.run.length || i.send.length) ctx.fail("--main takes the shortcut's own steps: give no --run or --send with it.");
          if (!was || !hasOwn(was)) ctx.fail(`/${i.name} has no steps of its own to make into an action.`);
          // (When they are sent by themselves goes with the steps.)
          const { run, send, caption, reply, actions, cron, since, once, ...rest } = was;
          const part = {
            ...(run ? { run } : {}),
            ...(send ? { send } : {}),
            ...(caption ? { caption } : {}),
            ...(reply ? { reply } : {}),
            ...(i.description ? { description: i.description } : {}),
            ...(cron ? { cron, since } : {}),
            ...(once?.length ? { once } : {}),
          };
          return keep(
            { ...rest, actions: { ...actions, [i.action]: part } },
            `/${i.name} is now a menu, and its steps are /${i.name} ${i.action}.`,
          );
        }
        if (!i.run.length && !i.send.length)
          ctx.fail('An action needs something to do: --run "<command>", --send <file>, or both. (Or --main, or --remove.)');
        if (i.reply && !['output', 'none'].includes(i.reply)) ctx.fail('--reply is output or none.');
        const part = {
          ...(i.run.length ? { run: i.run } : {}),
          ...(i.send.length ? { send: i.send } : {}),
          ...(i.caption ? { caption: i.caption } : {}),
          ...(i.reply ? { reply: i.reply } : {}),
          ...(was && i.description ? { description: i.description } : {}),
          ...(({ cron, since, once }) => ({ ...(cron ? { cron, since } : {}), ...(once?.length ? { once } : {}) }))(
            actionsOf(was ?? {})[i.action] ?? {},
          ),
        };
        let tested = null;
        if (i.test !== false) {
          tested = await runShortcut(i.name, part);
          const outside = tested.ok ? tested.files.find((f) => !sendable(f)) : null;
          if (outside)
            tested = {
              ok: false,
              files: [],
              text: `${outside} is outside the folders files may be sent from. Fetch it into {dir} with a step, or add its folder to agent.readDirs.`,
            };
        }
        const sc = { ...(was ?? { description: i.description ?? `Run ${i.name}` }), actions: { ...was?.actions, [i.action]: part } };
        const result = !tested
          ? 'Not tested.'
          : tested.ok
            ? `Tested now: it works${tested.files.length ? ` (${tested.files.map((f) => path.basename(f)).join(', ')})` : tested.text ? `:\n${tested.text.split('\n').slice(0, 6).join('\n')}` : '.'}`
            : `Tested now: it did NOT work.\n${tested.text}`;
        const out = await keep(sc, 'Saved.', { tested: tested ? { ok: tested.ok, detail: tested.text } : null });
        return { ...out, text: `${out.text}\n\n${result}\nUse it: /${i.name} ${i.action} in the bot, or bc ${i.name} ${i.action}` };
      },
    },

    schedule: {
      summary: 'have a shortcut, or one of its actions, sent to you by itself at set times, or stop that',
      // The steps were approved when it was made; this only decides when they run.
      access: () => ({ level: 'ask', describe: 'run a shortcut by itself at set times and send you the result' }),
      usage: '<name> [action]',
      options: [
        ['--cron <expr>', 'a repeating schedule as cron: "0 8 * * 1-5" is 08:00 on weekdays (repeatable)', [], MANY],
        ['--at <HH:MM>', 'every day at this time (repeatable)', [], MANY],
        ['--days <list>', 'with --at: only on these days (mon,tue… weekdays, weekends)'],
        ['--once <when>', 'one time only: "YYYY-MM-DD HH:MM", or "HH:MM" for the next time it comes round (repeatable)', [], MANY],
        ['--in <duration>', 'one time only, from now: 45m, 3h, 2d'],
        ['--off', 'stop sending it by itself, repeating and one-off'],
      ],
      run: async (ctx, i) => {
        const s = { ...all(ctx) };
        const whole = s[i.name];
        if (!whole) ctx.fail(`There is no shortcut called "${i.name}". See: bc shortcut list`);
        if (i.action && !actionsOf(whole)[i.action])
          ctx.fail(
            `/${i.name} has no action "${i.action}". ${menuOf(i.name, whole).length ? `It has: ${menuOf(i.name, whole).join(', ')}.` : 'It has none.'}`,
          );
        if (!i.action && !i.off && !hasOwn(whole))
          ctx.fail(
            `/${i.name} has no steps of its own to send by itself: it is a menu. Name one of its actions: ${menuOf(i.name, whole)
              .map((m) => `bc shortcut schedule ${m.slice(1)} …`)
              .join(', ')}`,
          );
        const target = { name: i.name, action: i.action ?? null };
        const label = i.action ? `${i.name} ${i.action}` : i.name;
        const sc = i.action ? actionsOf(whole)[i.action] : whole;
        if (!i.off && !i.at.length && !i.cron.length && !i.once.length && !i.in)
          ctx.fail(
            'Say when: --cron "0 8 * * 1-5", --at 08:00 (every day, or --days mon,fri), --once "2026-10-09 21:00", --in 2h, or --off to stop.',
          );
        if (i.days && !i.at.length) ctx.fail('--days goes with --at.');
        const { at: _a, days: _d, cron: _c, since: _s, once: _o, ...rest } = sc;
        const api = await import('../../src/api.js');
        let now;
        if (i.off) now = rest;
        else {
          // --cron or --at replaces the repeating schedule; one-off times are added to those already waiting.
          const was = cronOf(sc);
          const repeating =
            i.at.length || i.cron.length ? await schedule(ctx, i.at, i.days, i.cron) : was ? { cron: was, since: sc.since } : {};
          const once = [
            ...new Set([...(sc.once ?? []).filter((t) => t > Date.now() / 1000), ...(await onceTimes(ctx, i.once, i.in))]),
          ].sort();
          now = { ...rest, ...repeating, ...(once.length ? { once } : {}) };
        }
        ctx.config.set({ shortcuts: withPart(s, target, now) });
        const when = await whenText(now);
        const { hasBot } = await import('../../src/api.js');
        return {
          text: when
            ? `/${label} will be sent to you ${when}.${hasBot() ? '' : ' (That needs a chat to send it to, and none is set up: bc channel.)'}`
            : `/${label} is no longer sent by itself. It still works when you run it.`,
          data: {
            name: i.name,
            ...(i.action ? { action: i.action } : {}),
            cron: now.cron ?? [],
            schedule: when,
            next: now.cron ? api.nextRuns(now.cron, 3).map((t) => api.fmtWhen(t)) : [],
            once: now.once ?? [],
          },
        };
      },
    },

    remove: {
      summary: 'delete a shortcut',
      access: 'ask',
      usage: '<name>',
      run: async (ctx, i) => {
        const s = { ...all(ctx) };
        if (!s[i.name]) ctx.fail(`There is no shortcut called "${i.name}".`);
        delete s[i.name];
        ctx.config.set({ shortcuts: s });
        fs.rmSync(dirOf(i.name), { recursive: true, force: true });
        await (await import('../../src/api.js')).refreshMenu();
        return `Removed /${i.name}.`;
      },
    },
  },

  // What shortcuts add to the chat, on whichever channel is in use.
  chat: {
    // Each shortcut is a command in the channel's menu.
    commands: (ctx) =>
      Object.entries(all(ctx)).map(([n, sc]) => ({
        command: n,
        description: `${sc.description}${Object.keys(actionsOf(sc)).length ? ` (${Object.keys(actionsOf(sc)).join(', ')})` : ''}`.slice(
          0,
          250,
        ),
      })),
    tick: async (ui, { ctx, now, nowMs, last, mark, once, chat }) => {
      if (!ui) return; // no channel in use: there is nowhere to send one by itself
      const api = await import('../../src/api.js');
      const send = (t) =>
        once(`at:${t.label}`, async () => {
          ctx.log(`/${t.label} (scheduled)`);
          const r = await runShortcut(t.name, t.part);
          const what = `/${t.label}, at its time`;
          if (!r.ok)
            return ui.send(chat, `😿 /${t.label}, which you asked me to send by itself, did not work.\n${r.text}`.slice(0, 4000), {
              what: `that /${t.label} did not work`,
            });
          if (r.text) await ui.send(chat, `${t.description}\n${r.text}`.slice(0, 4000), { what });
          for (const f of r.files)
            if (!(await ui.sendFile(chat, f, { caption: r.caption ?? t.description, what })))
              await ui.send(chat, `😿 /${t.label}: I could not send ${path.basename(f)}.`);
          return undefined;
        });
      for (const t of everyPart(all(ctx))) {
        const sc = t.part;
        // One-off times: each is used up when it comes, sent unless it is long past.
        const due = (sc.once ?? []).filter((x) => x <= now);
        if (due.length) {
          const left = sc.once.filter((x) => x > now);
          const { once: _o, ...rest } = sc;
          ctx.config.set({ shortcuts: withPart(all(ctx), t, { ...rest, ...(left.length ? { once: left } : {}) }) });
          if (due.some((x) => now - x <= LATE_S)) send(t);
        }
        const cron = cronOf(sc);
        if (!cron) continue;
        // The marker is tied to the times, so a new or changed schedule starts from now
        // rather than catching up on a time that passed earlier today.
        const key = `at:${t.label}:${cron.join(';')}`;
        if (!last(key)) {
          mark(key, now);
          continue;
        }
        const slot = api.scheduleDue(cron, Math.max(last(key), sc.since ?? 0), nowMs);
        if (!slot) continue;
        mark(key, slot);
        if (now - slot > LATE_S) continue;
        send(t);
      }
    },
    install: (ui, { ctx }) => {
      // Shortcuts can be added while the agent runs, so they are looked up on every message.
      // What a shortcut, or one of its actions, did: said in the chat.
      const carryOut = async (c, name, sc, part, label) => {
        ctx.log(`/${label} (shortcut)`);
        c.working(part.send?.length ? 'photo' : 'typing');
        const r = await runShortcut(name, part);
        if (!r.ok) return c.reply(`😿 ${r.text}`);
        if (r.text) await c.reply(r.text.slice(0, 4000));
        for (const f of r.files)
          await c.sendFile(
            f,
            r.caption ??
              `${part.description ?? sc.description} · ${fs.statSync(f).mtime.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`,
          );
        if (!r.text && !r.files.length) await c.reply(`Done: /${label}.`);
        return undefined;
      };
      // Its actions, as buttons to tap.
      const menu = async (c, name, sc, said) => {
        const { actions } = await import('../../src/api.js');
        const kb = actions();
        Object.keys(actionsOf(sc)).forEach((a, n) => {
          kb.add(a, `sc:${name}:${a}`);
          if (n % 3 === 2) kb.row();
        });
        return c.reply(`${said ? `${said}\n` : ''}/${name}: ${sc.description}\n${menuOf(name, sc).join(' · ')}`, { actions: kb });
      };
      ui.text(async (c, next) => {
        const m = /^\/([a-z0-9_]+)(?:@\w+)?(?:\s+(.*\S))?\s*$/.exec(c.text ?? '');
        const sc = m && all(ctx)[m[1]];
        if (!sc) return next();
        // A shortcut with no actions takes nothing after its name: that is a message for the agent, as it always was.
        if (m[2] != null && !Object.keys(actionsOf(sc)).length) return next();
        const what = choose(sc, m[2]);
        if (what.unknown) return menu(c, m[1], sc, `/${m[1]} has no "${what.unknown.slice(0, 40)}".`);
        if (what.menu) return menu(c, m[1], sc);
        return carryOut(c, m[1], sc, what.run, what.action ? `${m[1]} ${what.action}` : m[1]);
      });
      ui.action(/^sc:([a-z0-9_]+):([a-z0-9_]+)$/, async (c) => {
        const [, name, action] = c.match;
        const sc = all(ctx)[name];
        const part = sc && actionsOf(sc)[action];
        if (!part) return c.gone('That is no longer there.');
        await c.toast(`/${name} ${action}`);
        return carryOut(c, name, sc, part, `${name} ${action}`);
      });
    },
  },

  status: (ctx) => {
    const n = Object.keys(all(ctx)).length;
    return n
      ? `${n} shortcut${n === 1 ? '' : 's'}: ${Object.entries(all(ctx))
          .map(([x, sc]) => `/${x}${Object.keys(actionsOf(sc)).length ? ` (${Object.keys(actionsOf(sc)).join(', ')})` : ''}`)
          .join(' ')}`
      : 'none yet';
  },
  settings: (ctx) =>
    Object.fromEntries(
      Object.entries(all(ctx)).map(([n, sc]) => [
        `/${n}`,
        [
          sc.description,
          ...(sc.run ?? []).map((s) => `run: ${s}`),
          ...(sc.send ?? []).map((f) => `send: ${f}`),
          cronOf(sc) ? `by itself: ${ctx.api.describeSchedule(cronOf(sc)).replace(/^./, (c) => c.toLowerCase())}` : null,
          sc.once?.length ? `once more at ${sc.once.length} set time${sc.once.length === 1 ? '' : 's'}` : null,
        ]
          .filter(Boolean)
          .join(' · '),
      ]),
    ),

  // For `bc engine check`: what the owner might say, and the command it should lead to.
  checks: (ctx) => {
    const name = Object.keys(all(ctx))[0];
    return [
      {
        say: 'make a shortcut called uptime that shows how long this machine has been up',
        expect: /blackcat shortcut add uptime\b.*--run/,
      },
      ...(name ? [{ say: `run my ${name} shortcut`, expect: new RegExp(`blackcat (shortcut run ${name}|${name})\\b`) }] : []),
      // "Only if": a condition goes in a step of an action of the shortcut it belongs to, not in a shortcut of its own.
      ...(name
        ? [
            {
              say: `every night at 22:00 run my ${name} shortcut, but only if the file /tmp/skip-tonight does not exist`,
              expect: new RegExp(`blackcat shortcut action ${name} \\w+ .*--run .*(&&|\\|\\|)`),
              never: /blackcat shortcut add\b/,
            },
          ]
        : []),
    ];
  },
  // `bc selftest`: every shortcut looked over, never run (a shortcut does things): it has
  // steps, each a command that is there to run, and what it sends is in a folder files may be sent from.
  selftest: (ctx) =>
    Object.entries(all(ctx)).flatMap(([name, sc]) =>
      [
        ...(hasOwn(sc) || !Object.keys(actionsOf(sc)).length ? [[`/${name}`, sc]] : []),
        ...Object.entries(actionsOf(sc)).map(([a, part]) => [`/${name} ${a}`, part]),
      ].map(([label, part]) => ({
        name: label,
        run: async () => {
          const { sendable } = await import('../../src/api.js');
          const todo = part.run ?? [];
          if (!todo.length && !(part.send ?? []).length) throw new Error('it has nothing to do: no step and nothing to send');
          for (const step of todo) {
            const first = fill(step, name).trim().split(/\s+/)[0];
            if (first === 'blackcat' || first === 'bc') continue;
            if ((await ctx.exec('sh', ['-c', `command -v ${JSON.stringify(first)}`])).code !== 0)
              throw new Error(`its step "${step.slice(0, 60)}" starts with ${first}, which is not a program on this machine`);
          }
          for (const f of part.send ?? []) {
            const file = fill(f, name);
            if (fs.existsSync(file) && !sendable(file))
              throw new Error(`it sends ${f}, which is outside the folders files may be sent from`);
          }
          const when = part === sc ? cronOf(sc) : null;
          return `${todo.length} step${todo.length === 1 ? '' : 's'}${(part.send ?? []).length ? `, sends ${(part.send ?? []).length} file${(part.send ?? []).length === 1 ? '' : 's'}` : ''}${when ? ' · runs by itself on a schedule' : ''} (looked over, not run)`;
        },
      })),
    ),

  // Each shortcut is also a command of its own: `bc door` is `bc shortcut run door`.
  // (And `bc waves pause` is `bc shortcut run waves pause`.)
  aliases: (ctx) =>
    Object.entries(ctx.config.get().shortcuts ?? {}).map(([name, sc]) => ({
      name,
      description: `${sc.description}${Object.keys(actionsOf(sc)).length ? ` (${Object.keys(actionsOf(sc)).join(', ')})` : ''}`,
      note: 'your shortcut',
      command: 'run',
      usage: '[action]',
      input: { name },
      tokens: [name],
    })),
  agent: {
    readDirs: () => [FILES],
    fill: (ctx) => ({
      // What there is already, each with what it does and when it is sent by itself.
      shortcuts: Object.entries(all(ctx))
        .map(
          ([n, sc]) =>
            `/${n} (${sc.description}${Object.keys(actionsOf(sc)).length ? `; actions: ${Object.keys(actionsOf(sc)).join(', ')}` : ''}${everyPart(
              { [n]: sc },
            )
              .filter((t) => cronOf(t.part))
              .map((t) => `; /${t.label} sent by itself: ${cronOf(t.part).join('; ')}`)
              .join('')})`,
        )
        .join('; '),
    }),
  },
};
