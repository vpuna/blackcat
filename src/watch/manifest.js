// Watches: keep a tab on certain messages, collect what fits into a list, and report
// on a schedule (a digest) or straight away (an alert).
import { applyTodo, describeTodo, todoForm } from './setup.js';
import fs from 'node:fs';
import {
  ARCHIVE_DB,
  describeSchedule,
  hasBot,
  owner,
  pluginSettings,
  readerModel,
  scheduleDue,
  scheduleSummary,
  storedSchedule,
} from '../internal.js';
import { withDb } from '../db.js';

const cmd = () => import('./commands.js');
const tg = () => import('./chat.js');
const MANY = { many: true };
const BRIEFING_CATCH_UP_S = 5 * 3600;
// { on, cron }: when the briefing goes out. (`at` is how one daily time was kept before schedules were cron.)
const briefingOf = () => {
  const b = pluginSettings('watch').briefing ?? {};
  return { on: b.on !== false, cron: storedSchedule({ cron: b.cron }, ['0 7 * * *']) };
};

let looking = Promise.resolve(); // (the agent service's looks, one after another)

export default {
  api: 1,
  name: 'watch',
  title: 'Watches',
  description: 'keep a tab on certain messages: collect what fits into a list and report on a schedule',
  help: `Example: links Maya sends about things to do, reported every Thursday evening
  bc watch add Weekend ideas from Maya \\
      --look-for "restaurants, shows, events and things to do in town that she'd like us to try" \\
      --chat "Maya Lopez" --self --links-only --days thu --at 18:00

Sources: --chat can be repeated. In a group, --from limits it to one person. --self adds
messages you send to yourself. Your own messages in the watched chats are read too, so that\na plan you proposed or something you said you would do is picked up; --no-also-mine leaves them out.`,

  commands: {
    add: {
      summary: 'create a watch',
      access: 'allow',
      usage: '<name...>',
      options: [
        ['--look-for <what>', 'what belongs on the list, in plain words'],
        ['--chat <name>', 'a chat to watch (repeatable); with no chat it is a plain list you add to by hand', [], MANY],
        ['--from <person>', 'in group chats, only messages from this person'],
        ['--self', 'also messages you send to yourself'],
        ['--no-also-mine', 'leave out your own messages in the watched chats (they are read unless you say so)'],
        ['--links-only', 'only messages that contain a link'],
        ['--attachments', 'also read the pictures, PDFs and documents sent in these chats'],
        ['--no-voice-notes', 'do not listen to voice notes in these chats (they are, when the voice plugin is on, unless you say so)'],
        [
          '--mode <mode>',
          'how new items reach you: briefing (in the daily briefing, the default), digest (its own report on --days at --at), alert (straight away)',
        ],
        ['--days <days>', 'digest days: thu, "fri,sat", daily, weekdays'],
        ['--at <time>', 'digest time, HH:MM'],
        ['--cron <expr>', 'when its own report goes out, as cron: "0 18 * * 4" (repeatable)', [], MANY],
        ['--nudge <when>', 'a ping before a dated item: off, or "<days>d HH:MM", e.g. "2d 18:00" (default), "0d 07:00" for the morning of'],
        ['--scan <when>', 'when it looks for new messages: "15m" (default), "1h", times like "08:00,20:00", or cron like "0 8,20 * * 1-5"'],
        ['--history <which>', 'all: start with everything already in the archive; none: only new messages', 'all'],
        ['--quiet <list>', 'a list to keep out of reports (repeatable)', [], MANY],
      ],
      run: async (_c, i) => (await cmd()).add(i.name, i, {}),
    },
    list: { summary: 'all watches', access: 'allow', run: async (_c, i) => (await cmd()).list(i, {}) },
    show: {
      summary: "what's on a watch's list",
      access: 'allow',
      usage: '<watch>',
      options: [
        ['--status <which>', 'new, kept, done, dropped, expired, or all (comma-separated)', 'new,kept'],
        ['--list <name>', 'only one of its lists, e.g. restaurants'],
      ],
      run: async (_c, i) => (await cmd()).show(i.watch, i, {}),
    },
    lists: {
      summary: "a watch's lists and how many items each has",
      access: 'allow',
      usage: '<watch>',
      run: async (_c, i) => (await cmd()).lists(i.watch, i, {}),
    },
    setup: {
      summary: '"Things I need to do", the watch that is always there: on or off, when it looks, which chats, email',
      // A preference, not a connection or a permission: the agent may change it when you ask, with your say each time.
      access: () => ({ level: 'ask', describe: 'change how "Things I need to do" is set up' }),
      form: todoForm,
      run: (_c, a) => applyTodo(a),
    },

    chats: {
      summary: 'pick exactly which chats "Things I need to do" looks at',
      access: 'owner',
      interactive: true,
      run: async () => (await import('./setup.js')).pickChats(),
    },

    edit: {
      summary: 'change a watch: what it looks for, where, and when it reports',
      // What "Things I need to do" picks up from all the owner's messages is the owner's to say:
      // the agent may change it when asked, with their say each time.
      access: (_c, tokens) =>
        tokens.some((t) => /^--(also|never)(=|$)/.test(t))
          ? { level: 'ask', describe: 'change what "Things I need to do" picks up from your messages' }
          : 'allow',
      usage: '<watch>',
      options: [
        ['--name <name>', 'a new name'],
        ['--look-for <what>', 'what belongs on the list'],
        ['--also <text>', '"Things I need to do" only: something more for it to pick up, in your own words ("" takes it away)'],
        ['--never <text>', '"Things I need to do" only: something it is never to pick up ("" takes it away)'],
        ['--add-chat <name>', 'watch another chat (repeatable)', [], MANY],
        ['--remove-chat <name>', 'stop watching a chat (repeatable)', [], MANY],
        ['--from <person>', 'for the group chats or mail accounts being added: only this sender, or several separated by commas'],
        ['--self', 'include messages you send to yourself'],
        ['--no-self', 'stop including them'],
        ['--also-mine', 'read your own messages in the watched chats too, from now on (the default for a new watch)'],
        ['--no-also-mine', 'leave them out'],
        ['--links-only', 'only messages with a link'],
        ['--no-links-only', 'any message'],
        ['--attachments', 'also read pictures, PDFs and documents'],
        ['--no-attachments', 'stop reading them'],
        ['--voice-notes', 'listen to voice notes in the watched chats (the default)'],
        ['--no-voice-notes', 'do not listen to them'],
        ['--mail', '"Things I need to do" only: read kept email (it does by default)'],
        ['--no-mail', 'stop reading email'],
        ['--calendar', '"Things I need to do" only: include your calendar (it does by default)'],
        ['--no-calendar', 'leave the calendar out'],
        [
          '--with <source>',
          '"Things I need to do" only: cover this as well (mail, calendar, or any source a plugin adds; repeatable)',
          [],
          MANY,
        ],
        ['--without <source>', 'leave it out (repeatable)', [], MANY],
        ['--covers <which>', '"Things I need to do" only: all (every chat) or direct (one-to-one chats)'],
        ['--mode <mode>', 'briefing, digest or alert'],
        ['--days <days>', 'digest days'],
        ['--at <time>', 'digest time'],
        ['--cron <expr>', 'when its own report goes out, as cron (repeatable)', [], MANY],
        ['--nudge <when>', 'off, suggested, or "<days>d HH:MM"'],
        ['--scan <when>', '"15m", "1h", times like "08:00,20:00", or cron'],
        ['--pause', 'stop collecting and reporting'],
        ['--resume', 'start again'],
        ['--quiet <list>', 'keep this list out of reports: it is only shown when asked for (repeatable)', [], MANY],
        ['--unquiet <list>', 'report it again (repeatable)', [], MANY],
      ],
      run: async (_c, i) => (await cmd()).edit(i.watch, i, {}),
    },
    remove: {
      summary: 'delete a watch and its list',
      access: 'ask',
      usage: '<watch>',
      run: async (_c, i) => (await cmd()).remove(i.watch, i, {}),
    },
    item: {
      summary: 'mark an item done, keep or drop; or move it to another list',
      access: 'allow',
      usage: '<itemId> <action> [list...]',
      run: async (_c, i) => (await cmd()).item(i.itemId, i.action, (i.list ?? []).join(' '), i, {}),
    },
    'add-item': {
      summary: 'put something on a list by hand',
      access: 'allow',
      usage: '<watch>',
      options: [
        ['--msg <messageId>', 'a message from the archive (its link and preview title are used)'],
        ['--title <title>', 'what it is'],
        ['--url <url>', 'a link'],
        ['--list <name>', "which of the watch's lists it goes on (a new name starts a new list)"],
        ['--file <path>', 'a picture or document that belongs with it'],
        ['--category <category>', 'same as --list (older name)'],
        ['--place <place>', 'venue'],
        ['--area <area>', 'neighbourhood or city'],
        ['--date <date>', 'YYYY-MM-DD, if it happens on a day'],
        ['--summary <text>', 'one line'],
      ],
      run: async (_c, i) => (await cmd()).addItemCmd(i.watch, i, {}),
    },
    'edit-item': {
      summary:
        'change an entry that is on a list: what it is called, its day, place, link or one-line note (it stays the same entry, with the message it came from)',
      access: 'allow',
      usage: '<itemId>',
      options: [
        ['--title <title>', 'what it is'],
        ['--date <date>', 'YYYY-MM-DD; "" for no particular day'],
        ['--summary <text>', 'one line, with the details as they now are (a new time, a new place)'],
        ['--place <place>', 'venue'],
        ['--area <area>', 'neighbourhood or city'],
        ['--url <url>', 'a link; "" to take it away'],
        ['--list <name>', "which of the watch's lists it is on"],
      ],
      run: async (_c, i) => (await cmd()).editItemCmd(i.itemId, i, {}),
    },
    scan: {
      summary: 'look now, without waiting for its turn: one watch, or all of them (each otherwise looks when its own schedule says)',
      access: 'allow',
      usage: '[watch]',
      options: [
        ['--dry-run', "show what would be added, but don't save"],
        ['--due', 'only the watches whose turn it is'],
      ],
      run: async (_c, i) => (await cmd()).scan(i.watch, i, {}),
    },
    tidy: {
      summary: 'merge entries on a list that are the same thing announced more than once',
      access: 'allow',
      usage: '<watch>',
      options: [['--dry-run', "show what would be merged, but don't change anything"]],
      run: async (_c, i) => (await cmd()).tidy(i.watch, i, {}),
    },
    briefing: {
      summary:
        'the briefing: send it to your chat now, or show it here with --print; --cron (or --at and --days), --off and --on change when it arrives',
      access: (_c, tokens) =>
        tokens.every((t) => ['--show', '--print', '--peek'].includes(t))
          ? 'allow'
          : { level: 'ask', describe: 'change when the briefing arrives' },
      options: [
        [
          '--cron <expr>',
          'when it arrives, as cron: "0 7,18 * * 1-5" is 07:00 and 18:00 on weekdays (repeatable, for schedules that need more than one)',
          [],
          MANY,
        ],
        ['--at <time>', 'a time of day, HH:MM (repeatable)', [], MANY],
        ['--days <days>', 'with --at: daily (default), weekdays, weekend, or "mon,wed,fri"'],
        ['--off', 'stop sending it'],
        ['--on', 'send it again'],
        ['--show', 'just say when it arrives'],
        ['--print', 'show it here instead of sending it (the default when no channel is in use)'],
        ['--peek', 'with no channel: leave new items marked as new'],
      ],
      run: async (_c, i) => (await cmd()).briefing(i, {}),
    },
    digest: {
      summary: "send a watch's report to your chat now",
      access: 'allow',
      usage: '<watch>',
      run: async (_c, i) => (await cmd()).digest(i.watch, i, {}),
    },
  },

  // What watches add to the chat, on whichever channel is in use.
  chat: {
    commands: [
      { command: 'briefing', description: "Today's briefing: what's on, what's coming up, what's new" },
      { command: 'watch', description: 'Your watches: open one, see its list, check for new (/watch help: its commands)' },
    ],
    install: async (ui) => {
      const t = await tg();
      t.installWatches(ui);
      // `/watch` alone is the screen. With words after it, it is a command typed in the chat.
      ui.command('watch', (c, next) => (String(c.match ?? '').trim() ? next() : t.showWatches(c)));
      ui.command('briefing', (c) => t.sendBriefing(ui, c.chat, { peek: true }));
    },
    // Every scheduler tick, inside the agent service: let the watches whose turn it is look for new
    // messages (a model is only called when there are some), alert straight away for alert
    // watches, and send the reports and the daily briefing when their time comes.
    tick: async (ui, s) => {
      if (!fs.existsSync(ARCHIVE_DB)) return;
      const t = await tg();
      const { getWatch, openWatchDb } = await import('./db.js');
      // One look at a time: the hourly look and the one before a briefing fall on the same
      // minute, and two at once would each read the same new messages.
      const scan = (args) => (looking = looking.catch(() => {}).then(() => look(args)));
      const look = async (args) => {
        const out = await s.runJob(['watch', 'scan', ...args, '--json']);
        if (!out) return;
        return withDb(openWatchDb, async (db) => {
          for (const w of JSON.parse(out).watches) {
            if (w.added.length || w.updated?.length)
              s.ctx.log(`"${w.name}": ${w.added.length} new${w.updated?.length ? `, ${w.updated.length} updated` : ''}`);
            if (ui && w.mode === 'alert' && w.added.length)
              await t.sendAlerts(
                ui,
                db,
                getWatch(db, w.id),
                w.added.map((a) => a.id),
              );
          }
        });
      };
      const { dueWatches } = await import('./collect.js');
      const due = withDb(openWatchDb, (db) => dueWatches(db, s.nowMs).length);
      if (due) s.once('scan', () => scan(['--due']));

      // With no channel in use there is nowhere to send reports: the lists still fill up, and
      // `bc chat` (or `bc watch briefing`) shows them.
      if (!ui) return;
      await t.sendDueDigests(ui);

      const b = t.briefingSettings();
      // The first time ever, start counting from now rather than catching up on a time already past.
      if (!s.last('briefing_slot')) s.mark('briefing_slot', s.now);
      const slot = b.on ? scheduleDue(b.cron, s.last('briefing_slot'), s.nowMs) : null;
      if (slot) {
        // If blackcat was off at the time, catch up, but not so late that it is no longer the
        // briefing for that time of day.
        const late = s.now - slot > BRIEFING_CATCH_UP_S;
        s.mark('briefing_slot', slot);
        if (!late)
          s.once('briefing', async () => {
            await scan([]); // look at everything first, so the briefing is up to date
            const chats = [owner()?.chat].filter((x) => x != null);
            for (const chatId of chats) await t.sendBriefing(ui, chatId);
            s.ctx.log('briefing sent');
          });
      }
    },
  },

  // A nudge this set for an entry was marked done: the entry is ticked off its list.
  nudgeDone: (_ctx, { db, itemId }) =>
    void db.prepare("UPDATE watch_items SET status = 'done' WHERE id = ? AND status IN ('new', 'kept')").run(itemId),
  // A file the owner sent is kept for as long as an entry still on a list carries it.
  inboxKeeps: async () => {
    const { openWatchDb } = await import('./db.js');
    return withDb(openWatchDb, (db) =>
      db.prepare("SELECT file FROM watch_items WHERE file IS NOT NULL AND status IN ('new', 'kept')").pluck().all(),
    );
  },
  // The owner is reached somewhere else now: their watches report there.
  ownerMoved: async (_ctx, { from, to }) => {
    const { openWatchDb } = await import('./db.js');
    return withDb(openWatchDb, (db) => db.prepare('UPDATE watches SET chat_id = ? WHERE chat_id = ?').run(to, from).changes);
  },

  // `bc selftest`: every watch: the chats it reads are still in the archive, and it has looked lately.
  selftest: async () => {
    const { listWatches, openWatchDb } = await import('./db.js');
    const { openArchive } = await import('../internal.js');
    return withDb(openWatchDb, (db) =>
      listWatches(db).map((w) => ({
        ...w,
        items: db.prepare("SELECT COUNT(*) FROM watch_items WHERE watch_id = ? AND status IN ('new', 'kept')").pluck().get(w.id),
      })),
    ).map((w) => ({
      name: w.name,
      run: () => {
        if (!w.active) return { skip: 'paused' };
        const chats = w.sources?.chats ?? [];
        if (chats.length && fs.existsSync(ARCHIVE_DB)) {
          const gone = withDb(openArchive, (a) => chats.filter((c) => !a.prepare('SELECT 1 FROM chats WHERE ref = ?').get(c.ref)));
          if (gone.length)
            throw new Error(
              `it reads ${gone.map((c) => c.name ?? c.ref).join(', ')}, which ${gone.length === 1 ? 'is' : 'are'} no longer in the archive`,
            );
        }
        const hours = w.last_scan ? (Date.now() / 1000 - w.last_scan) / 3600 : null;
        if (chats.length || w.sources?.everywhere) {
          if (hours == null) return { skip: 'it has not looked yet' };
          if (hours > 26) throw new Error(`it has not looked for ${Math.round(hours)} hours: is the agent service running?`);
        }
        return `${w.items} on its lists${hours == null ? '' : ` · looked ${hours < 1 ? `${Math.max(1, Math.round(hours * 60))} min` : `${Math.round(hours)} h`} ago`}`;
      },
    }));
  },

  status: async () => {
    const { listWatches, openWatchDb } = await import('./db.js');
    const { ws, items } = withDb(openWatchDb, (db) => ({
      ws: listWatches(db),
      items: db.prepare("SELECT COUNT(*) AS n FROM watch_items WHERE status IN ('new', 'kept')").get().n,
    }));
    const b = briefingOf();
    const brief = b.on ? `briefing: ${describeSchedule(b.cron).replace(/^./, (c) => c.toLowerCase())}` : 'briefing off';
    // (A watch reads with a model. Without one it waits, and that is said here.)
    const { modelState } = await import('../engines/registry.js');
    const waits = ws.some((w) => w.active) && !(await modelState('readers')).ok ? ' · not reading: no model is set up' : '';
    return ws.length
      ? `${ws.length} watch${ws.length === 1 ? '' : 'es'} · ${items} items on their lists · ${brief}${waits}`
      : `no watches yet (ask me to keep a tab on something) · ${brief}`;
  },

  settings: () => {
    const b = briefingOf();
    return {
      briefing: b.on ? scheduleSummary(b.cron) : 'off',
      'messages are read with': readerModel() ?? "the engine's own choice (bc engine status)",
      '"Things I need to do"': `${describeTodo()} (change it: bc watch setup)`,
      'each watch': 'see bc watch list',
    };
  },

  // For `bc engine check`: what the owner might say, and the command it should lead to.
  // For its notes: is this a terminal, and is there a chat to push anything to.
  agent: { fill: (ctx) => ({ terminal: ctx.surface === 'terminal', unreached: !hasBot() }) },
  checks: [
    { say: 'what watches do i have', expect: /blackcat watch list\b/ },
    {
      say: 'send my briefing at 7 and 6 on weekdays, and 9:30 at weekends',
      expect: /blackcat watch briefing .*--cron ["']0 7,18 \* \* 1-5["'].*--cron ["']30 9 \* \* (6,0|0,6)["']/,
    },
    {
      say: 'keep a tab on what the school parents group says about uniform and dress up days',
      expect: /blackcat (watch (add|list|show|edit)|msg chats)\b/,
    },
  ],
};
