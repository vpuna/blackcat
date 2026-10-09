// Checks: have something looked at on a schedule, be told when it stops working, and have a
// fix tried. Part of the framework, described with a manifest like a plugin.
import { count } from './status.js';
import { withDb } from '../db.js';

const cmd = () => import('./commands.js');
const chat = () => import('./chat.js');
// Setting one up, or changing one, puts commands on a schedule that then run by themselves
// (the fix without asking): the owner sees them in full and says yes, each time.
const ASK = {
  level: 'ask',
  describe: 'set up or change a check that runs commands by itself on a schedule (its fix then runs without asking)',
};
const WHAT = [
  [
    '--run <command>',
    'a shell command to run; failing (a non-zero exit) means "not working". Often a plugin\'s own check: "blackcat unifi check"',
  ],
  ['--file <path>', "a file to look at, e.g. a camera's latest image"],
  ['--max-age <duration>', 'the file must have changed within this long, e.g. 20m'],
  ['--fix <command>', 'a shell command to run when it is not working'],
  ['--tries <n>', 'how many times to try the fix before giving up (default 2)'],
  ['--wait <duration>', 'how long to wait after the fix before looking again (default 90s)'],
  ['--look-for <text>', 'what "working" looks like, in your words: a reader then judges the picture or the output against it'],
];

