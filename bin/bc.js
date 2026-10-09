#!/usr/bin/env node
// A new process starts for every command: yours, each one the agent runs, each scheduled
// job. Two things here keep that cheap, before anything else is loaded.
//
// 1. Node compiles the code afresh every time unless told to keep the compiled form. The
//    cache holds compiled code only (no data), is private to this user, and Node discards
//    an entry when its file changes.
// 2. A command the agent runs is handed to a process the agent service keeps loaded and
//    waiting (src/agent/warm.js), when one is ready. This file then only passes the output
//    along. Anything else, or any doubt, and the command starts here the ordinary way.
import module from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const home = process.env.BLACKCAT_HOME || path.resolve(fileURLToPath(new URL('..', import.meta.url))); // (as src/config.js has it)
const argv = process.argv.slice(2);

// Not for commands that run for as long as they are left to, or that talk to a terminal.
const LONG = ['chat', 'logs', 'service', 'start', 'stop', 'restart', 'setup'];
const eligible =
  process.env.BLACKCAT_CALLER === 'agent' &&
  !process.env.BLACKCAT_SLOW &&
  argv.length > 0 &&
  !LONG.includes(argv[0]) &&
  !(['wa', 'tg'].includes(argv[0]) && argv.includes('run')) &&
  !process.stdin.isTTY;

// → the command's exit code if the waiting process ran it, or null to run it here.
const handOver = () =>
  new Promise((resolve) => {
    let committed = false;
    let buf = Buffer.alloc(0);
    let code = null;
    const sock = net.createConnection(path.join(home, 'data', 'run', 'commands.sock'));
    // Not there, busy, or slow to answer: don't wait for it.
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(null);
    }, 250);
    sock.on('connect', () => sock.write(`${JSON.stringify({ argv, cwd: process.cwd(), env: process.env })}\n`));
    sock.on('error', () => {
      clearTimeout(timer);
      if (!committed) resolve(null);
    });
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!committed) {
        clearTimeout(timer);
        if (buf[0] !== 0x41) {
          // F, or anything unexpected: it will not run there
          sock.destroy();
          return resolve(null);
        }
        // Accepted. From here it runs there and only there.
        committed = true;
        buf = buf.subarray(1);
        sock.write('G');
      }
      while (buf.length >= 5) {
        const len = buf.readUInt32BE(1);
        if (buf.length < 5 + len) break;
        const body = buf.subarray(5, 5 + len);
        if (buf[0] === 0x4f) process.stdout.write(body);
        else if (buf[0] === 0x45) process.stderr.write(body);
        else if (buf[0] === 0x58) code = Number(body.toString()) || 0;
        buf = buf.subarray(5 + len);
      }
    });
    sock.on('close', () => {
      clearTimeout(timer);
      if (!committed) return resolve(null);
      if (code === null) process.stderr.write('blackcat: the command stopped before it finished.\n');
      return resolve(code ?? 1);
    });
  });

const ran = eligible ? await handOver() : null;
if (ran !== null) process.exitCode = ran;
else {
  try {
    module.enableCompileCache?.(path.join(home, 'data', 'compile-cache'));
  } catch {
    // Without the cache everything still works, a little slower.
  }
  await (await import('../src/main.js')).run();
}
