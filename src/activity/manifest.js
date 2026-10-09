// The activity record's own commands: what blackcat did and what it used. Part of the
// framework, described with a manifest like a plugin so its commands, its settings and the
// agent's instructions are wired up by the same machinery.
import { DEFAULTS, KINDS, counts, settings } from './log.js';
import { update } from '../config.js';

const cmd = () => import('./commands.js');
const KEEP = [
  { value: '7', label: 'a week' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: 'a year' },
];
const DETAIL = [
  { value: 'auto', label: 'In full when it needed your say, was refused or failed; otherwise just what was run' },
  { value: 'full', label: "Always in full (your questions often appear in a command's arguments)" },
  { value: 'short', label: 'Never in full: only what was run' },
  { value: 'off', label: "Don't record commands at all" },
];

export default {
  api: 1,
  name: 'activity',
  title: 'Activity',
  description:
    'a record of what blackcat did and what it used: every call to the model with its tokens, each command the agent ran, scheduled work',
  help: `Examples:
  bc activity recent                          the last things that happened
  bc activity recent --kind command --since 24h
  bc activity recent --failed
  bc activity usage                           what used the model this week, by what it was for
  bc activity usage --days 30 --by model
  bc activity usage --by day`,

  commands: {
    recent: {
      summary: 'what happened lately: calls to the model, commands the agent ran, scheduled work, events',
      access: 'allow',
      untrusted: false,
      options: [
        ['--kind <kind>', `only one kind: ${KINDS.join(', ')}`],
        ['--category <text>', 'only entries whose category contains this ("watch", "msg", "chat")'],
        ['--since <when>', 'how far back: 2h, 24h, 7d'],
        ['--failed', 'only what failed or was refused'],
        ['-n, --limit <n>', 'how many', '30'],
      ],
      run: async (_c, i) => (await cmd()).recent(i),
    },
    usage: {
      summary: 'what used the model, in tokens and cost: by what it was for, by model, or by day',
      access: 'allow',
      untrusted: false,
      options: [
        ['--since <when>', 'how far back: 24h, 7d, 30d (default 7d, today included)'],
        ['--days <n>', 'the same, in days'],
        ['--by <what>', 'category (default), model, day or kind', 'category'],
      ],
      run: async (_c, i) => (await cmd()).usage(i),
    },
    setup: {
      summary: 'what is recorded and for how long',
      access: () => ({ level: 'ask', describe: 'change what blackcat records about its own activity' }),
      form: [
        {
          type: 'note',
          message:
            'blackcat keeps a record of what it did and what it used: each call to the model (tokens, model, time), each command the agent ran, scheduled work that did something. It never records what was said: not your messages, not the replies, not what a search found.',
        },
        { id: 'on', type: 'confirm', message: 'Keep the record?', default: () => settings().on },
        {
          id: 'days',
          type: 'select',
          when: (a) => a.on,
          message: 'How long to keep the entries? (Daily totals are kept for a year.)',
          default: () => String(settings().days),
          options: KEEP,
        },
        {
          id: 'commands',
          type: 'select',
          when: (a) => a.on,
          message: 'How much of each command the agent runs to keep?',
          default: () => settings().commands,
          options: DETAIL,
        },
        {
          id: 'cost',
          type: 'confirm',
          when: (a) => a.on,
          message: 'Show cost in dollars? (It is the list price of each call, a measure of how much of your plan it used, not a charge.)',
          default: () => settings().cost,
        },
      ],
      run: async (_c, a) => {
        const next = a.on
          ? { on: true, days: Number(a.days) || DEFAULTS.days, commands: a.commands ?? DEFAULTS.commands, cost: a.cost !== false }
          : { ...settings(), on: false };
        update((cfg) => {
          cfg.activity = next;
        });
        return a.on
          ? `Saved: entries are kept for ${next.days} days; commands ${{ auto: 'in full when they matter', full: 'always in full', short: 'never in full', off: 'not recorded' }[next.commands]}.`
          : 'The record is off. What was recorded so far is kept until it ages out (or bc activity clear).';
      },
    },
    clear: {
      summary: 'delete the whole record',
      access: 'owner',
      run: async () => (await cmd()).clear(),
    },
  },

  status: () => {
    const s = settings();
    if (!s.on) return 'off (bc activity setup)';
    const c = counts();
    const calls = c.today.find((t) => t.kind === 'model');
    const commands = c.today.find((t) => t.kind === 'command');
    return `today: ${calls?.n ?? 0} call${calls?.n === 1 ? '' : 's'} to the model${calls && s.cost ? ` ($${calls.cost.toFixed(2)} at list price)` : ''} · ${commands?.n ?? 0} command${commands?.n === 1 ? '' : 's'} run by the agent · ${c.entries} entries kept`;
  },
  settings: () => {
    const s = settings();
    return s.on
      ? {
          recording: 'on',
          'entries kept for': `${s.days} days`,
          'daily totals kept for': `${s.totalsDays} days`,
          'commands the agent runs': {
            auto: 'in full when they needed your say, were refused or failed',
            full: 'always in full',
            short: 'never in full',
            off: 'not recorded',
          }[s.commands],
          'cost shown': s.cost ? 'yes, at list price' : 'no',
          'never recorded': 'what was said: messages, replies, search results',
        }
      : { recording: 'off' };
  },

  // For `bc engine check`: what the owner might say, and the command it should lead to.
  checks: [
    { say: 'what did you run to answer my last question', expect: /blackcat activity recent\b/ },
    { say: 'did my briefing go out this morning', expect: /blackcat activity recent\b.*--kind sent\b/ },
    { say: 'what have i changed about what you are allowed to do this week', expect: /blackcat activity recent\b.*--kind owner\b/ },
  ],
};
