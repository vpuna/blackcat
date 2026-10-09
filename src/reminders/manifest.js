// Reminders: set by you, by the agent when you ask, or picked up from your messages on a schedule.
// Delivered in Telegram with Done and snooze buttons.
import { FORM, apply } from './setup.js';
import { describeQuiet, hasBot, load } from '../internal.js';
import { withDb } from '../db.js';

const cmd = () => import('./commands.js');
const tg = () => import('./chat.js');
const WHEN = [
  ['--at <time>', '"YYYY-MM-DD HH:MM", "YYYY-MM-DD" (9:00) or "HH:MM" (next time it comes round)'],
  ['--in <duration>', 'from now: 45m, 3h, 2d, 1w'],
];

export default {
  api: 1,
  name: 'remind',
  title: 'Reminders',
  description: 'reminders and nudges delivered here: ones you set, and ones from your watches',
  help: `Examples:
  bc remind add Call the bank --in 2d
  bc remind add Reply to Mum about Saturday --at 18:30 --msg <message-id>
  bc remind add Take out the bins --at 20:00 --repeat weekly
  bc remind snooze 4 --in 1h

Things to do are picked up from your messages by the built-in "Things I need to do" watch:
  bc watch setup             on or off, when it looks, which chats, email (also in the bot: /setup)
  bc watch show todo         what it has found
Quiet hours, when nudges wait:  bc remind setup`,

  commands: {
    add: {
      summary: 'create a reminder',
      access: 'allow',
      usage: '<text...>',
      options: [
        ...WHEN,
        ['--msg <messageId>', 'attach a message from the archive (its chat, sender and text are quoted in the reminder)'],
        ['--repeat <how>', 'daily, weekdays, weekly or monthly'],
        [
          '--cron <expr>',
          'repeat on a schedule, as cron: "0 20 * * 1,4" is 20:00 on Monday and Thursday (repeatable; with no --at it is first due the next time that comes round)',
          [],
          { many: true },
        ],
        ['--file <path>', 'a picture or document to send along when it arrives'],
      ],
      run: async (_c, i) => (await cmd()).add(i.text, i, {}),
    },
    list: {
      summary: 'upcoming reminders',
      access: 'allow',
      options: [['--all', 'include done and cancelled ones']],
      run: async (_c, i) => (await cmd()).list(i, {}),
    },
    done: { summary: 'mark a reminder done', access: 'allow', usage: '<id>', run: async (_c, i) => (await cmd()).done(i.id, i, {}) },
    cancel: { summary: 'cancel a reminder', access: 'allow', usage: '<id>', run: async (_c, i) => (await cmd()).cancel(i.id, i, {}) },
    snooze: {
      summary: 'move a reminder to a later time',
      access: 'allow',
      usage: '<id>',
      options: WHEN,
      run: async (_c, i) => (await cmd()).snooze(i.id, i, {}),
    },
    setup: {
      summary: 'quiet hours: when nudges wait (what is picked up from your messages is set with: bc watch setup)',
      // A preference, not a connection or a permission: the agent may change it when you ask, with your say each time.
      access: () => ({ level: 'ask', describe: 'change your quiet hours' }),
      form: FORM,
      run: (_c, a) => apply(a),
    },
  },

  // What reminders add to the chat, on whichever channel is in use.
  chat: {
    commands: [{ command: 'remind', description: 'Upcoming reminders (/remind help: its commands)' }],
    install: async (ui) => {
      const t = await tg();
      t.installReminders(ui);
      // `/remind` alone is the list. With words after it, it is a command typed in the chat.
      ui.command('remind', (c, next) => (String(c.match ?? '').trim() ? next() : c.reply(t.upcomingText(c.chat))));
    },
    // Every scheduler tick, inside the agent service: deliver what is due.
    // (With no channel in use, due reminders wait and are shown in `bc chat`.)
    tick: async (ui) => ui && (await tg()).fireDue(ui),
  },

  // With no channel in use there is nowhere to push a reminder to: those that came due wait,
  // and are handed over when the owner next opens the terminal chat.
  waiting: async () => {
    const due = (await import('./local.js')).takeDue();
    if (!due.length) return null;
    const { fmtWhen } = await import('../internal.js');
    return {
      heading: `⏰ ${due.length === 1 ? 'A reminder came' : `${due.length} reminders came`} due:`,
      lines: due.map((r) => ({ text: r.text, note: `was due ${fmtWhen(r.due_ts)} · bc remind done ${r.id}` })),
    };
  },
  // A file the owner sent is kept for as long as a reminder carries it.
  inboxKeeps: async () => {
    const { openRemindersDb } = await import('./db.js');
    return withDb(openRemindersDb, (db) =>
      db.prepare("SELECT file FROM reminders WHERE file IS NOT NULL AND status IN ('pending', 'sent')").pluck().all(),
    );
  },
  // The owner is reached somewhere else now: what was to be sent to them goes there.
  ownerMoved: async (_ctx, { from, to }) => {
    const { openRemindersDb } = await import('./db.js');
    return withDb(openRemindersDb, (db) => db.prepare('UPDATE reminders SET chat_id = ? WHERE chat_id = ?').run(to, from).changes);
  },

  // `bc selftest`: nothing that came due is still waiting to be sent.
  selftest: () => [
    {
      name: 'delivery',
      run: async () => {
        const { openRemindersDb, listReminders } = await import('./db.js');
        const { hasBot } = await import('../internal.js');
        const rows = withDb(openRemindersDb, (db) => listReminders(db));
        const late = rows.filter((r) => r.status === 'pending' && r.source !== 'auto' && Date.now() / 1000 - r.due_ts > 15 * 60);
        if (late.length && hasBot())
          throw new Error(
            `${late.length} came due more than a quarter of an hour ago and ${late.length === 1 ? 'has' : 'have'} not been sent: is the agent service running?`,
          );
        return `${rows.filter((r) => r.status === 'pending').length} waiting for their time${late.length ? ` · ${late.length} kept for the terminal (no channel in use)` : ', none overdue'}`;
      },
    },
  ],

  status: async () => {
    const { listReminders, openRemindersDb: openAgentDb } = await import('../internal.js');
    const n = withDb(openAgentDb, (db) => listReminders(db).filter((r) => r.status === 'pending').length);
    return `${n} upcoming · ${describeQuiet()}`;
  },

  settings: () => {
    const r = load().reminders ?? {};
    return {
      'quiet hours': r.quiet ? `${r.quiet.from} to ${r.quiet.to} (nudges wait; reminders you set don't)` : 'none',
      'picked up from your messages': 'that is the "Things I need to do" watch: bc watch settings',
    };
  },

  // For `bc engine check`: what the owner might say, and the command it should lead to.
  // For its notes: is this a terminal, and is there a chat to push anything to.
  agent: { fill: (ctx) => ({ terminal: ctx.surface === 'terminal', unreached: !hasBot() }) },
  checks: [
    { say: 'what reminders do i have', expect: /blackcat remind list\b.*--json/ },
    { say: 'remind me tomorrow at 9am to call the bank', expect: /blackcat remind add .*bank.*--at ["']?\d{4}-\d\d-\d\d 09:00/i },
    {
      say: 'every monday and thursday at 8pm remind me to take the bins out',
      expect: /blackcat remind add .*--cron ["']0 20 \* \* 1,4["']/,
    },
  ],
};
