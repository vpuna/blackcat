import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA } from '../config.js';

export const CODE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// The long-running parts of blackcat. The agent is core; plugins declare the others
// (`services` in their manifest). They are started, kept running and stopped by blackcat's
// own supervisor (supervisor.js), the same way on every machine: a Raspberry Pi, a
// container, a laptop. What starts the supervisor at boot is the machine's business
// (boot.js writes the one systemd unit where there is systemd).
// ready() returns why a service can't be started yet, or null.
const AGENT = {
  id: 'agent',
  summary: "the bot and the agent's conversations",
  args: ['agent', 'run'],
  // Nothing is needed first: without a Telegram bot it still runs the scheduler, and without
  // a model it still runs the bot's commands, shortcuts, reminders and checks.
  ready: async () => null,
  // What it will do without, said when blackcat is set to run.
  warn: async () => {
    const { modelState } = await import('../engines/registry.js');
    const st = await modelState('chat');
    return st.ok
      ? null
      : `no model is set up (${st.why}). It runs without one: commands, shortcuts, reminders and checks work; messages in words and watches need a model`;
  },
};

const refused = new Set();
export async function services() {
  // Imported here, not at the top: the plugin registry itself needs CODE_DIR from this file.
  const { loadPlugins, makeCtx, mountOf } = await import('../plugins/registry.js');
  const out = { agent: AGENT };
  const owner = { agent: 'blackcat' };
  for (const p of await loadPlugins()) {
    for (const sv of p.manifest.services ?? []) {
      // The first to claim an id keeps it: a later plugin's service by the same id is left out.
      if (out[sv.id]) {
        if (!refused.has(`${p.name}:${sv.id}`))
          console.error(`plugin "${p.name}": its service "${sv.id}" is left out: ${owner[sv.id]} already has a service by that id`);
        refused.add(`${p.name}:${sv.id}`);
        continue;
      }
      owner[sv.id] = `the ${p.name} plugin`;
      out[sv.id] = {
        id: sv.id,
        summary: sv.summary,
        args: [...mountOf(p.manifest), sv.command],
        ready: async () => (sv.ready ? sv.ready(makeCtx(p)) : null),
        // A problem only the plugin can see (logged out, can't connect), or null.
        health: async () => (sv.health ? sv.health(makeCtx(p)) : null),
      };
    }
  }
  return out;
}

// A service by its id alone. Enough for isInstalled(), show() and controlService().
export const service = (id) => ({ id });

// ---------- what the supervisor says of them ----------

export const RUN_DIR = path.join(DATA, 'run');
export const STATE_FILE = path.join(RUN_DIR, 'services.json');
export const SOCKET = path.join(RUN_DIR, 'services.sock');
export const LOG_DIR = path.join(DATA, 'logs');
export const logFile = (id) => path.join(LOG_DIR, `${id}.log`);

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

// When a process was started, as the system counts it: with its number, this says which
// process it is. A number alone does not: numbers are used again, and in a container the
// first few are the same every time it starts. (null where the system does not say.)
export function bornAt(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}
// Is this the very process that was noted, and still running?
// (Where the system says when a process started, the note must say the same: "something has
// that number" is not enough. On Linux even a thread of another process answers to a number.)
export const sameProcess = (pid, born) => !!pid && alive(pid) && (bornAt(pid) == null || bornAt(pid) === born);

