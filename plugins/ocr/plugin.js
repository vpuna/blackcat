// Text in pictures: reads what is written in a picture, on this machine, with Tesseract.
// Nothing is sent anywhere. The archive gives it the pictures that arrive in the chats that
// are collected (src/archive/reading.js), and decides by its score whether the model is
// asked as well.
import fs from 'node:fs';
import { available } from './read.js';
import { sendable, settingsFor } from '../../src/api.js';

const mine = settingsFor(import.meta.url);
const langs = () => {
  const l = mine.get().languages;
  return Array.isArray(l) && l.length ? l : ['eng'];
};
const lib = () => import('./read.js');

export default {
  api: 1,
  name: 'ocr',
  default: true,
  title: 'Text in pictures',
  description: 'reads the text in pictures on this machine, with Tesseract',
  help: `It needs Tesseract, a program of the system's own:   sudo apt install tesseract-ocr
(another language, Arabic say:                            sudo apt install tesseract-ocr-ara)

  bc ocr read <file>      read one picture and say how sure the reading is
  bc ocr setup            which languages to read
  bc msg reading          who reads the pictures that arrive: this machine, the model, both`,

  commands: {
    read: {
      summary: 'read the text in one picture file, and say how sure the reading is (0 to 100)',
      access: 'allow',
      usage: '<file>',
      run: async (ctx, i) => {
        const { readPicture } = await lib();
        if (!available()) ctx.fail('Tesseract is not installed: sudo apt install tesseract-ocr');
        // The agent may only have files read that it could read itself.
        const file = ctx.caller === 'agent' ? sendable(i.file) : fs.existsSync(i.file) ? i.file : null;
        if (!file)
          ctx.fail(`Can't read ${i.file}: it doesn't exist${ctx.caller === 'agent' ? ', or it is outside the folders you may read' : ''}.`);
        const r = await readPicture(file, { langs: langs() });
        if (r.error) ctx.fail(`It could not be read: ${r.error}.`);
        const also = r.extra.length ? `\n(also in the picture, read less surely: ${r.extra.join(' ')})` : '';
        return {
          text: r.words
            ? `${r.text}${also}\n\n(${r.words} different words, sure to ${r.score} of 100, read in ${r.took} s)`
            : `(no text in it · read in ${r.took} s)`,
          data: r,
        };
      },
    },
    setup: {
      summary: 'which languages to read',
      access: () => ({ level: 'ask', describe: 'change which languages are read in pictures' }),
      form: [
        {
          id: 'languages',
          type: 'text',
          message:
            'Which languages should be read in pictures? Three-letter names with + between them (eng, eng+ara). Each one beyond the first makes reading slower, and a language needs its package installed.',
          default: () => langs().join('+'),
          validate: (v) => {
            const want = String(v)
              .split('+')
              .map((s) => s.trim())
              .filter(Boolean);
            if (!want.length || want.some((l) => !/^[a-z_]{3,12}$/i.test(l))) return 'Three-letter names with + between them: eng, eng+ara';
          },
        },
      ],
      run: async (ctx, a) => {
        const { languages } = await lib();
        const want = String(a.languages)
          .split('+')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean);
        const have = available() ? languages() : null;
        const missing = have ? want.filter((l) => !have.includes(l)) : [];
        if (missing.length)
          ctx.fail(
            `Not installed here: ${missing.join(', ')}. (Installed: ${have.join(', ') || 'none'}. Add one with: sudo apt install tesseract-ocr-<name>)`,
          );
        ctx.config.set({ languages: want });
        return `Pictures will be read as ${want.join(' + ')}.${have ? '' : ' Tesseract itself is not installed yet: sudo apt install tesseract-ocr'}`;
      },
    },
  },

  // It reads pictures, on this machine, and says how sure it is. (Not offered where Tesseract is not installed.)
  fileReaders: [
    {
      kind: 'pictures',
      ready: () => available(),
      read: async (_ctx, { file }) => (await lib()).readPicture(file, { langs: langs() }),
    },
  ],

  selftest: () => [
    {
      name: 'Tesseract',
      run: async () => {
        const { languages } = await lib();
        if (!available()) return { skip: 'not installed: sudo apt install tesseract-ocr' };
        return `installed · reads ${languages().join(', ')}`;
      },
    },
  ],

  status: () => {
    return available() ? `ready · reads ${langs().join(' + ')}` : 'Tesseract is not installed → sudo apt install tesseract-ocr';
  },

  settings: () => ({ languages: langs().join(' + ') }),
};
