// Text in documents: takes the text out of PDFs, Word files and text files, on this machine.
// Nothing is sent anywhere. The archive gives it the documents that arrive in the chats that
// are collected (src/archive/reading.js); pages that are pictures it hands on, as pictures,
// to whatever reads those.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installed } from './read.js';
import { plural, sendable } from '../../src/api.js';

const lib = () => import('./read.js');

export default {
  api: 1,
  name: 'docs',
  default: true,
  title: 'Text in documents',
  description: 'takes the text out of PDFs, Word files and text files on this machine',
  help: `PDFs need the PDF tools, a package of the system's own:   sudo apt install poppler-utils
Old Word files (.doc) need antiword:                       sudo apt install antiword

  bc docs read <file>     what this machine makes of one document: its text, and which pages
                          are pictures (those are read by whatever reads pictures: bc ocr)
  bc msg reading          who reads the documents that arrive: this machine, the model, both`,

  commands: {
    read: {
      summary: 'take the text out of one document, and say which of its pages are pictures',
      access: 'allow',
      usage: '<file>',
      run: async (ctx, i) => {
        const { readDocument } = await lib();
        // The agent may only have files read that it could read itself.
        const file = ctx.caller === 'agent' ? sendable(i.file) : fs.existsSync(i.file) ? i.file : null;
        if (!file)
          ctx.fail(`Can't read ${i.file}: it doesn't exist${ctx.caller === 'agent' ? ', or it is outside the folders you may read' : ''}.`);
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blackcat-docs-'));
        try {
          const r = await readDocument(file, { name: path.basename(file), tmp });
          if (r.error) ctx.fail(`It could not be read: ${r.error}.`);
          const text = r.parts
            .map((p) =>
              [p.label ? `[${p.label}${p.picture ? (p.text ? ': text, and a large picture' : ': a picture') : ''}]` : null, p.text]
                .filter(Boolean)
                .join('\n'),
            )
            .join('\n\n');
          const pictures = r.parts.filter((p) => p.picture).length;
          return {
            text: `${text || '(no text in it)'}\n\n(${r.pages ? `${plural(r.pages, 'page')}, ` : ''}${pictures} to be read as ${pictures === 1 ? 'a picture' : 'pictures'}${r.cut ? `; ${r.cut}` : ''})`,
            data: {
              pages: r.pages ?? null,
              cut: r.cut ?? null,
              parts: r.parts.map((p) => ({ label: p.label, chars: p.text.length, picture: !!p.picture })),
            },
          };
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      },
    },
  },

  // It reads documents, on this machine. What it gives back is parts: the text of each page,
  // and the pictures (a scanned page, a picture inside a Word file) for a reader of pictures.
  fileReaders: [
    {
      kind: 'documents',
      read: async (_ctx, { file, mime, name, tmp }) => (await lib()).readDocument(file, { mime, name, tmp }),
    },
  ],

  selftest: () => [
    {
      name: 'the PDF tools',
      run: () =>
        installed('pdftotext')
          ? 'installed'
          : { skip: 'not installed: sudo apt install poppler-utils (Word and text files are read without)' },
    },
    {
      name: 'antiword, for old Word files',
      run: () => (installed('antiword') ? 'installed' : { skip: 'not installed: sudo apt install antiword (only .doc files need it)' }),
    },
  ],

  status: () => (installed('pdftotext') ? 'ready' : 'ready for Word and text files; PDFs need: sudo apt install poppler-utils'),
};
