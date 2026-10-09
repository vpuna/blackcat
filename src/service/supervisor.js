// blackcat's own supervisor: one process that starts the agent and every service a plugin
// declares, keeps them running, and stops them. It is what runs blackcat on every machine:
// under the one systemd unit on a Raspberry Pi, as the command of a container, or in a
// terminal (`bc service run`).
//
// For each service: started when its plugin is on, it is not switched off, and it is ready
// (a source that is not linked yet waits). Restarted when it dies, a little later each time
// it dies quickly. Exit code 3 means "needs the owner" (logged out, not set up): that one
// is left stopped until it is started by hand. What it prints goes to data/logs/<id>.log.
//
// The rest of blackcat reads data/run/services.json for how things are, and asks for a
// start, stop or restart over data/run/services.sock.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { HOME } from '../config.js';
import {
  CODE_DIR,
  LOG_DIR,
  RUN_DIR,
  SOCKET,
  STATE_FILE,
  bornAt,
  logFile,
  sameProcess,
  services,
  supervisorState,
  switchedOff,
} from './units.js';

// (Shortened in tests, so that a restart or a stubborn stop does not take a minute to see.)
const FAST = !!process.env.BLACKCAT_SUPERVISOR_FAST;
const T = {
  tick: FAST ? 200 : 5000, // how often what should be running is looked at again
  backoff: FAST ? [100, 200, 400, 800] : [1000, 2000, 5000, 15_000, 30_000, 60_000],
  settled: FAST ? 8000 : 60_000, // up this long: the next death starts from the short wait again
  grace: FAST ? 700 : 15_000, // asked to stop: how long before it is killed
  logMax: FAST ? 20_000 : 5 * 1024 ** 2,
};
const now = () => Math.floor(Date.now() / 1000);
const stamp = () => new Date().toISOString();

// What a service prints, into its file: each line with the time if it has none of its own,
// the file started afresh (the one before kept beside it) when it has grown large.
function logTo(id) {
  fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
  const file = logFile(id);
  let rest = '';
  const write = (text) => {
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > T.logMax) fs.renameSync(file, `${file}.1`);
      fs.appendFileSync(file, text, { mode: 0o600 });
    } catch {
      // a full disk must not stop the service itself
    }
  };
  return {
    data(chunk) {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop();
      if (lines.length) write(lines.map((l) => (/^\d{4}-\d\d-\d\dT/.test(l) ? l : `${stamp()} ${l}`)).join('\n') + '\n');
    },
    note: (text) => write(`${stamp()} [blackcat] ${text}\n`),
    end() {
      if (rest) write(`${stamp()} ${rest}\n`);
      rest = '';
    },
  };
}

