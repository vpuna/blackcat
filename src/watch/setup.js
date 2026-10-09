import { connected, reads } from './agenda.js';
import pc from 'picocolors';
import { TODO, findWatch, openWatchDb, updateWatch } from './db.js';
import { describeSchedule, load, optIn, parseWhenText, prompts, readerModel, scheduleText, shortestGap, update } from '../internal.js';
import { withDb } from '../db.js';

export const DEFAULTS = { auto: false, scan: '1h', quiet: { from: '23:00', to: '07:00' }, chats: 'all' };

// Picking things up from your messages is done by the built-in "Things I need to do" watch
// (see watch/collect.js). These settings are that watch's, plus the quiet hours and model
// kept in the config.
function todo() {
  const w = withDb(openWatchDb, (db) => findWatch(db, TODO));
  return w;
}

// "Things I need to do", in a line.
export function describeTodo() {
  const w = todo();
  if (!w?.active) return 'not picking things up from your messages';
  const s = w.sources;
  const who = s.everywhere === 'direct' ? 'one-to-one chats' : s.everywhere ? 'all chats' : `${s.chats?.length ?? 0} chosen chats`;
  const r = reads(w);
  return `picking things up from ${[
    who,
    ...optIn()
      .filter((src) => r[src.id])
      .map((src) => src.todoText ?? src.label),
    r.calendar ? 'your calendar' : null,
  ]
    .filter(Boolean)
    .join(', ')} ${describeSchedule(w.scan.cron).replace(/^./, (c) => c.toLowerCase())}`;
}

function current() {
  const w = todo();
  const cfg = { ...DEFAULTS, ...load().reminders };
  cfg.scan = [cfg.scan].flat().join(', ');
  if (!w) return cfg;
  return {
    ...cfg,
    auto: !!w.active,
    scan: scheduleText(w.scan.cron),
    chats: w.sources.everywhere ?? (w.sources.chats ?? []).map((c) => c.ref),
  };
}
// What is wrong with a "when" answer, or undefined if it is fine.
function whenProblem(v) {
  try {
    return shortestGap(parseWhenText(v)) < 300 ? 'It can look no more often than every 5 minutes.' : undefined;
  } catch (e) {
    return e.message;
  }
}
const hasCalendar = () => connected().calendar;

// The questions, as data: the same setup runs in a terminal, with options, and in the bot
// under /setup. "Things I need to do" is a watch, so its questions are the watch plugin's
// (`bc watch setup`); reminders keep the one that is theirs, the quiet hours.
// Built once every plugin has loaded, so there is a question for each source that is offered.
export const todoForm = () => [
  {
    type: 'note',
    message:
      '"Things I need to do" is the watch that is always there. At the times you choose it reads the messages that arrived since last time and picks out what you need to do or answer: notes to yourself, events with a date, things you said you would do, questions waiting for your reply, payments and deadlines. They appear in the daily briefing, with a nudge when each is due.',
  },
  { id: 'auto', type: 'confirm', message: 'Pick up things you need to do from your messages?', default: () => current().auto || true },
  {
    id: 'scan',
    type: 'text',
    when: (a) => a.auto,
    message: 'When should it look? A length (1h), times of day, comma-separated (08:00, 20:00), or a cron expression (0 8,20 * * 1-5)',
    default: () => current().scan,
    validate: (v) => whenProblem(v),
  },
  {
    id: 'chats',
    type: 'select',
    when: (a) => a.auto,
    message: 'Which chats should it look at? (Chats with a watch of their own are always left to that watch.)',
    default: () => (Array.isArray(current().chats) ? 'keep' : current().chats),
    options: () => [
      { value: 'all', label: 'All chats', hint: 'in groups, only things addressed to you' },
      { value: 'direct', label: 'One-to-one chats only', hint: 'no groups' },
      ...(Array.isArray(current().chats) ? [{ value: 'keep', label: `Keep the ${current().chats.length} chats I picked` }] : []),
    ],
  },
  ...optIn().map((src) => ({
    id: src.id,
    type: 'confirm',
    when: (a) => a.auto && !!connected()[src.id],
    message: src.todoQuestion ?? `Also look at ${src.label}?`,
    default: () => todo()?.sources?.[src.id] !== false,
  })),
  {
    id: 'calendar',
    type: 'confirm',
    when: (a) => a.auto && hasCalendar(),
    message: "Include your calendar? (The coming week's events are put on the list as they are, on their day.)",
    default: () => todo()?.sources?.calendar !== false,
  },
  // What it picks up is built in (notes to self, events, things you said you would do, questions
  // waiting for you, deadlines). These two add to that, or keep something out, in your own words.
  {
    id: 'also',
    type: 'text',
    optional: true,
    sticky: true,
    when: (a) => a.auto,
    message:
      'Is there anything else it should pick up? In your own words ("payment requests from the school, even in groups"), or leave it empty',
    default: () => todo()?.sources?.also ?? '',
    help: '"Things I need to do": something more for it to pick up, in your own words',
    validate: (v) => (String(v ?? '').length > 500 ? 'Up to 500 characters.' : undefined),
  },
  {
    id: 'never',
    type: 'text',
    optional: true,
    sticky: true,
    when: (a) => a.auto,
    message: 'Is there anything it should never pick up? ("delivery notifications", "anything from the building group"), or leave it empty',
    default: () => todo()?.sources?.never ?? '',
    help: '"Things I need to do": something it is never to pick up, in your own words',
    validate: (v) => (String(v ?? '').length > 500 ? 'Up to 500 characters.' : undefined),
  },
];

