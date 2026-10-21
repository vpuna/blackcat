// Checks: have something looked at on a schedule, be told when it stops working, and have a
// fix tried. Part of the framework, described with a manifest like a plugin.
import { count } from './status.js';
import { withDb } from '../db.js';
import { plural } from '../util/format.js';

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
    'a shell command to run; failing (a non-zero exit) means "not working" (printing {"problems": [{"key", "title"}]} as it fails names several things, each kept on its own). Often a plugin\'s own check: "blackcat unifi check"',
  ],
  ['--file <path>', "a file to look at, e.g. a camera's latest image"],
  ['--max-age <duration>', 'the file must have changed within this long, e.g. 20m'],
  ['--fix <command>', 'a shell command to run when it is not working'],
  ['--tries <n>', 'how many times to try the fix before giving up (default 2)'],
  ['--wait <duration>', 'how long to wait after the fix before looking again (default 90s)'],
  ['--look-for <text>', 'what "working" looks like, in your words: a reader then judges the picture or the output against it'],
  [
    '--alert <when>',
    'when you are told: now (default), briefing (only in the daily briefing), "after 3" (looks in a row), "after 15m" (down that long)',
  ],
  ['--quiet <from-to>', 'a time of day when it tells you nothing, e.g. 03:00-03:30 (it still looks and fixes)'],
  ['--remind <duration>', 'tell you again this often while it is not working and not snoozed, e.g. 1h'],
  [
    '--measure <figures>',
    'figures to keep from what --run prints, e.g. "temp,load": JSON with those fields, one number alone, or lines of name=value',
  ],
  ['--limit <limits>', 'past one of these it is not working, e.g. "temp>75" or "temp>75,free<10" (the figures are kept too)'],
  [
    '--context <command>',
    'when it is not working, what this prints is kept with the time (and its picture, with --file): bc check history',
  ],
  ['--keep <duration>', 'how long what it saw is kept (default 30d)'],
];
// Which of what is wrong: the number in `bc check show` (all of it, if left out).
const WHICH = ['-n, --n <number>', 'which of the things wrong with it (bc check show): all of them if left out'];

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
  bc check snooze camera --for 4h             not working, and you know: quiet until then (or --until-fixed)
  bc check fixed camera                       you fixed it: look now, and again over a few minutes
  bc check fix camera                         run its fix again now, and look
  bc check add "Disk" --run "df --output=pcent / | tail -1 | tr -d ' %'" --limit "used>90"
  bc check history disk --since 7d            its figures, and each time it was not working with what was going on
  bc check offered                            checks the plugins you use have ready: bc check add --from <ref>

What is wrong is kept one row an outage, from when it was first found until it works again:
found again meanwhile, that row is brought up to date. You are told when it starts (or as
--alert says), when a snooze runs out, and when it works again.

