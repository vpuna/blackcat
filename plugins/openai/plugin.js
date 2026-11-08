// A model that speaks the OpenAI chat API as blackcat's engine: llama.cpp, Ollama, vLLM and
// LM Studio on this network, or a hosted one (OpenRouter, OpenAI, Mistral, Groq, DeepSeek…).
// blackcat holds the conversation itself (run.js); the model is given blackcat's own tools,
// so every call it asks for is judged and carried out by blackcat. In beta.
import { settingsFor } from '../../src/api.js';

const run = () => import('./run.js');
const mine = settingsFor(import.meta.url);
const address = (v) => (/^https?:\/\/\S+$/.test(String(v ?? '').trim()) ? undefined : 'An address like http://192.168.1.20:8000/v1');

export default {
  api: 1,
  name: 'openai',
  title: 'OpenAI-compatible model (beta)',
  description:
    'the engine for a model that speaks the OpenAI API: llama.cpp, Ollama, vLLM or LM Studio on your network, or a hosted one such as OpenRouter',
  help: `Examples:
  bc openai setup                          the address of the model, and its key if it needs one
  bc engine use openai --for readers       try it for the readers (it is checked first)
  bc engine setup --for readers            choose the model, and whether it thinks first`,

  commands: {
    setup: {
      summary: 'where the model is: its address, its key, how much it can hold',
      access: 'owner',
      form: [
        {
          type: 'note',
          message:
            'The address is where the OpenAI API is served, ending in /v1 (llama.cpp: http://<machine>:<port>/v1; OpenRouter: https://openrouter.ai/api/v1).',
        },
        { id: 'endpoint', type: 'text', message: 'Address', default: (a, ctx) => ctx.config.get().endpoint ?? '', validate: address },
        { id: 'key', type: 'secret', message: 'Its key, if it needs one', optional: true, keep: true },
        {
          id: 'context',
          type: 'text',
          message: 'How many tokens it can hold (empty: ask the server, where it says)',
          default: (a, ctx) => ctx.config.get().context ?? '',
          optional: true,
          validate: (v) => (!String(v ?? '').trim() || Number(v) >= 4096 ? undefined : 'A number of tokens: 32768, say'),
        },
        {
          id: 'atOnce',
          type: 'text',
          message: 'How many requests it can answer at once (1 for a model on one graphics card)',
          default: (a, ctx) => ctx.config.get().atOnce ?? 1,
          validate: (v) => (Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 8 ? undefined : 'From 1 to 8'),
        },
        {
          id: 'pictures',
          type: 'confirm',
          message: 'Can the model see pictures?',
          default: (a, ctx) => ctx.config.get().pictures ?? false,
        },
      ],
      run: async (ctx, a) => {
        const r = await run();
        ctx.config.set({ endpoint: String(a.endpoint).trim().replace(/\/+$/, '') });
        if (String(a.key ?? '').trim()) ctx.secrets.set('key', String(a.key).trim());
        const ready = await r.ready(ctx);
        const context = Number(a.context) || (await r.contextOf(ctx)) || undefined;
        // (What it serves is kept, to be offered by name in bc engine setup.)
        const models = await r.models(ctx);
        ctx.config.set({ context, atOnce: Number(a.atOnce) || 1, pictures: !!a.pictures, models: models.length ? models : undefined });
        return [
          ready.ok ? `It answers: ${ready.detail}.` : `It does not answer yet: ${ready.why}`,
          context
            ? `It holds ${context} tokens.`
            : 'How much it holds is not known: a long conversation is not shortened before it is sent.',
          'Try it: bc engine use openai --for readers',
        ].join('\n');
      },
    },
  },

  engine: {
    label: 'OpenAI-compatible (beta)',
    takes: () => (mine.get().pictures ? ['pictures'] : []),
    choices: (ctx) => ({
      models: (ctx.config.get().models ?? []).map((id) => ({ id, label: id })),
      options: [
        {
          id: 'thinking',
          label: 'Whether it thinks before answering (llama.cpp and vLLM; leave unset for other servers)',
          values: [
            { value: 'off', label: 'off', hint: 'answers straight away: quicker, and enough for most models' },
            { value: 'on', label: 'on', hint: 'thinks first: slower' },
          ],
        },
      ],
      defaults: {},
    }),
    ready: async (ctx) => (await run()).ready(ctx),
    converse: async (ctx, spec, on) => (await run()).converse(ctx, spec, on),
    ask: async (ctx, spec) => (await run()).ask(ctx, spec),
    // It can be held to a JSON schema (the server's response_format).
    shapes: true,
    has: async (ctx, sessionId) => (await run()).has(ctx, sessionId),
    forget: async (ctx, workdir) => (await run()).forget(ctx, workdir),
    where: (ctx) => ctx.config.get().endpoint ?? 'not set up',
    // How the check paces itself: a model on one card answers one request at a time, slowly.
    pace: (ctx) => ({ atOnce: ctx.config.get().atOnce ?? 1, caseMs: 10 * 60_000 }),
  },

  status: (ctx) => `the model is at: ${ctx.config.get().endpoint ?? 'not set up (bc openai setup)'}`,
  settings: (ctx) => ({
    'the model is at': ctx.config.get().endpoint ?? 'not set up',
    key: ctx.secrets.has('key') ? 'saved' : 'none',
    holds: ctx.config.get().context ? `${ctx.config.get().context} tokens` : 'not known',
    'at once': ctx.config.get().atOnce ?? 1,
    pictures: ctx.config.get().pictures ? 'yes' : 'no',
  }),
};
