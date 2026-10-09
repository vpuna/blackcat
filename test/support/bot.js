// Start the real bot (the agent service's process) against the stand-in Telegram, in a
// scratch installation, for a test to talk to.
import { SIGNED_IN, setUp } from '../helpers.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fakeTelegram } from './telegram.js';

const root = new URL('../..', import.meta.url).pathname;

// `claude`: the body of a stand-in for the `claude` program (a node script), or nothing for
// one that answers every message with "echo: <what it was sent>".
export async function startBot(dir, { config = {}, claude, env = {}, signedIn = true } = {}) {
  const tg = await fakeTelegram();
  const { load } = await import('../../src/config.js');
  await setUp({ ...load(), bot: { token: 'TEST:TOKEN', allow: [{ id: tg.owner.id, name: tg.owner.first_name }] }, ...config });
  fs.mkdirSync(path.join(dir, 'agent'), { recursive: true });
  const script = path.join(dir, 'fake-claude.mjs');
  fs.writeFileSync(script, claude ?? ECHO);
  fs.writeFileSync(path.join(dir, 'fake-bin/claude'), `#!/bin/sh\n${signedIn ? SIGNED_IN : ''}exec ${process.execPath} ${script} "$@"\n`, {
    mode: 0o755,
  });

  const child = spawn(process.execPath, [`${root}bin/bc.js`, 'agent', 'run'], {
    env: { ...process.env, BLACKCAT_TELEGRAM_API: tg.url, BLACKCAT_SLOW: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  // It is up when it has said so.
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`the bot did not start:\n${log}`)), 30_000);
    const look = setInterval(() => {
      if (!/running · paired/.test(log)) return;
      clearInterval(look);
      clearTimeout(t);
      resolve();
    }, 50);
    child.on('exit', (code) => {
      clearInterval(look);
      clearTimeout(t);
      reject(new Error(`the bot ended (${code}):\n${log}`));
    });
  });
  return {
    tg,
    log: () => log,
    async stop() {
      child.kill('SIGTERM');
      await new Promise((r) => child.on('exit', r));
      await tg.close();
    },
  };
}

// Answers each message with "echo: " and its last line.
const ECHO = `
import readline from 'node:readline';
let n = 0;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.type !== 'user') return;
  if (++n === 1) console.log(JSON.stringify({ type: 'system', subtype: 'init' }));
  const text = typeof m.message.content === 'string' ? m.message.content : JSON.stringify(m.message.content);
  console.log(JSON.stringify({ type: 'result', is_error: false, result: 'echo: ' + text.split('\\n').at(-1), session_id: 'sess-' + process.pid, total_cost_usd: 0.01 * n, usage: { input_tokens: 1, output_tokens: 1 } }));
});`;
