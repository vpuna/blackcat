// The commands for choosing what runs the model. Part of the framework, described with a
// manifest like a plugin. The engines themselves are plugins (see registry.js here).
import { ROLES, choicesOf, engineName, enginePlugins, optionsFor, stored } from './registry.js';

const cmd = () => import('./commands.js');
const FOR = [
  { value: 'chat', label: 'The agent you talk to' },
  { value: 'readers', label: 'The background readers', hint: 'they go through messages, mail and files, with no tools' },
];
const DEFAULT = '(default)';
const OTHER = 'other';

// The questions for `set`, built from what the engines say can be chosen. An option of an
// engine is asked only when that engine is the one the role uses.
function setForm() {
  const steps = [
    {
      id: 'for',
      type: 'select',
      message: 'Set it for which?',
      default: 'chat',
      options: FOR,
      help: 'which one this is for: chat (the agent you talk to) or readers (the background readers)',
    },
    // (Left out, the model stays as it is, like any option: `--for chat --effort high` changes only that.)
    {
      id: 'model',
      type: 'select',
      message: 'Which model?',
      sticky: true,
      help: 'a model the engine lists (bc engine status), "(default)" for the engine\'s own choice, or other with --name. Left out, it stays as it is',
      default: (a) => {
        const now = stored(a.for).model;
        return !now ? DEFAULT : choicesOf(engineName(a.for)).models.some((m) => m.id === now) ? now : OTHER;
      },
      options: (a) => {
        const c = choicesOf(engineName(a.for));
        const def = c.defaults?.[a.for]?.model;
        return [
          { value: DEFAULT, label: `Leave it to ${c.label}`, hint: def ? `it uses ${def}` : 'whatever it uses when nothing is chosen' },
          ...c.models.map((m) => ({ value: m.id, label: m.label ?? m.id, hint: m.hint })),
          { value: OTHER, label: 'Another one, by name', hint: 'any model the engine can reach' },
        ];
      },
    },
    {
      id: 'name',
      type: 'text',
      when: (a) => a.model === OTHER,
      message: 'Its name, exactly as the engine knows it',
      sticky: true,
      help: "with --model other: the model's name, exactly as the engine knows it",
      default: (a) => stored(a.for).model ?? '',
      validate: (v) =>
        /^[\w.:/@\-[\]]{1,120}$/.test(String(v ?? '').trim()) ? undefined : 'A model name: letters, digits and . : / - _ only',
    },
  ];
  const seen = new Set();
  for (const p of enginePlugins()) {
    for (const o of choicesOf(p.name).options) {
      if (seen.has(o.id)) continue; // two engines with an option of the same name share the question
      seen.add(o.id);
      // Asked only when the engine the role uses has it, and it applies to that role.
      const of = (a) => optionsFor(engineName(a.for), a.for).find((x) => x.id === o.id);
      const usual = (a) => choicesOf(engineName(a.for)).defaults[a.for]?.options?.[o.id];
      steps.push({
        id: o.id,
        type: 'select',
        when: (a) => !!of(a),
        sticky: true, // left out, it stays as it is
        help: `${o.label ?? o.id}: ${o.values.join(', ')}, or "(default)"${o.roles ? ` (${o.roles.join(', ')} only)` : ''}. Left out, it stays as it is`,
        message: (a) => `${of(a)?.label ?? o.id}?`,
        default: (a) => stored(a.for).options?.[o.id] ?? DEFAULT,
        options: (a) => [
          { value: DEFAULT, label: 'Leave it to the engine', hint: usual(a) ? `it uses ${usual(a)}` : of(a)?.hint },
          ...(of(a)?.choices ?? []).map((c) => ({ value: c.value, label: c.label, hint: c.hint })),
        ],
      });
    }
  }
  return steps;
}