export default {
  api: 1,
  name: 'check',
  title: 'Checks',
  description: 'have something looked at on a schedule: you are told when it stops working, a fix can be tried, and when it recovers',
  help: `Examples:
  bc check add "Front door" --run "blackcat ha check 'front door' --is closed" --every 30m
  bc check add "Media server" --run "blackcat ssh run nas 'docker inspect -f {{.State.Running}} media | grep -q true'" --fix "blackcat ssh run nas 'docker restart media'"
  bc check add "Sky picture" --file ~/camera/latest.jpg --max-age 20m --look-for "a picture of the sky, not black or garbled"
  bc check list                               every check and how it is doing
  bc check run camera --dry-run               look once now; nothing is fixed, and its state is not changed

A check asks; what it asks is usually a plugin's own "check" command, which knows how to
tell whether its system is well (bc ha check, bc unifi check, and so on).`,

  commands: {
    add: {
      summary: 'set up a check',
      access: () => ASK,
      usage: '<name...>',
      options: [
        ...WHAT,
        [
          '--every <when>',
          'when it looks: "30m" (default), "1h", times like "08:00,20:00", or cron. Never more often than every 5 minutes',
        ],
      ],
      run: async (ctx, i) => (await cmd()).add(i, ctx.fail),
    },
    list: {
      summary: 'every check and how it is doing',
      access: 'allow',
      run: async (ctx, i) => (await cmd()).list(i, ctx.fail),
    },
    show: {
      summary: 'one check: what it looks at, how it is doing, and what has gone wrong before',
      access: 'allow',
      usage: '<check>',
      run: async (ctx, i) => (await cmd()).show(i, ctx.fail),
    },
    edit: {
      summary: 'change a check: what it looks at, its fix, when it looks; or pause it',
      access: () => ASK,
      usage: '<check>',
      options: [
        ...WHAT,
        ['--no-fix', 'remove the fix'],
        ['--no-look-for', 'drop the description, so only the plain rules decide'],
        ['--every <when>', 'when it looks'],
        ['--name <name>', 'a new name'],
        ['--pause', 'stop looking'],
        ['--resume', 'start looking again'],
      ],
      run: async (ctx, i) => (await cmd()).edit(i, ctx.fail),
    },
    remove: {
      summary: 'delete a check',
      access: 'ask',
      usage: '<check>',
      run: async (ctx, i) => (await cmd()).remove(i, ctx.fail),
    },
    run: {
      summary: 'look now, without waiting for its turn: one check, or all of them (a fix that is permitted is run if it is not working)',
      access: 'allow',
      usage: '[check]',
      options: [
        ['--dry-run', 'only look: nothing is fixed, and its state is not changed'],
        ['--due', 'only the checks whose turn it is'],
      ],
      run: async (ctx, i) => (await cmd()).run(i, ctx.fail),
    },
  },

  // What checks add to the chat, on whichever channel is in use.
  chat: {
    commands: [{ command: 'check', description: 'Your checks: how each is doing, look now, pause (/check help: its commands)' }],
    install: async (ui) => {
      const t = await chat();
      t.installChecks(ui);
      // `/check` alone is the screen. With words after it, it is a command typed in the chat.
      ui.command('check', (c, next) => (String(c.match ?? '').trim() ? next() : t.showChecks(c)));
    },
    // Every scheduler tick, inside the agent service: the checks whose turn it is look, and
    // the owner is told when one stops working, is fixed, or recovers. (With no channel in
    // use they still look and fix; what they found is in `bc check list`.)
    tick: async (ui, s) => {
      const { dueChecks } = await cmd();
      const { openChecksDb } = await import('./db.js');
      const due = withDb(openChecksDb, (db) => dueChecks(db, s.nowMs).length);
      if (!due) return;
      s.once('run', async () => {
        const out = await s.runJob(['check', 'run', '--due', '--json']);
        if (!out) return;
        for (const c of JSON.parse(out).checks) {
          for (const n of c.notices ?? []) {
            s.ctx.log(`"${c.name}": ${n}`);
            if (ui && c.chatId != null)
              await ui.send(c.chatId, n, { what: `about the check "${c.name}"` }).catch((e) => s.ctx.log(`could not send: ${e.message}`));
          }
        }
      });
    },
  },

  // In the daily briefing: what is not working, or a line to say that all is well.
  briefing: async () => (await chat()).forBriefing(),

  // The owner is reached somewhere else now: they are told there when something stops working.
  ownerMoved: async (_ctx, { from, to }) => {
    const { openChecksDb } = await import('./db.js');
    return withDb(openChecksDb, (db) => db.prepare('UPDATE checks SET chat_id = ? WHERE chat_id = ?').run(to, from).changes);
  },

  // `bc selftest`: every check, by what it found when it last looked (it is not run again here: a check may run anything).
  selftest: async () => {
    const { openChecksDb, listChecks } = await import('./db.js');
    const { fixAllowed } = await import('./check.js');
    return withDb(openChecksDb, (db) => listChecks(db)).map((c) => ({
      name: c.name,
      run: () => {
        if (!c.active) return { skip: 'paused' };
        if (c.state?.status === 'failing') throw new Error(`not working${c.state.reason ? `: ${c.state.reason}` : ''}`);
        if (c.fix && !fixAllowed(c)) throw new Error('working, but its fix is no longer permitted (bc permissions): it would not be run');
        if (!c.last_run) return { skip: 'it has not looked yet' };
        const mins = Math.round((Date.now() / 1000 - c.last_run) / 60);
        if (mins > 24 * 60) throw new Error(`it has not looked for ${Math.round(mins / 60)} hours: is the agent service running?`);
        return `working when it last looked, ${mins < 1 ? 'just now' : `${mins} min ago`}${c.fix ? ' · its fix is permitted' : ''}`;
      },
    }));
  },

  status: () => {
    const c = count();
    return c.all
      ? `${c.all} check${c.all === 1 ? '' : 's'}${c.failing ? ` · ${c.failing} NOT WORKING` : ' · all fine'}${c.paused ? ` · ${c.paused} paused` : ''}`
      : 'none set up';
  },

  // For `bc engine check`: what the owner might say, and the command it should lead to.
  // (Not "set one up": asked that, it rightly looks at the system first and shows a plan before creating anything.)
  checks: [{ say: 'how are my checks doing, is anything not working?', expect: /blackcat check (list|show|run)\b/ }],
};
