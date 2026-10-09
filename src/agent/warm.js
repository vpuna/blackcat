// Commands without the wait. Every `blackcat …` command the agent runs is a new process,
// and on a small machine a process needs a few hundred milliseconds to load before it does
// anything. So the agent service keeps one process loaded and waiting. When the agent runs
// a command, bin/bc.js hands it to that process instead of loading everything again, and a
// fresh one is started for next time.
//
// Each waiting process runs exactly one command and ends, so nothing carries over from one
// command to the next. It is only ever used for the agent's commands (the agent service and
// its spare are the same code, started together); a command you type always starts afresh.
// If no spare is ready (two commands at once, or it is still loading) the command simply
// starts the ordinary way. Turn it off with "fastCommands": false in config.json.
import { fork } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE, DATA, load } from '../config.js';
import { log } from '../log.js';

export const SOCKET = path.join(DATA, 'run', 'commands.sock');
const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'warm-worker.js');
const MAX_AGE_MS = 10 * 60_000; // a spare older than this is replaced, so it never holds on to anything stale
const REQUEST_BYTES = 256 * 1024;

const configStamp = () => {
  try {
    return fs.statSync(CONFIG_FILE).mtimeMs;
  } catch {
    return 0;
  }
};

export function startWarm() {
  if (load().fastCommands === false) return { stop() {} };
  let spare = null; // { child, ready, born, stamp }
  let stopped = false;
  let timer = null;
  const stats = { handed: 0, declined: 0 };

  function spawnSpare() {
    if (stopped || spare) return;
    // In a process group of its own, so that if its caller goes away mid-command, the command
    // and whatever it started (ssh, a shell step) can be stopped together.
    const child = fork(WORKER, [], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      detached: true,
      env: { ...process.env, BLACKCAT_CALLER: 'agent' },
    });
    const mine = { child, ready: false, born: Date.now(), stamp: configStamp() };
    spare = mine;
    child.on('message', (m) => {
      // The settings as they were once it had loaded (loading can itself tidy the settings file).
      if (m === 'ready') ((mine.stamp = configStamp()), (mine.ready = true));
    });
    child.on('error', () => {});
    child.on('exit', () => {
      if (spare !== mine) return;
      // It ended before it was used (it failed to load): try again, but not in a tight loop.
      spare = null;
      if (!stopped) setTimeout(spawnSpare, 5000).unref();
    });
  }
  function retire() {
    const old = spare;
    spare = null;
    try {
      old?.child.kill();
    } catch {}
  }

  const server = net.createServer({ pauseOnConnect: true }, (sock) => {
    sock.on('error', () => {});
    const decline = () => {
      stats.declined++;
      sock.end('F');
    };
    // Settings changed since the spare loaded (a plugin switched on, a shortcut added): it may
    // not know the command. Start a new one, and let this command start the ordinary way.
    if (spare && spare.stamp !== configStamp()) {
      retire();
      spawnSpare();
    }
    if (!spare?.ready) return decline();
    const taken = spare;
    spare = null;
    // The connection itself is handed over: from here the command talks to the caller directly.
    taken.child.send('job', sock, (err) => {
      if (err) {
        try {
          taken.child.kill();
        } catch {}
        sock.destroy();
      } else stats.handed++;
      taken.child.disconnect?.();
    });
    spawnSpare();
    return undefined;
  });
  server.on('error', (e) => log(`fast commands are off: ${e.message}`));

  fs.mkdirSync(path.dirname(SOCKET), { recursive: true, mode: 0o700 });
  fs.rmSync(SOCKET, { force: true });
  const mask = process.umask(0o077); // the socket is this user's only, from the moment it exists
  server.listen(SOCKET, () => {
    process.umask(mask);
    spawnSpare();
    timer = setInterval(() => {
      if (spare && Date.now() - spare.born > MAX_AGE_MS) {
        retire();
        spawnSpare();
      }
    }, 60_000);
    timer.unref();
  });

  return {
    stats,
    ready: () => !!spare?.ready,
    stop() {
      stopped = true;
      clearInterval(timer);
      retire();
      server.close();
      fs.rmSync(SOCKET, { force: true });
    },
  };
}
export { REQUEST_BYTES };