// What the supervisor last wrote down, or null when none is running for this installation.
// (A note left by one that was killed outright is not a supervisor, whoever has its number now.)
export function supervisorState() {
  let st;
  try {
    st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
  return sameProcess(st?.pid, st?.born) ? st : null;
}

// Services the owner switched off (bc service uninstall <name>): not started until put back.
const OFF_FILE = path.join(DATA, 'services-off.json');
export function switchedOff() {
  try {
    const list = JSON.parse(fs.readFileSync(OFF_FILE, 'utf8'));
    return Array.isArray(list) ? list.map(String) : [];
  } catch {
    return [];
  }
}
export function setSwitchedOff(ids) {
  const list = [...new Set(ids)].sort();
  if (!list.length) return void fs.rmSync(OFF_FILE, { force: true });
  fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${OFF_FILE}.tmp`, JSON.stringify(list), { mode: 0o600 });
  fs.renameSync(`${OFF_FILE}.tmp`, OFF_FILE);
}

// Is this service one of those blackcat runs here? (It is, unless switched off; and only
// where blackcat is set to run at all: a supervisor is up, or one starts at boot.)
export function isInstalled(svc) {
  if (switchedOff().includes(svc.id)) return false;
  return !!supervisorState() || bootUnitExists();
}
// Where the one unit that starts blackcat at boot is written, on a machine with systemd (boot.js).
export const BOOT_UNIT = path.join(process.env.BLACKCAT_UNIT_DIR || path.join(os.homedir(), '.config/systemd/user'), 'blackcat.service');
const bootUnitExists = () => fs.existsSync(BOOT_UNIT);

// How a service is doing, in the words the rest of blackcat asks in:
//   ActiveState  active | inactive | failed
//   SubState     running | stopped | waiting | restarting | needs you | not running
//   MainPID, NRestarts, Result (why it is not running), since (unix seconds it started)
export async function show(svc) {
  const st = supervisorState();
  const s = st?.services?.[svc.id];
  if (!st)
    return {
      ActiveState: 'inactive',
      SubState: 'not running',
      MainPID: '0',
      NRestarts: '0',
      Result: 'blackcat is not running',
      since: null,
    };
  if (!s) return { ActiveState: 'inactive', SubState: 'stopped', MainPID: '0', NRestarts: '0', Result: 'not started', since: null };
  const active = s.state === 'running';
  return {
    ActiveState: active ? 'active' : ['restarting', 'needs you'].includes(s.state) ? 'failed' : 'inactive',
    SubState: s.state,
    MainPID: String(active ? s.pid : 0),
    NRestarts: String(s.restarts ?? 0),
    Result: active ? 'success' : (s.why ?? s.state),
    since: active ? s.since : null,
  };
}

// Seconds a service has been running.
export const activeSeconds = (props) => (props.since ? Math.max(0, Date.now() / 1000 - props.since) : null);

// A process and everything it started: [{ pid, name, rss }]. (For what a service uses.)
export function processes(pid) {
  const out = [];
  const seen = new Set();
  const walk = (p) => {
    if (!p || seen.has(p)) return;
    seen.add(p);
    try {
      const status = fs.readFileSync(`/proc/${p}/status`, 'utf8');
      out.push({ pid: p, name: status.match(/^Name:\s+(.*)$/m)?.[1], rss: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024 });
      for (const t of fs.readdirSync(`/proc/${p}/task`)) {
        const kids = fs.readFileSync(`/proc/${p}/task/${t}/children`, 'utf8').trim();
        for (const k of kids ? kids.split(/\s+/) : []) walk(Number(k));
      }
    } catch {
      // gone meanwhile, or not a system with /proc: counted as nothing
    }
  };
  walk(Number(pid));
  return out;
}

// Ask the supervisor for something: { op: 'start' | 'stop' | 'restart' | 'status' | 'quit', id? }.
// → its answer, or { ok: false, error } (also when there is no supervisor to ask).
export function ask(req, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    if (!supervisorState()) return resolve({ ok: false, error: 'blackcat is not running', down: true });
    import('node:net').then((net) => {
      let buf = '';
      const done = (v) => (clearTimeout(t), s.destroy(), resolve(v));
      const s = net.createConnection(SOCKET, () => s.write(`${JSON.stringify(req)}\n`));
      const t = setTimeout(() => done({ ok: false, error: 'the supervisor did not answer' }), timeoutMs);
      s.on('data', (d) => {
        buf += d;
        const i = buf.indexOf('\n');
        if (i < 0) return;
        try {
          done(JSON.parse(buf.slice(0, i)));
        } catch {
          done({ ok: false, error: 'the supervisor answered with something unreadable' });
        }
      });
      s.on('error', (e) => done({ ok: false, error: `the supervisor could not be reached (${e.code ?? e.message})`, down: true }));
    });
    return undefined;
  });
}

// Start, stop or restart one service. → { code: 0 } or { code: 1, stderr }, as a command would answer.
export async function controlService(verb, id) {
  const r = await ask({ op: verb, id });
  return r.ok ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: r.error ?? 'failed' };
}
