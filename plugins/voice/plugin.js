// Voice: turn speech into text on this machine, so you can talk to the bot and the agent
// can read voice notes. Nothing is sent anywhere: the model runs on this machine.
import fs from 'node:fs';
import { MODELS, voiceSettings } from './transcribe.js';
import { dataPath, reading, sendable, setReading } from '../../src/api.js';

const LANGUAGES = [
  ['english', 'English'],
  ['auto', 'Work it out (less reliable with the smaller models)'],
  ['hindi', 'Hindi'],
  ['telugu', 'Telugu'],
  ['malayalam', 'Malayalam'],
  ['arabic', 'Arabic'],
];

export default {
  api: 1,
  name: 'voice',
  default: true,
  title: 'Voice',
  description: 'voice notes are transcribed on this machine: send one to the bot instead of typing, or have one from your messages read',
  help: `Examples:
  bc voice transcribe ~/blackcat/data/inbox/voice.ogg
  bc voice setup          which model (speed against accuracy), which language, and whether
                          voice notes in your chats are written down`,

  commands: {
    transcribe: {
      summary: 'turn an audio file (a voice note, a recording) into text',
      access: 'allow',
      usage: '<file>',
      options: [
        ['--model <name>', 'tiny, base or small (default: the one chosen in setup)'],
        ['--language <name>', 'english, auto, hindi, …'],
      ],
      run: async (ctx, i) => {
        // The agent may only have files read that it could read itself.
        const file = ctx.caller === 'agent' ? sendable(i.file) : fs.existsSync(i.file) ? i.file : null;
        if (!file)
          ctx.fail(`Can't read ${i.file}: it doesn't exist${ctx.caller === 'agent' ? ', or it is outside the folders you may read' : ''}.`);
        const { transcribe } = await import('./transcribe.js');
        const r = await transcribe(file, { ...(i.model ? { model: i.model } : {}), ...(i.language ? { language: i.language } : {}) }).catch(
          (e) => ctx.fail(e.message),
        );
        return {
          text: `${r.text || '(nothing was said)'}\n\n(${r.seconds}s of audio, transcribed in ${r.took}s with the ${r.model} model)`,
          data: r,
        };
      },
    },

    setup: {
      summary:
        'which model to use (speed against accuracy), which language you speak, and whether voice notes in your chats are written down',
      // A preference, not a connection or a permission: the agent may change it when you ask, with your say each time.
      access: () => ({ level: 'ask', describe: 'change how voice notes are transcribed' }),
      form: [
        {
          id: 'model',
          type: 'select',
          message: 'Which model? Larger ones are more accurate and slower.',
          default: () => voiceSettings().model,
          options: Object.entries(MODELS).map(([value, m]) => ({ value, label: value, hint: m.hint })),
        },
        {
          id: 'language',
          type: 'select',
          message: 'Which language do you speak in voice notes?',
          default: () => voiceSettings().language,
          options: LANGUAGES.map(([value, label]) => ({ value, label })),
        },
        {
          // The same switch as `bc msg reading --voice`: asked here so that it is a choice made at setup.
          id: 'chats',
          type: 'confirm',
          sticky: true,
          message:
            'Write down the voice notes in the chats you collect, as they arrive? A search then finds what was said and your watches read it. (Voice notes you send to the bot are transcribed either way.)',
          help: 'write down the voice notes in collected chats as they arrive; --no-chats: leave them without words (the same as: bc msg reading --voice both|off)',
          default: () => reading('voice').mode !== 'off',
        },
      ],
      run: (ctx, a) => {
        ctx.config.set({ model: a.model, language: a.language });
        if (a.chats !== (reading('voice').mode !== 'off')) setReading('voice', { mode: a.chats ? 'both' : 'off' });
        return `Voice notes will be transcribed with the ${a.model} model, as ${a.language === 'auto' ? 'whatever language is spoken' : a.language}. The model is downloaded the first time it is used.\n${
          a.chats
            ? 'Voice notes in the chats you collect are written down as they arrive.'
            : 'Voice notes in the chats you collect are kept without their words: nothing listens to them (change it: bc msg reading --voice both).'
        }`;
      },
    },
  },

  // It reads voice notes, on this machine: the ones that arrive in the chats that are collected
  // (given to it by the archive, src/archive/reading.js), and the ones the owner sends to
  // blackcat. The work is done in a helper process that keeps the model loaded between notes.
  // → { text, seconds, took, score? } or { error }
  fileReaders: [
    {
      kind: 'voice',
      read: async (_ctx, { file }) => (await import('./client.js')).transcribeFile(file),
      stop: async () => (await import('./client.js')).stopVoice(),
    },
  ],

  // How it is doing: can it transcribe right now, and is the model in memory?
  // `bc selftest`: is the model it listens with on this machine. (Nothing is transcribed.)
  selftest: () => [
    {
      name: `the ${voiceSettings().model} model`,
      run: () => {
        const v = voiceSettings();
        const id = (MODELS[v.model] ?? { id: v.model }).id;
        return fs.existsSync(dataPath('models', id))
          ? `downloaded · ${v.language}`
          : { skip: 'not downloaded yet: it is fetched with the first voice note' };
      },
    },
  ],

  status: async (ctx) => {
    const v = voiceSettings();
    const id = (MODELS[v.model] ?? { id: v.model }).id;
    const have = fs.existsSync(dataPath('models', id));
    // (This installation's own helper: another blackcat on the machine may have one running too.)
    const found = await ctx.exec('pgrep', ['-f', 'plugins/voice/worker.js']);
    const mine = process.env.BLACKCAT_HOME ?? '';
    const homeOf = (pid) => {
      try {
        const env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
        return env.find((e) => e.startsWith('BLACKCAT_HOME='))?.slice('BLACKCAT_HOME='.length) ?? '';
      } catch {
        return null;
      }
    };
    const helper =
      found.code === 0 &&
      String(found.stdout ?? '')
        .split('\n')
        .filter(Boolean)
        .some((pid) => homeOf(pid) === mine);
    return `${have ? 'ready' : 'ready after a one-time download of the model'} · ${helper ? 'the model is loaded (it stays for 15 minutes after a voice note)' : 'the model is not loaded (it loads with the next voice note)'}`;
  },

  settings: () => {
    const v = voiceSettings();
    return { model: `${v.model} (${(MODELS[v.model] ?? { hint: 'set by hand' }).hint})`, language: v.language, threads: v.threads };
  },
};
