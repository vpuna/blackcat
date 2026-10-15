// The transcription helper: started by the bot with the first voice note, it keeps the
// speech model loaded and transcribes each file it is given. One JSON line in
// ({ id, file }), one out ({ id, text, … } or { id, error }). It is a separate process so
// that a crash in the model can't take the bot down, and it exits by itself when idle.
import readline from 'node:readline';
import { transcribe } from './transcribe.js';

const IDLE_MS = 15 * 60_000;
let idle = setTimeout(() => process.exit(0), IDLE_MS);
let chain = Promise.resolve(); // one at a time

readline
  .createInterface({ input: process.stdin })
  .on('line', (line) => {
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      return;
    }
    clearTimeout(idle);
    chain = chain.then(async () => {
      let out;
      try {
        out = { id: req.id, ...(await transcribe(req.file)) };
      } catch (e) {
        out = { id: req.id, error: e.message };
      }
      process.stdout.write(`${JSON.stringify(out)}\n`);
      idle = setTimeout(() => process.exit(0), IDLE_MS);
    });
  })
  .on('close', () => process.exit(0));