// Set the watch up: on or off, when it looks, where, and whether email is included.
export function applyTodo(a) {
  const stopped = withDb(openWatchDb, (db) => {
    const w = findWatch(db, TODO);
    if (!w) return 'There is nobody to collect for yet: pair a channel (bc channel lists them) or open bc chat once.';
    if (!a.auto) {
      updateWatch(db, w.id, { active: 0 });
      return 'Off: I no longer pick things up from your messages by myself. You can still ask me to set reminders.';
    }
    // Every connected source is read unless you said no here; only a "no" is stored.
    const base = a.chats === 'keep' ? { ...w.sources } : { everywhere: a.chats, mine: true };
    for (const k of [...optIn().map((src) => src.id), 'calendar']) {
      delete base[k];
      const since = `${k}Since`;
      if (a[k] === false) base[k] = false;
      else if (w.sources[since]) base[since] = w.sources[since];
      if (a[k] === false) delete base[since];
    }
    // What it is to pick up besides, and never: as answered; and as it was, where the question was not put.
    for (const k of ['also', 'never']) {
      const text =
        a[k] === undefined
          ? w.sources[k]
          : String(a[k] ?? '')
              .replace(/\s+/g, ' ')
              .trim();
      if (text) base[k] = text;
      else delete base[k];
    }
    updateWatch(db, w.id, { active: 1, scan: { cron: parseWhenText(a.scan) }, sources: base });
    return null;
  });
  if (stopped) return stopped;
  // The choices live with the watch now; the copies reminders used to keep are dropped.
  update((cfg) => {
    const { auto: _a, scan: _s, chats: _c, model: _mo, ...rest } = cfg.reminders ?? {};
    cfg.reminders = rest;
  });
  return `Saved: ${describeTodo()}, read with ${readerModel() ?? "the engine's own choice of model"} (to change it: bc engine setup --for readers).\nWhat it finds appears in the daily briefing, with a nudge when each thing is due. To choose individual chats: bc watch chats (terminal).`;
}

// Picking individual chats needs a tick-list, so this part is terminal only.
export async function pickChats() {
  const p = await import('@clack/prompts');
  const { orExit } = await prompts();
  p.intro(pc.bgYellow(pc.black(' blackcat · chats for "Things I need to do" ')));
  const { listChats, openArchive: open, agoShort: ago } = await import('../internal.js');
  let rows;
  try {
    rows = withDb(open, (db) => listChats(db, { limit: 60 }).filter((r) => r.stored > 0));
  } catch (e) {
    p.cancel(e.message);
    process.exit(1);
  }
  const cur = current();
  const chats = orExit(
    await p.multiselect({
      message: 'Pick chats (most recent first, space to toggle)',
      options: rows.map((r) => ({
        value: r.ref,
        label: r.name,
        hint: [r.isGroup ? 'group' : null, ago(r.last)].filter(Boolean).join(' · '),
      })),
      initialValues: Array.isArray(cur.chats) ? cur.chats.filter((j) => rows.some((r) => r.ref === j)) : [],
      required: true,
      maxItems: 15,
    }),
  );
  withDb(openWatchDb, (wdb) => {
    const w = findWatch(wdb, TODO);
    if (w)
      updateWatch(wdb, w.id, {
        sources: {
          ...Object.fromEntries(Object.entries(w.sources).filter(([k]) => !['everywhere', 'chats', 'mine'].includes(k))),
          chats: chats.map((ref) => ({ ref, name: rows.find((r) => r.ref === ref)?.name ?? ref, sender: null })),
          mine: true,
        },
      });
  });
  p.outro(`Saved: ${describeTodo()}${cur.auto ? '' : ` (it is switched off: ${pc.cyan('bc watch setup')})`}`);
}