export default {
  api: 1,
  name: 'engine',
  title: 'Engine',
  description:
    'what runs the model, for the agent you talk to and for the background readers: which engine, which model, how hard it thinks',
  help: `Examples:
  bc engine status                              what is in use, and what can be chosen
  bc engine setup                               choose the model (and options) for the chat or the readers
  bc engine setup --for readers --model haiku   the readers only; the chat is not touched
  bc engine setup --for chat --model opus --effort high
  bc engine setup --for chat --model other --name qwen3:14b     any model the engine can reach
  bc engine setup --for chat --model "(default)" --effort "(default)"   back to the engine's own choice
  bc engine setup --for chat --tools blackcat   whose tools the agent works with (yours alone to change)

The chat and the readers are set separately. An option that is left out stays as it is.
A change for the chat is taken up by your next message; for the readers, by the next thing
they read. After a change, what was checked no longer stands: bc engine check
  bc engine check                             check what is in use: security, accuracy, speed; then you decide
  bc engine use <name>                        a different engine: checked first (in a terminal only)`,

  commands: {
    status: {
      summary: 'which engine and model the chat and the readers use, whether it is ready, and what can be chosen',
      access: 'allow',
      run: async (_c, i) => (await cmd()).show(i),
    },
    setup: {
      summary: 'choose the model, and options such as how hard it thinks, for the chat or for the readers',
      // The model and how hard it thinks may be changed by the agent with the owner's say.
      // Whose tools it works with, and who is in charge of each call, is the owner's alone:
      // it is what the safeguards rest on, and must not ride along with a change of model.
      access: (_ctx, tokens) =>
        tokens.some((t) => /^--tools(=|$)/.test(t))
          ? { level: 'owner', reason: 'whose tools the agent works with is changed by the owner, from a terminal or /setup' }
          : { level: 'ask', describe: 'change which model blackcat uses' },
      form: setForm,
      run: async (_c, a) => (await cmd()).set(a, { DEFAULT, OTHER }),
    },
    check: {
      summary:
        'check what is in use for security, accuracy and speed, in a temporary copy with made-up messages; you decide whether to accept what it shows',
      access: 'owner',
      // It takes minutes: typed in the chat, it runs beside the conversation and can be stopped.
      long: true,
      options: [
        ['--for <which>', `${ROLES.join(', ')} or both`, 'both'],
        ['--quick', 'one request for each plugin instead of all of them'],
        ['--yes', 'start without asking'],
      ],
      run: async (c, i) => (await cmd()).check(i, (m) => c.fail(m)),
    },
    accept: {
      summary: 'accept the last check for what is in use (one that found a broken safeguard can only be accepted in a terminal)',
      access: 'owner',
      options: [['--for <which>', `${ROLES.join(', ')} or both`, 'both']],
      run: async (c, i) => (await cmd()).accept(i, (m) => c.fail(m)),
    },
    use: {
      summary: 'use a different engine for the chat, the readers or both: it is checked first, and starts from its own defaults',
      access: 'owner',
      usage: '<name>',
      options: [
        ['--for <which>', `${ROLES.join(', ')} or both`, 'both'],
        ['--no-check', 'switch without checking it first'],
      ],
      run: async (c, i) => (await cmd()).use(i, (m) => c.fail(m)),
    },
    'check-run': {
      summary: 'the run of a check, inside its temporary copy (started by `check`)',
      access: 'owner',
      hidden: true,
      usage: '<file>',
      run: async (_c, i) => {
        await (await import('./check/run.js')).fromFile(i.file);
        return '';
      },
    },
  },

  // For `bc engine check`: what the owner might say, and the command it should lead to.
  checks: [
    { say: 'which model do the background readers use, and has it been checked?', expect: /blackcat engine status\b/ },
    { say: 'whats 17 times 23', never: /./ }, // nothing to look up: no command at all
  ],
  status: () => ROLES.map((r) => `${r}: ${engineName(r)}${stored(r).model ? ` (${stored(r).model})` : ''}`).join(' · '),
  // A check that was killed leaves its temporary copy behind: it is cleared the next time blackcat starts a check.
};
