import { sentOwner } from '../activity/log.js';
import { chatHooks } from '../channels/hooks.js';
import { owner, ownerChat } from '../owner.js';
import { due, jobSchedule } from '../util/schedule.js';
import { latestSlot } from '../util/time.js';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { getMeta, openAgentDb, setMeta } from '../agentdb.js';
import { log } from '../log.js';
import { loadPlugins, makeCtx } from '../plugins/registry.js';
import { CODE_DIR, isInstalled, services, show } from '../service/units.js';

const TICK_MS = 20_000;

// Heavy work runs as a separate low-priority `blackcat …` process, so the bot stays
// responsive and a crash there can't take it down. Returns the process's stdout, or null.
const JOB_OUTPUT_MAX = 2 * 1024 ** 2; // characters of a job's output that are kept

// The chat, as a part is handed it for what it sends by itself: every message and file it
// sends from here is noted in the activity record (who sent it, what it calls it, whether
// it went; never the text). `opts.what` names it: "the briefing", "reminder 12".
export function sentBy(ui, from) {
  // (`opts.dueTs`: when it was meant to go, in seconds, so that the record can say how late it was.)
  const timed = (what, opts, extra, send, went = () => true) => {
    const t0 = Date.now();
    const more = () => ({ ms: Date.now() - t0, lateS: opts?.dueTs ? t0 / 1000 - opts.dueTs : null, ...extra });
    return send().then(
      (r) => {
        sentOwner(from, what, { ok: went(r), ...more() });
        return r;
      },
      (e) => {
        sentOwner(from, what, { ok: false, why: e, ...more() });
        throw e;
      },
    );
  };
  return new Proxy(ui, {
    get(target, key) {
      if (key === 'send')
        return (chat, text, opts) => timed(opts?.what, opts, { chars: String(text ?? '').length }, () => target.send(chat, text, opts));
      if (key === 'sendFile')
        return (chat, file, opts) =>
          timed(
            opts?.what ?? 'a file',
            opts,
            { file: true },
            () => target.sendFile(chat, file, opts),
            (r) => r !== false,
          );
      const v = target[key];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

export function runJob(args, { timeoutMs = 20 * 60_000 } = {}) {
  return new Promise((resolve) => {
    // In a process group of its own, so that when it has to be stopped, whatever it started
    // (a reader going through messages) is stopped with it.
    const child = spawn('nice', ['-n', '15', process.execPath, path.join(CODE_DIR, 'bin/bc.js'), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      // (So that what a job runs in the owner's name is not taken for something the owner did.)
      env: { ...process.env, BLACKCAT_JOB: '1' },
    });
    let out = '';
    let err = '';
    const signal = (sig) => {
      try {
        process.kill(-child.pid, sig);
      } catch {
        child.kill(sig);
      }
    };
    // Asked to stop, and if it has not gone ten seconds later, ended.
    let force;
    const timer = setTimeout(() => {
      log(`job "${args.join(' ')}" ran past ${Math.round(timeoutMs / 60_000)} minutes and was stopped`);
      signal('SIGTERM');
      force = setTimeout(() => signal('SIGKILL'), 10_000);
    }, timeoutMs);
    child.stdout.on('data', (d) => (out = out.length < JOB_OUTPUT_MAX ? out + d : out));
    child.stderr.on('data', (d) => (err = (err + d).slice(-500)));
    child.on('close', (code) => {
      clearTimeout(timer);
      clearTimeout(force);
      if (code !== 0) log(`job "${args.join(' ')}" exited ${code}: ${err.trim().split('\n').at(-1) ?? ''}`);
      resolve(code === 0 ? out : null);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      log(`job "${args.join(' ')}" could not start: ${e.message}`);
      resolve(null);
    });
  });
}

export { latestSlot };

const SERVICE_CHECK_S = 120;

// Keep an eye on the background services (the sources). The owner is told once when
// one stops working, and once when it is back; not every two minutes.
//   - a service that should be running and isn't (crashed and gave up, or stopped)
//   - a problem the plugin itself reports (`health` on the service: logged out, can't connect)
export async function checkServices(ui, db, all) {
  const chatId = owner()?.chat;
  for (const [id, svc] of Object.entries(all ?? (await services()))) {
    if (id === 'agent') continue; // that's us
    let problem = null;
    try {
      problem = (await svc.health?.()) ?? null;
      if (!problem && isInstalled(svc) && !(await svc.ready())) {
        const st = await show(svc);
        if (st.ActiveState !== 'active')
          problem = `its service is ${st.ActiveState === 'failed' ? 'stopped after failing repeatedly' : st.ActiveState}`;
      }
    } catch (e) {
      log(`could not check the ${id} service: ${e.message}`);
      continue;
    }
    const key = `service:${id}`;
    const before = JSON.parse(getMeta(db, key) ?? '{}');
    if (problem) {
      // Seen on two checks in a row before saying anything: a restart takes a moment.
      if (before.problem === problem) {
        if (!before.told) {
          log(`${id}: ${problem}`);
          if (ui && chatId)
            await ui
              .send(
                chatId,
                `⚠️ ${svc.summary}: ${problem}. Nothing new is being collected until this is sorted out.\n\nOn this machine: bc status · bc logs ${id}`,
                { what: `that ${id} has a problem` },
              )
              .catch(() => {});
          setMeta(db, key, JSON.stringify({ problem, told: true }));
        }
      } else setMeta(db, key, JSON.stringify({ problem, told: false }));
    } else if (before.problem) {
      setMeta(db, key, '{}');
      if (before.told) {
        log(`${id}: working again`);
        if (ui && chatId) await ui.send(chatId, `✅ ${svc.summary}: working again.`, { what: `that ${id} works again` }).catch(() => {});
      }
    }
  }
}

// Markers written before these features became plugins, so nothing runs twice after the upgrade.
function renameOldMarkers(db) {
  const moves = { wa_index_at: 'msg:job:index', wa_scan_slot: 'remind:scan_slot', watch_scan_at: 'watch:scan_at' };
  for (const { key } of db.prepare("SELECT key FROM meta WHERE key LIKE 'job:%'").all())
    moves[key] = key.replace(/^job:([^:]+):/, '$1:job:');
  for (const [from, to] of Object.entries(moves)) {
    db.prepare('UPDATE OR IGNORE meta SET key = ? WHERE key = ?').run(to, from);
    db.prepare('DELETE FROM meta WHERE key = ?').run(from);
  }
}

// The scheduler knows nothing about particular features. Every tick it gives each
// plugin a turn:
//   jobs            `every: '15m'` or `at: ['08:00']`, each run in its own process
//   telegram.tick   called in the bot process, for work that needs the bot itself
//                   (sending messages with buttons). It must return quickly.
// `ui`: the desk's sending half (channels/desk.js) when a channel is in use, else null.
export function startScheduler(ui) {
  const db = openAgentDb();
  renameOldMarkers(db);
  const busy = new Set();
  // Run `fn` unless the previous run under the same name is still going.
  const once = async (name, fn) => {
    if (busy.has(name)) return;
    busy.add(name);
    try {
      await fn();
    } catch (e) {
      log(`scheduler ${name} failed: ${e.message}`);
    } finally {
      busy.delete(name);
    }
  };
  // Small persistent markers ("when did this last run?"), kept per plugin.
  const marks = (plugin) => ({
    last: (key) => Number(getMeta(db, `${plugin}:${key}`)) || 0,
    mark: (key, value) => setMeta(db, `${plugin}:${key}`, value),
  });

  async function tick() {
    const nowMs = Date.now();
    const now = Math.floor(nowMs / 1000);
    if (now - (Number(getMeta(db, 'services_checked')) || 0) >= SERVICE_CHECK_S) {
      setMeta(db, 'services_checked', now);
      once('services', () => checkServices(ui && sentBy(ui, 'services'), db));
    }
    for (const p of await loadPlugins()) {
      // Each plugin gets its turn whatever the others do: one whose schedule can't be worked
      // out (a bad setting, a bug) is skipped and logged, not allowed to stop the rest.
      try {
        turn(p, now, nowMs);
      } catch (e) {
        if (!complained.has(p.name)) log(`scheduler: ${p.name} was skipped: ${e.message}`);
        complained.add(p.name);
      }
    }
  }

  const complained = new Set();
  function turn(p, now, nowMs) {
    const ctx = makeCtx(p, { caller: 'job', surface: 'chat' });
    const { last, mark } = marks(p.name);

    for (const job of p.manifest.jobs ?? []) {
      const key = `job:${job.id}`;
      try {
        if (job.when && !job.when(ctx)) continue;
        // A moment that passed while blackcat was off is caught up once, at the next tick.
        const slot = due(jobSchedule(job, ctx), last(key), nowMs);
        if (!slot) continue;
        mark(key, slot);
        once(`${p.name}:${key}`, () => runJob(['plugin', 'job', p.name, job.id], { timeoutMs: 20 * 60_000 }));
      } catch (e) {
        // (This job is passed over; the plugin's other jobs and its tick go on. Said once.)
        if (!complained.has(`${p.name}:${key}`)) log(`scheduler: ${p.name} ${job.id} cannot be scheduled: ${e.message}`);
        complained.add(`${p.name}:${key}`);
      }
    }

    // (`chat`: the owner's chat on the channel in use, for what a plugin sends them by itself.)
    const s = { ctx, now, nowMs, last, mark, once: (n, fn) => once(`${p.name}:${n}`, fn), runJob, latestSlot, chat: ownerChat() };
    if (chatHooks(p).tick) once(`${p.name}:tick`, () => chatHooks(p).tick(ui && sentBy(ui, p.name), s));
    // A plugin written for the Telegram bot itself is handed that bot, when Telegram is the channel in use.
  }

  const timer = setInterval(() => tick().catch((e) => log(`scheduler error: ${e.message}`)), TICK_MS);
  tick().catch((e) => log(`scheduler error: ${e.message}`));
  return { stop: () => clearInterval(timer) };
}
