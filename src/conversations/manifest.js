// The commands for blackcat's record of conversations with the agent. Part of the framework,
// described with a manifest like a plugin. (Continuing one is done where you talk: /resume
// in the bot, `bc chat --resume` in the terminal.)
import { DEFAULTS, counts, settings } from './store.js';
import { update } from '../config.js';

const cmd = () => import('./commands.js');
const KEEP = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: 'a year' },
  { value: '0', label: 'until I delete them' },
];

export default {
  api: 1,
  name: 'conversations',
  title: 'Conversations',
  description: 'your conversations with the agent, kept so they can be listed, read, searched and continued',
  help: `Examples:
  bc conversations list                       recent conversations, from the bot and the terminal
  bc conversations show 12                    what was said in one, with what each turn took
  bc conversations find "school trip"         turns that mention something
  bc chat --resume                            pick one from the terminal and carry on (in the bot: /resume)`,

  commands: {
    list: {
      summary: 'recent conversations, most recently used first',
      access: 'allow',
      options: [
        ['--channel <name>', 'only from one place: terminal, or a channel by name (tg-bot)'],
        ['-n, --limit <n>', 'how many', '15'],
      ],
      run: async (_c, i) => (await cmd()).list(i),
    },
    show: {
      summary: 'what was said in a conversation, with how long each turn took and what it ran',
      access: 'allow',
      usage: '<id>',
      options: [['--last <n>', 'only the last n turns']],
      run: async (_c, i) => (await cmd()).show(i),
    },
    find: {
      summary: 'turns whose question or answer mentions something, newest first, with what each took',
      access: 'allow',
      usage: '<text...>',
      options: [
        ['--since <when>', 'how far back: 24h, 7d'],
        ['-n, --limit <n>', 'how many', '8'],
      ],
      run: async (_c, i) => (await cmd()).find(i),
    },
    setup: {
      summary: 'whether conversations are kept, and for how long',
      access: () => ({ level: 'ask', describe: 'change whether blackcat keeps your conversations with it' }),
      form: [
        {
          type: 'note',
          message:
            'blackcat can keep what you and it say to each other: every question and every reply. That is what lets you list past conversations, read them, continue one later (/resume), and ask why a particular answer was slow. They are stored on this machine, in the same database as your reminders, and so they are in your backups: turn backup encryption on if it is not (bc backup setup).',
        },
        { id: 'on', type: 'confirm', message: 'Keep conversations?', default: () => settings().on },
        {
          id: 'days',
          type: 'select',
          when: (a) => a.on,
          message: 'For how long after a conversation was last used?',
          default: () => String(settings().days),
          options: KEEP,
        },
        {
          id: 'summary',
          type: 'confirm',
          when: (a) => a.on,
          message:
            'When a long conversation is continued from this record, summarise the part too long to hand over whole? (A reader, with no tools, writes it once; without this, only the latest part is handed over.)',
          default: () => settings().summary !== false,
        },
      ],
      run: async (_c, a) => {
        const next = a.on
          ? { on: true, days: a.days == null ? DEFAULTS.days : Number(a.days), summary: a.summary !== false }
          : { ...settings(), on: false };
        update((cfg) => {
          cfg.conversations = next;
        });
        return a.on
          ? `Saved: conversations are kept ${next.days ? `for ${next.days} days after they were last used` : 'until you delete them'}.`
          : 'New conversations are no longer kept. What was kept so far is still there (bc conversations clear deletes it).';
      },
    },
    forget: {
      summary: 'delete one conversation',
      access: 'owner',
      usage: '<id>',
      run: async (_c, i) => (await cmd()).forget(i),
    },
    clear: {
      summary: 'delete every conversation that was kept',
      access: 'owner',
      run: async () => (await cmd()).clear(),
    },
  },

  status: () => {
    const s = settings();
    const c = counts();
    return s.on
      ? `${c.conversations} conversation${c.conversations === 1 ? '' : 's'} kept (${c.turns} turns)`
      : `off${c.conversations ? ` · ${c.conversations} kept from before` : ''} (bc conversations setup)`;
  },
  settings: () => {
    const s = settings();
    return s.on
      ? {
          keeping: 'every question and reply',
          'kept for': s.days ? `${s.days} days after a conversation was last used` : 'until you delete them',
          'kept in': 'agent.db, on this machine (and in your backups)',
        }
      : { keeping: 'nothing new' };
  },

  // For `bc engine check`: what the owner might say, and the command it should lead to.
  checks: [{ say: 'yesterday i asked you about the school trip and it took ages, why?', expect: /blackcat conversations find\b.*trip/i }],
};
