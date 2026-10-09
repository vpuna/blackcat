// What the agent remembers from one conversation to the next. Part of the framework,
// described with a manifest like a plugin: the same commands for the owner (in a terminal
// or the chat) and for the agent, which is how it saves and forgets.
import { count, get, KINDS } from './store.js';

const cmd = () => import('./commands.js');
const kinds = Object.keys(KINDS).join(', ');

// What the agent would lose from memory is put to the owner first, with what would go.
//   forget    always
//   replace   when there is a memory of that name already and its text is being written
//             over (not added to with --append, and not only its kind or summary changed)
function losing(ctx, tokens, how) {
  if (ctx.caller !== 'agent') return 'allow';
  const name = tokens.find((t) => !t.startsWith('-'));
  const was = name ? get(name) : null;
  if (how === 'forget')
    return { level: 'ask', describe: was ? `forget what I remember as "${name}" (${was.summary})` : 'forget something I remember' };
  const rewrites = tokens.some((t) => t === '--text' || t.startsWith('--text=')) && !tokens.includes('--append');
  return was && rewrites
    ? { level: 'ask', describe: `replace what I remember as "${name}" (${was.summary}) with something else` }
    : 'allow';
}

export default {
  api: 1,
  name: 'memory',
  title: 'Memory',
  description: 'what the agent remembers from one conversation to the next: a few facts you told it, kept by blackcat',
  help: `Examples:
  bc memory list                              everything it remembers
  bc memory show family-and-nicknames         one of them
  bc memory remove family-and-nicknames       make it forget one
  bc memory save coffee --kind user --text "Takes coffee black, no sugar"`,

  // (What comes back is what the owner told the agent, in its own words: it is not marked as
  // content from outside, as other commands' results are.)
  commands: {
    list: {
      summary: 'everything remembered, most recently changed first',
      access: 'allow',
      untrusted: false,
      options: [['--kind <kind>', `only one kind: ${kinds}`]],
      run: async (ctx, i) => (await cmd()).list(i, ctx.fail),
    },
    show: {
      summary: 'one memory, whole',
      access: 'allow',
      untrusted: false,
      usage: '<name>',
      run: async (ctx, i) => (await cmd()).show(i, ctx.fail),
    },
    save: {
      summary: 'remember something, or change a memory there already (what is not given stays as it was)',
      // Remembering something new, or adding to what is remembered, the agent may do by
      // itself. Writing over what is there loses what it said: that is the owner's to allow.
      access: (ctx, tokens) => losing(ctx, tokens, 'replace'),
      untrusted: false,
      usage: '<name>',
      options: [
        ['--kind <kind>', `what it is about: ${kinds}`],
        ['--summary <text>', 'one line saying what it is about'],
        ['--text <text>', 'the fact itself'],
        ['--append', 'add --text to what is there, instead of replacing it'],
      ],
      run: async (ctx, i) => (await cmd()).saveOne(i, ctx.fail, ctx.caller),
    },
    remove: {
      summary: 'forget one memory',
      // Forgetting is the owner's to allow. (What the owner types themselves, in a terminal
      // or as /memory remove … in the chat, is done at once: the asking is for the agent.)
      access: (ctx, tokens) => losing(ctx, tokens, 'forget'),
      untrusted: false,
      usage: '<name>',
      run: async (ctx, i) => (await cmd()).removeOne(i, ctx.fail),
    },
  },

  status: () => {
    const n = count();
    return n ? `${n} thing${n === 1 ? '' : 's'} remembered` : 'nothing remembered yet';
  },
  settings: () => ({ remembered: count(), 'kept in': 'agent.db, on this machine', kinds }),

  // For `bc engine check`: what the owner might say, and the command it should lead to.
  checks: [{ say: 'remember that my dentist is Dr Rao, on Palm Street', expect: /blackcat memory save\b/ }],
};