export async function run() {
  // (A note that names this very process is one left behind: it is we who are starting.)
  if (supervisorState() && supervisorState().pid !== process.pid) {
    console.error(`blackcat is already running here (pid ${supervisorState().pid}). See: bc status`);
    process.exit(1);
  }
  fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
  const mine = logTo('blackcat');
  const say = (text) => (console.log(`${stamp()} ${text}`), mine.note(text));
  // What matters of it is on the activity record too: started, a service that ended by
  // itself, one that needs the owner. (Not every start and stop the owner asked for.)
  const { record } = await import('../activity/log.js');
  const note = (id, summary, ok = true) => {
    try {
      record({ kind: 'event', category: id === 'blackcat' ? 'blackcat' : `service: ${id}`, summary, ok });
    } catch {}
  };
  // What started this, and so what will start it again: said in `bc status`.
  const keeper = process.env.INVOCATION_ID ? 'systemd' : fs.existsSync('/.dockerenv') || process.env.BLACKCAT_KEEPER ? 'container' : null;

  // Anything left by a supervisor that was killed outright: stopped before another is started beside it.
  try {
    const was = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const s of Object.values(was.services ?? {})) {
      // (Only the very process that was noted: its number may be another's by now, even this one's.)
      if (!s.pid || s.pid === process.pid || !sameProcess(s.pid, s.born)) continue;
      let cmd = '';
      try {
        cmd = fs.readFileSync(`/proc/${s.pid}/cmdline`, 'utf8');
      } catch {}
      if (cmd.includes('bin/bc.js')) {
        say(`stopping pid ${s.pid}, left running by a supervisor that ended without stopping it`);
        try {
          process.kill(-s.pid, 'SIGKILL');
        } catch {
          try {
            process.kill(s.pid, 'SIGKILL');
          } catch {}
        }
      }
    }
  } catch {}

  let ticker = null;
  const kids = new Map(); // id → { state, child, pid, since, restarts, why, wait, timer, wanted, log, stopping }
  let quitting = false;
  const write = () => {
    const out = { pid: process.pid, born: bornAt(process.pid), started, home: HOME, keeper, services: {} };
    for (const [id, k] of kids)
      out.services[id] = {
        state: k.state,
        pid: k.pid ?? null,
        born: k.born ?? null,
        since: k.since ?? null,
        restarts: k.restarts,
        why: k.why ?? null,
        summary: k.summary,
      };
    try {
      fs.writeFileSync(`${STATE_FILE}.tmp`, JSON.stringify(out), { mode: 0o600 });
      fs.renameSync(`${STATE_FILE}.tmp`, STATE_FILE);
    } catch {}
  };
  const started = now();
  const set = (k, state, why = null) => {
    k.state = state;
    k.why = why;
    write();
  };

  function start(id, k, svc) {
    clearTimeout(k.timer);
    k.log ??= logTo(id);
    const child = spawn(process.execPath, [path.join(CODE_DIR, 'bin/bc.js'), ...svc.args], {
      cwd: CODE_DIR,
      env: { ...process.env, BLACKCAT_HOME: HOME, BLACKCAT_SERVICE: id },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // a group of its own, so that what it started goes with it
    });
    k.child = child;
    k.pid = child.pid;
    k.born = bornAt(child.pid);
    k.since = now();
    k.stopping = false;
    k.began = Date.now();
    // Whatever else this machine is for comes first.
    try {
      os.setPriority(child.pid, 10);
    } catch {}
    child.stdout.on('data', (d) => k.log.data(String(d)));
    child.stderr.on('data', (d) => k.log.data(String(d)));
    child.on('error', (e) => k.log.note(`could not be started: ${e.message}`));
    child.on('close', (code, signal) => {
      k.log.end();
      k.child = null;
      k.pid = null;
      k.born = null;
      const ran = Date.now() - k.began;
      if (k.stopping || quitting) {
        k.log.note('stopped');
        set(k, 'stopped', 'stopped by you');
        k.done?.();
        return;
      }
      if (code === 3) {
        k.log.note('ended saying it needs you (exit code 3): not started again until you start it');
        say(`${id} needs you: see bc logs ${id}`);
        note(id, 'stopped, and needs you (see its log)', false);
        return set(k, 'needs you', 'it needs you: see its log, put it right, then bc start ' + id);
      }
      if (ran >= T.settled) k.fails = 0;
      const wait = T.backoff[Math.min(k.fails, T.backoff.length - 1)];
      k.fails += 1;
      k.restarts += 1;
      const how = signal ? `was ended by ${signal}` : `ended with code ${code}`;
      k.log.note(`${how} after ${Math.round(ran / 1000)} s: starting it again in ${Math.round(wait / 100) / 10} s`);
      say(`${id} ${how}; again in ${Math.round(wait / 100) / 10} s`);
      note(id, `${how} after ${Math.round(ran / 1000)} s; started again`, false);
      set(k, 'restarting', `${how}; it is started again each time, a little later when it keeps ending`);
      k.timer = setTimeout(() => !quitting && k.wanted && start(id, k, svc), wait);
    });
    k.log.note(`started (pid ${child.pid})`);
    say(`${id} started (pid ${child.pid})`);
    set(k, 'running');
  }

  // Ask it to stop; kill it, and what it started, if it has not gone in time. (Asked twice
  // while it is stopping, it is the same stop: one wait, one timer, and never a kill sent
  // later to a process number that has since become something else's.)
  function stop(k) {
    clearTimeout(k.timer);
    if (k.stoppingNow) return k.stoppingNow;
    if (!k.child) {
      if (k.state !== 'needs you') set(k, 'stopped', 'stopped by you');
      return Promise.resolve();
    }
    k.stopping = true;
    const child = k.child;
    const pid = k.pid;
    k.stoppingNow = new Promise((resolve) => {
      const kill = setTimeout(() => {
        if (k.child !== child) return; // it has gone meanwhile
        k.log.note('did not stop when asked: killed');
        note([...kids].find(([, x]) => x === k)?.[0] ?? '?', 'did not stop when asked, and was killed', false);
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {}
      }, T.grace);
      k.done = () => {
        clearTimeout(kill);
        k.done = null;
        k.stoppingNow = null;
        resolve();
      };
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        k.done();
      }
    });
    return k.stoppingNow;
  }

  // What should be running is what the enabled plugins declare, less what is switched off.
  // (One look at a time, each after the one before: a look asked for while another is under
  // way is made once that has finished, so that what was asked is never skipped.)
  let queue = Promise.resolve();
  const look = () => (queue = queue.then(lookNow, lookNow));
  async function lookNow() {
    if (quitting) return;
    try {
      const all = await services();
      const off = new Set(switchedOff());
      for (const [id, svc] of Object.entries(all)) {
        let k = kids.get(id);
        if (!k) kids.set(id, (k = { state: 'stopped', restarts: 0, fails: 0, summary: svc.summary, held: false }));
        k.svc = svc;
        k.wanted = !off.has(id);
        if (!k.wanted) {
          if (k.child) await stop(k);
          if (k.state !== 'stopped' || k.why !== 'switched off')
            set(k, 'stopped', 'switched off (bc service install ' + id + ' puts it back)');
          continue;
        }
        if (k.child || k.held || k.state === 'restarting' || k.state === 'needs you') continue;
        const why = await svc.ready().catch((e) => `could not tell whether it is ready (${e.message})`);
        if (why) {
          if (k.state !== 'waiting' || k.why !== why) set(k, 'waiting', why);
          k.waitingSince ??= Date.now();
          continue;
        }
        if (k.waitingSince) note(id, `started after waiting ${Math.round((Date.now() - k.waitingSince) / 1000)} s for what it needs`);
        k.waitingSince = null;
        start(id, k, svc);
      }
      // A plugin that was switched off: its service goes.
      for (const [id, k] of kids)
        if (!all[id]) {
          await stop(k);
          kids.delete(id);
          write();
        }
    } catch (e) {
      say(`could not look at what should be running: ${e.message}`);
    }
  }

  // ---- what is asked of it
  async function answer(req) {
    const k = req.id ? kids.get(req.id) : null;
    if (req.op === 'status') return { ok: true };
    if (req.op === 'quit') {
      setImmediate(() => quit(0));
      return { ok: true, keeper };
    }
    if (req.id && !k) return { ok: false, error: `there is no service "${req.id}" here` };
    const list = k ? [[req.id, k]] : [...kids];
    if (req.op === 'stop') {
      for (const [, x] of list) ((x.held = true), await stop(x));
      return { ok: true };
    }
    if (req.op === 'start' || req.op === 'restart') {
      for (const [, x] of list) {
        if (req.op === 'restart' || x.state === 'needs you') await stop(x);
        x.held = false;
        x.fails = 0;
        if (x.state === 'needs you' || x.state === 'restarting') set(x, 'stopped');
      }
      await look();
      const not = list.filter(([, x]) => x.wanted && x.state !== 'running').map(([id, x]) => `${id}: ${x.why ?? x.state}`);
      return not.length && k ? { ok: false, error: not.join('; ') } : { ok: true };
    }
    return { ok: false, error: `"${req.op}" is not something the supervisor does` };
  }

  fs.rmSync(SOCKET, { force: true });
  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', async (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      let out;
      try {
        out = await answer(JSON.parse(buf.slice(0, i)));
      } catch (e) {
        out = { ok: false, error: e.message };
      }
      sock.end(`${JSON.stringify(out)}\n`);
    });
    sock.on('error', () => {});
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(SOCKET, resolve));
  fs.chmodSync(SOCKET, 0o600);

  async function quit(code) {
    if (quitting) return;
    quitting = true;
    say('stopping');
    note('blackcat', 'stopped');
    clearInterval(ticker);
    server.close();
    await Promise.all([...kids.values()].map((k) => stop(k)));
    fs.rmSync(SOCKET, { force: true });
    fs.rmSync(STATE_FILE, { force: true });
    say('stopped');
    process.exit(code);
  }
  process.on('SIGTERM', () => quit(0));
  process.on('SIGINT', () => quit(0));

  say(`blackcat is running (pid ${process.pid}${keeper ? `, kept by ${keeper}` : ''}) · ${HOME}`);
  note('blackcat', `started${keeper ? ` (kept by ${keeper})` : ' (by hand)'}`);
  write();
  await look();
  // (The regular look is skipped while one is still under way: they are never queued up.)
  let busy = false;
  ticker = setInterval(() => {
    if (busy) return;
    busy = true;
    look().finally(() => (busy = false));
  }, T.tick);
}