A check asks; what it asks is usually a plugin's own "check" command, which knows how to
tell whether its system is well (bc ha check, bc unifi check, and so on).`,

  commands: {
    add: {
      summary: 'set up a check',
      access: () => ASK,
      usage: '[name...]',
      options: [
        ...WHAT,
        ['--from <ref>', 'one a plugin offers (bc check offered), e.g. ssh:nas-heat; what you give besides replaces what it says'],
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
        ['--no-quiet', 'no quiet time'],
        ['--no-remind', 'no reminders'],
        ['--no-measure', 'keep no figures'],
        ['--no-limit', 'no limits'],
        ['--no-context', 'keep nothing of what was going on'],
        ['--every <when>', 'when it looks'],
        ['--name <name>', 'a new name'],
        ['--pause', 'stop looking'],
        ['--resume', 'start looking again'],
      ],
      run: async (ctx, i) => (await cmd()).edit(i, ctx.fail),
    },
    history: {
      summary: 'what it saw: its figures over a while, and each time it was not working, with what was going on then',
      access: 'allow',
      usage: '<check>',
      options: [
        ['--since <when>', 'how far back: 6h, 24h, 7d (default 24h)'],
        ['--pictures', 'save the pictures it kept, where they can be sent'],
      ],
      run: async (ctx, i) => (await cmd()).history(i, ctx.fail),
    },
    offered: {
      summary: 'the checks the plugins you use offer, ready to add',
      access: 'allow',
      run: async (ctx, i) => (await cmd()).offered(i, ctx.fail),
    },
    remove: {
      summary: 'delete a check',
      access: 'ask',
      usage: '<check>',
      run: async (ctx, i) => (await cmd()).remove(i, ctx.fail),
    },
    snooze: {
      summary: 'not working, and you know: tell nothing more until a time (tomorrow morning if not said), or until it works again',
      access: 'allow',
      usage: '<check>',
      options: [WHICH, ['--for <duration>', 'how long, e.g. 4h'], ['--until-fixed', 'until it works again']],
      run: async (ctx, i) => (await cmd()).snooze(i, ctx.fail),
    },
    unsnooze: {
      summary: 'end a snooze: you are told again',
      access: 'allow',
      usage: '<check>',
      options: [WHICH],
      run: async (ctx, i) => (await cmd()).unsnooze(i, ctx.fail),
    },
    fixed: {
      changes: true,
      summary: 'you fixed it: look now, and if it is still not working again after a minute and a few more',
      access: 'allow',
      long: true,
      usage: '<check>',
      options: [['--no-wait', 'look once only']],
      run: async (ctx, i) => (await cmd()).fixed(i, ctx.fail),
    },
    fix: {
      changes: true,
      summary: 'run its fix again now (if it is still permitted), and look',
      access: 'allow',
      usage: '<check>',
      run: async (ctx, i) => (await cmd()).fix(i, ctx.fail),
    },
    run: {
      changes: true,
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
        const { findingButtons } = await chat();
        for (const c of JSON.parse(out).checks) {
          for (const n of c.notices ?? []) {
            s.ctx.log(`"${c.name}": ${n.text}`);
            if (ui && c.chatId != null)
              await ui
                .send(c.chatId, n.text, {
                  what: `about the check "${c.name}"`,
                  ...(n.finding ? { actions: findingButtons(n.finding, n.fix) } : {}),
                })
                .catch((e) => s.ctx.log(`could not send: ${e.message}`));
          }
        }
      });
    },
  },

  // In the daily briefing: what is not working, or a line to say that all is well.
  briefing: async () => (await chat()).forBriefing(),

  // The checks whose command or fix still says a name that was changed.
  mentions: async (_ctx, pattern) => {
    const { openChecksDb, listChecks } = await import('./db.js');
    return withDb(openChecksDb, (db) =>
      listChecks(db)
        .filter((c) => pattern.test(`${c.command ?? ''}\n${c.fix ?? ''}`))
        .map((c) => `check ${c.id} "${c.name}"`),
    );
  },
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
        if (c.wrong?.open) throw new Error(`not working: ${c.wrong.title}`);
        // (Not working, and the owner knows: snoozed. Said, but not counted as a failure.)
        if (c.wrong) return { skip: `not working, snoozed: ${c.wrong.title}` };
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
      ? `${plural(c.all, 'check')}${c.failing ? ` · ${c.failing} NOT WORKING` : c.snoozed ? '' : ' · all fine'}${c.snoozed ? ` · ${c.snoozed} not working, snoozed` : ''}${c.paused ? ` · ${c.paused} paused` : ''}`
      : 'none set up';
  },

  // For `bc engine check`: what the owner might say, and the command it should lead to.
  // (Not "set one up": asked that, it rightly looks at the system first and shows a plan before creating anything.)
  trials: [
    { say: 'how are my checks doing, is anything not working?', expect: /blackcat check (list|show|run)\b/ },
    { say: 'what ready-made checks could i add?', expect: /blackcat check offered\b/ },
    { say: 'why did my disk check go off last night, what was going on then?', expect: /blackcat check (history|list|show)\b/ },
  ],
};
