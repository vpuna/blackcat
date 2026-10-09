// Claude Code as blackcat's engine: what runs the model. It holds the conversation, passes
// what the model asks to do to blackcat (whose policy decides), and reports what was used.
// It decides nothing about what the agent may do: that is blackcat's, whatever the engine.
const run = () => import('./run.js');
// What Claude Code can be asked for. It cannot be asked to list its models, so the ones it
// answers to by name are listed here; any other name may be typed.
const MODELS = [
  { id: 'opus', label: 'Opus', hint: 'the most capable' },
  { id: 'sonnet', label: 'Sonnet', hint: 'quicker, and enough for most things' },
  { id: 'haiku', label: 'Haiku', hint: 'the lightest' },
];
const EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'];

export default {
  api: 1,
  name: 'claude-code',
  mount: 'claude', // bc claude …, and /claude in the chat
  title: 'Claude Code',
  description: 'the engine that runs the model: Claude Code, under your own Claude plan (or pointed at a model of your choosing)',
  default: true,
  help: `Examples:
  bc engine status            which engine and model the agent and the readers use
  bc engine setup             choose the model and how hard it thinks
  bc claude setup      point Claude Code at a model somewhere else (leave empty for your Claude plan)`,

  commands: {
    setup: {
      summary: 'where the model is: leave empty for your Claude plan, or give the address of a model served somewhere else',
      access: 'owner',
      form: [
        {
          type: 'note',
          message:
            'Claude Code normally uses your Claude plan. It can instead be pointed at a model served somewhere else (on this network, say) that speaks the same protocol. Leave the address empty to use your plan.',
        },
        {
          id: 'endpoint',
          type: 'text',
          message: 'Address of the model (empty: your Claude plan)',
          default: (a, ctx) => ctx.config.get().endpoint ?? '',
          optional: true,
          validate: (v) =>
            !String(v ?? '').trim() || /^https?:\/\/\S+$/.test(String(v).trim()) ? undefined : 'An address like http://192.168.1.20:11434',
        },
        {
          id: 'key',
          type: 'secret',
          message: 'Its key, if it needs one',
          optional: true,
          keep: true,
          when: (a) => !!String(a.endpoint ?? '').trim(),
        },
      ],
      run: (ctx, a) => {
        const endpoint = String(a.endpoint ?? '').trim();
        ctx.config.set({ endpoint: endpoint || undefined });
        if (!endpoint) ctx.secrets.delete('key');
        else if (String(a.key ?? '').trim()) ctx.secrets.set('key', String(a.key).trim());
        return endpoint
          ? `Claude Code will use the model at ${endpoint}. Choose which model with: bc engine setup (any name it serves can be typed). Then restart the agent: bc restart agent`
          : 'Claude Code will use your Claude plan. Restart the agent: bc restart agent';
      },
    },
  },

  engine: {
    label: 'Claude Code',
    // What its processes are called: `bc status` counts the conversations being held by them.
    process: 'claude',
    // What the owner may choose. `models` is a convenience, never a limit: any name may be typed.
    choices: () => ({
      models: MODELS,
      options: [
        { id: 'effort', label: 'How hard it thinks', values: EFFORT, hint: 'more effort is slower and uses more of your plan' },
        // Whose tools the agent works with, and who is in charge of each call (see run.js).
        // Only the agent you talk to has tools: the readers have none, whatever is set.
        {
          id: 'tools',
          label: 'Whose tools the agent works with, and who is in charge of each call',
          roles: ['chat'],
          values: [
            {
              value: 'supervised',
              label: 'supervised',
              hint: "Claude Code's tools; blackcat is asked about every call, and its policy decides. The usual way",
            },
            {
              value: 'blackcat',
              label: 'blackcat',
              hint: "blackcat's own tools: it decides and carries out every call itself, so nothing rests on Claude Code asking. About a fifth of a second slower per step",
            },
            {
              value: 'engine',
              label: 'engine',
              hint: "Claude Code's tools, and it decides when to ask: what it takes to be a plain look, it runs unasked. How it was before",
            },
          ],
        },
      ],
      // What is used until something is chosen: for the chat, whatever the account's default is.
      defaults: { chat: { options: { tools: 'supervised' } }, readers: { model: 'sonnet' } },
    }),
    ready: async (ctx) => (await run()).ready(ctx),
    converse: async (ctx, spec, on) => (await run()).converse(ctx, spec, on),
    ask: async (ctx, spec) => (await run()).ask(ctx, spec),
    // It can hold an answer to a shape (a reader's answer: see src/readers.js).
    shapes: true,
    has: async (ctx, sessionId, workdir) => (await run()).has(sessionId, workdir),
    forget: async (ctx, workdir) => (await run()).forget(workdir),
    ownResult: async (ctx, workdir, file) => (await run()).ownResult(workdir, file),
    // Where the owner's conversation goes: said in `bc engine`, decided by the owner.
    where: (ctx) => ctx.config.get().endpoint ?? 'your Claude plan',
  },

  status: (ctx) => `the model is at: ${ctx.config.get().endpoint ?? 'your Claude plan'}`,
  settings: (ctx) => ({
    'the model is at': ctx.config.get().endpoint ?? 'your Claude plan (signed in with `claude`)',
    key: ctx.secrets.has('key') ? 'saved' : 'none',
  }),
};
