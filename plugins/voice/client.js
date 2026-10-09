import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../../src/api.js';

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.js');

// Talks to the transcription helper (worker.js), starting it when needed.
let worker = null;
let buf = '';
let seq = 0;
const waiting = new Map(); // id → { resolve, timer }

function start() {
  worker = spawn('nice', ['-n', '10', process.execPath, WORKER], { stdio: ['pipe', 'pipe', 'inherit'] });
  buf = '';
  worker.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const m = JSON.parse(line);
        const w = waiting.get(m.id);
        if (!w) continue;
        clearTimeout(w.timer);
        waiting.delete(m.id);
        w.resolve(m);
      } catch {}
    }
  });
  worker.stdin.on('error', () => {});
  const mine = worker;
  worker.on('close', () => {
    if (worker === mine) worker = null;
    // Whatever was in flight when it stopped gets an answer.
    for (const [id, w] of waiting) {
      clearTimeout(w.timer);
      w.resolve({ id, error: 'the transcription helper stopped' });
    }
    waiting.clear();
  });
  log('voice: transcription helper started');
}

// → { text, seconds, took, model } or { error }
export function transcribeFile(file, { timeoutMs = 10 * 60_000 } = {}) {
  if (!worker) start();
  const id = ++seq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      worker?.kill('SIGTERM');
      resolve({ error: 'it took too long' });
    }, timeoutMs);
    waiting.set(id, { resolve, timer });
    worker.stdin.write(`${JSON.stringify({ id, file })}\n`);
  });
}

export const stopVoice = () => worker?.kill('SIGTERM');
