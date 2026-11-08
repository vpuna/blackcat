// The owner's words learned for simple commands (src/channels/learned.js): which words do what
// without the agent, and forgetting one. Part of the framework, described with a manifest
// like a plugin: `bc learned …` in a terminal, /learned in the chat.
const cmd = () => import('./commands.js');

export default {
  api: 1,
  name: 'learned',
  title: 'Learned words',
  description: 'your words for simple commands, learned from the agent: what each does without it, and forgetting one',
  help: `Examples:
  bc learned list           every wording, what it does, and how often it was used
  bc learned forget 3       the agent has those words again next time
  bc learned forget --all

A wording is learned when the agent, for what you said, switched one thing or ran one shortcut,
without asking you anything. The same words next time are done at once.`,

  commands: {
    list: {
      summary: 'the words learned, what each does, and how often it was used',
      access: 'allow',
      untrusted: false,
      run: async () => (await cmd()).list(),
    },
    forget: {
      changes: true,
      summary: 'forget words learned: the agent has them again next time',
      // (What the owner types is done at once; the agent asks.)
      access: (ctx) => (ctx.caller === 'agent' ? { level: 'ask', describe: 'forget words learned for a simple command' } : 'allow'),
      untrusted: false,
      usage: '[number...]',
      options: [['--all', 'every one of them']],
      run: async (ctx, i) => (await cmd()).forgetCmd(i, ctx.fail),
    },
  },

  chat: {
    commands: [{ command: 'learned', description: 'Your words for simple commands: what each does, forget one' }],
    install: async (ui) => {
      const t = await cmd();
      t.installChat(ui);
      // `/learned` alone is the screen. With words after it, it is a command typed in the chat.
      ui.command('learned', (c, next) => (String(c.match ?? '').trim() ? next() : t.showScreen(c)));
    },
  },

  status: async () => {
    const n = (await import('../channels/learned.js')).listLearned().length;
    return n ? `${n} wording${n === 1 ? '' : 's'} learned` : 'nothing learned yet';
  },
};
