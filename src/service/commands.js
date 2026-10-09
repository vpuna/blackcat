import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { ownerDid } from '../activity/log.js';
import { load } from '../config.js';
import { logo } from '../logo.js';
import { duration, gb, systemInfo } from '../system.js';
import { sleep } from '../util/wait.js';
import { UNIT, bootInstalled, hasSystemd, lingerEnabled, otherHome as bootOtherHome, removeUnit, systemctl, writeUnit } from './boot.js';
import {
  BOOT_UNIT,
  activeSeconds,
  ask,
  logFile,
  processes,
  services,
  setSwitchedOff,
  show,
  supervisorState,
  switchedOff,
} from './units.js';

const NOT_RUNNING = `blackcat is not running. Start it at boot and now: ${pc.cyan('bc service install')}. Or in this terminal: ${pc.cyan('bc service run')}`;

// The services asked for, by name or all of them.
async function targets(name) {
  const SERVICES = await services();
  if (name && !SERVICES[name]) {
    console.error(`Unknown service "${name}". Choose from: ${Object.keys(SERVICES).join(', ')}`);
    process.exit(1);
  }
  return name ? [[name, SERVICES[name]]] : Object.entries(SERVICES);
}

// ---------- start / stop / restart ----------

async function control(verb, name) {
  const past = { start: 'started', stop: 'stopped', restart: 'restarted' }[verb];
  // (Noted as the command ends, so that it says how long it took and whether it worked.)
  const t0 = Date.now();
  process.once('exit', (code) => {
    try {
      ownerDid(`bc ${verb}`, name ?? 'everything', { ok: !code, ms: Date.now() - t0, data: code ? { exit: code } : undefined });
    } catch {}
  });
  const st = supervisorState();
  if (!st) {
    console.error(NOT_RUNNING);
    process.exit(1);
  }
  // Everything restarted is how new code is taken up, and the supervisor is code too: where
  // something will start it again (the boot unit, a container), it ends and is started afresh.
  if (verb === 'restart' && !name && st.keeper) {
    const was = st.pid;
    await ask({ op: 'quit' });
    for (let i = 0; i < 120 && (!supervisorState() || supervisorState().pid === was); i++) await sleep(500);
    const now = supervisorState();
    if (!now || now.pid === was) return void console.log(`${pc.red('●')} blackcat did not come back. See ${pc.cyan('bc logs')}`);
    await sleep(2500);
    for (const [n, svc] of await targets()) {
      const s = await show(svc);
      if (s.ActiveState === 'active') console.log(`${pc.green('●')} ${n} ${past}`);
      else if (!switchedOff().includes(n)) console.log(`${pc.yellow('●')} ${n}: ${s.Result}`);
    }
    return;
  }
  for (const [n, svc] of await targets(name)) {
    if (switchedOff().includes(n)) {
      if (name) console.log(`${pc.dim('○')} ${n} is switched off. Put it back: ${pc.cyan(`bc service install ${n}`)}`);
      continue;
    }
    const r = await ask({ op: verb, id: n });
    if (verb === 'stop') {
      console.log(r.ok ? `${pc.dim('○')} ${n} ${past}` : `${pc.red('✗')} ${n}: ${r.error}`);
      continue;
    }
    if (r.ok) await sleep(process.env.BLACKCAT_SUPERVISOR_FAST ? 300 : 2000); // catch one that dies straight away
    const s = await show(svc);
    if (s.ActiveState === 'active') console.log(`${pc.green('●')} ${n} ${past}`);
    else
      console.log(
        `${s.SubState === 'waiting' ? pc.yellow('●') : pc.red('●')} ${n} is not running: ${s.Result}${s.SubState === 'waiting' ? '' : `. See ${pc.cyan(`bc logs ${n}`)}`}`,
      );
  }
}

export const start = (name) => control('start', name);
export const stop = (name) => control('stop', name);
export const restart = (name) => control('restart', name);

// ---------- logs ----------

// What each service printed is kept in a file of its own (and the supervisor's in blackcat.log).
export async function logs(name, opts) {
  const ids = name ? (await targets(name)).map(([n]) => n) : ['blackcat', ...(await targets()).map(([n]) => n)];
  const files = ids.map(logFile).filter((f) => fs.existsSync(f));
  if (!files.length) return console.log(name ? `${name} has not written anything yet.` : 'Nothing has been written yet.');
  const args = ['-n', String(Number(opts.lines) || 50), ...(opts.follow ? ['-F'] : []), ...files];
  const child = spawn('tail', args, { stdio: 'inherit' });
  child.on('close', (code) => process.exit(code ?? 0));
  process.on('SIGINT', () => {}); // let tail handle Ctrl+C
  return undefined;
}

// ---------- status ----------

async function collect() {
  const SERVICES = await services();
  // What the engine's own processes are called, if it keeps any (its manifest says).
  let engineProcess = null;
  try {
    const { engineFor } = await import('../engines/registry.js');
    engineProcess = (await engineFor('chat')).def.process ?? null;
  } catch {}
  const sup = supervisorState();
  const off = switchedOff();
  const svcs = {};
  for (const [n, svc] of Object.entries(SERVICES)) {
    const s = await show(svc);
    const procs = s.ActiveState === 'active' ? processes(s.MainPID) : [];
    svcs[n] = {
      installed: !off.includes(n),
      summary: svc.summary,
      state: s.ActiveState,
      detail: s.SubState,
      why: s.ActiveState === 'active' ? null : s.Result,
      pid: Number(s.MainPID) || null,
      since: s.ActiveState === 'active' ? activeSeconds(s) : null,
      restarts: Number(s.NRestarts) || 0,
      memory: procs.reduce((a, x) => a + x.rss, 0),
      // The engine's own processes among them: one for each conversation it is holding.
      engineSessions: engineProcess ? procs.filter((x) => x.name === engineProcess).length : 0,
    };
  }

  const cfg = load();
  // What runs the model for the chat: is it ready, and with which model?
  let engine = { ready: false, label: 'engine', detail: 'none' };
  try {
    const { engineFor } = await import('../engines/registry.js');
    const e = await engineFor('chat');
    const r = await e.def.ready(e.ctx).catch((err) => ({ ok: false, why: err.message }));
    const { standing, lastAccepted } = await import('../engines/check/report.js');
    engine = {
      name: e.name,
      label: e.label,
      ready: !!r.ok,
      detail: r.ok ? (r.detail ?? null) : (r.why ?? null),
      model: e.model ?? 'default',
      options: e.options,
      check: standing('chat'),
      // One that was set up and checked is expected to be there; one that never was is simply not used.
      expected: !!lastAccepted('chat'),
    };
  } catch (e) {
    engine.detail = e.message;
  }

  const systemd = await hasSystemd();
  return {
    services: svcs,
    // What runs them all, and what starts that when the machine starts.
    supervisor: sup
      ? { running: true, pid: sup.pid, since: Math.max(0, Date.now() / 1000 - sup.started), keeper: sup.keeper }
      : { running: false },
    boot: { systemd, installed: bootInstalled(), linger: systemd ? await lingerEnabled() : null },
    // The channel in use: how blackcat talks to the owner.
    channel: cfg.channel ? { name: cfg.channel, owner: cfg.plugins?.settings?.[cfg.channel]?.owner?.name ?? null } : null,
    engine,
    plugins: await pluginsSummary(),
    system: await systemInfo(),
  };
}

async function pluginsSummary() {
  const { loadPlugins, makeCtx } = await import('../plugins/registry.js');
  const out = [];
  for (const p of await loadPlugins()) {
    let text = '';
    try {
      text = p.manifest.status ? String(await p.manifest.status(makeCtx(p))) : 'enabled';
    } catch (e) {
      text = `status failed: ${e.message}`;
    }
    out.push({ name: p.name, title: p.manifest.title, text });
  }
  return out;
}

export async function status(opts) {
  const st = await collect();
  if (opts.json) {
    console.log(JSON.stringify(st, null, 2));
    return;
  }

  const row = (label, dot, text) => console.log(`  ${label.padEnd(10)}${dot} ${text}`);
  const mb = (b) => `${Math.round(b / 1024 ** 2)} MB`;
  console.log(`\n${logo('your home agent')}\n`);

  const sup = st.supervisor;
  if (!sup.running)
    row(
      'blackcat',
      pc.yellow('○'),
      `${pc.yellow('not running')}  ${pc.dim('→ bc service install (at boot, and now), or bc service run (in this terminal)')}`,
    );
  for (const [n, s] of Object.entries(st.services)) {
    if (!s.installed) {
      row(n, pc.dim('○'), `${pc.dim('switched off')}  ${pc.dim(`→ bc service install ${n}`)}`);
    } else if (!sup.running) {
      row(n, pc.dim('○'), pc.dim('not running'));
    } else if (s.state === 'active') {
      const bits = [`up ${duration(s.since)}`, `pid ${s.pid}`, mb(s.memory)];
      if (s.engineSessions) bits.push(`${s.engineSessions} conversation${s.engineSessions > 1 ? 's' : ''} held`);
      if (s.restarts) bits.push(pc.yellow(`${s.restarts} restart${s.restarts > 1 ? 's' : ''}`));
      row(n, pc.green('●'), `${pc.green('running')}  ${pc.dim(bits.join(' · '))}`);
    } else if (s.detail === 'waiting') {
      row(n, pc.dim('○'), `${pc.dim('waiting')}  ${pc.dim(s.why ?? '')}`);
    } else {
      const color = s.state === 'failed' ? pc.red : pc.yellow;
      row(n, color('●'), `${color(s.detail)}${s.why && s.why !== s.detail ? `  ${pc.dim(s.why)}` : ''}  ${pc.dim(`→ bc logs ${n}`)}`);
    }
  }
  console.log();

  const ch = st.channel;
  row(
    'channel',
    ch ? pc.green('●') : pc.dim('○'),
    ch ? `${ch.name}${ch.owner ? ` · talking to ${ch.owner}` : ''}` : pc.dim('none in use → bc tg bot pair (bc chat always works)'),
  );
  const e = st.engine;
  const chosen = Object.entries(e.options ?? {})
    .map(([k, v]) => ` · ${k}: ${v}`)
    .join('');
  row(
    'engine',
    e.ready ? pc.green('●') : e.expected ? pc.red('●') : pc.yellow('○'),
    e.ready
      ? `${e.label} · ${e.detail ? `${e.detail} · ` : ''}model: ${e.model}${chosen} · ${/BROKEN/.test(e.check ?? '') ? pc.red(e.check) : pc.dim(e.check ?? '')}`
      : e.expected
        ? pc.red(`${e.label}: ${e.detail}`)
        : pc.yellow(
            `no model (${e.label}: ${e.detail}) · commands, shortcuts, reminders and checks work; messages in words and watches need one`,
          ),
  );
  // What starts blackcat when the machine starts.
  const b = st.boot;
  if (sup.running && sup.keeper === 'container') row('boot', pc.green('●'), pc.dim('started with its container'));
  else if (b.systemd && b.installed && b.linger) row('boot', pc.green('●'), pc.dim('starts when the machine starts'));
  else if (b.systemd && b.installed) row('boot', pc.yellow('●'), pc.yellow('only runs while you are logged in → bc service install'));
  else if (sup.running)
    row(
      'boot',
      pc.yellow('●'),
      pc.yellow(b.systemd ? 'started by hand: not at boot → bc service install' : 'started by hand: nothing here starts it at boot'),
    );
  console.log();

  // One line per enabled plugin, in its own words.
  if (st.plugins.length) {
    const wide = Math.max(...st.plugins.map((pl) => pl.title.length)) + 2;
    console.log(pc.dim('  plugins'));
    for (const pl of st.plugins) console.log(`  ${pl.title.padEnd(wide)}${pc.dim(pl.text)}`);
    console.log();
  }

  const sys = st.system;
  const hot = sys.temp >= 70 ? pc.red : sys.temp >= 60 ? pc.yellow : (x) => x;
  row(
    'machine',
    pc.green('●'),
    [
      `up ${duration(sys.uptime)}`,
      sys.temp != null ? hot(`${sys.temp.toFixed(1)}°C`) : null,
      `load ${sys.load.map((l) => l.toFixed(2)).join(' ')}`,
      `mem ${gb(sys.mem.used)}/${gb(sys.mem.total)} GB`,
      sys.disk ? `disk ${gb(sys.disk.total - sys.disk.free)}/${gb(sys.disk.total)} GB` : null,
    ]
      .filter(Boolean)
      .join(' · '),
  );
  console.log();
}

// ---------- install / uninstall ----------

// For a plugin whose service has just become possible (an account was linked): have it
// run, now if blackcat is running, and from then on. → true when all of them are running.
export async function installServices(names, { quiet = false } = {}) {
  const SERVICES = await services();
  setSwitchedOff(switchedOff().filter((x) => !names.includes(x)));
  if (!supervisorState()) {
    if (!quiet) p.log.info(`It will run with blackcat, which is not running here yet: ${pc.cyan('bc service install')}`);
    return false;
  }
  let allOk = true;
  for (const n of names) {
    const reason = await SERVICES[n].ready();
    if (reason) {
      p.log.warn(`${n}: not started (${reason})`);
      allOk = false;
      continue;
    }
    const warning = await SERVICES[n].warn?.();
    if (warning) p.log.warn(`${n}: ${warning}`);
    await ask({ op: 'restart', id: n });
    await sleep(process.env.BLACKCAT_SUPERVISOR_FAST ? 300 : 3000);
    const s = await show(SERVICES[n]);
    if (s.ActiveState === 'active') {
      if (!quiet) p.log.success(`${n} is running`);
    } else {
      allOk = false;
      p.log.warn(`${n} did not start (${s.Result}). See bc logs ${n}`);
    }
  }
  return allOk;
}

// Stop services and keep them stopped (a plugin whose account was unlinked; bc service uninstall <name>).
export async function removeServices(names) {
  setSwitchedOff([...switchedOff(), ...names]);
  for (const n of names) if (supervisorState()) await ask({ op: 'stop', id: n });
}

// (Kept for those who ask whether the services here belong to another installation: the one
// boot unit is for one installation, and says which.)
export const otherHome = () => bootOtherHome();

export async function install(name) {
  await targets(name);
  p.intro(pc.bgMagenta(pc.black(' blackcat · run in the background ')));
  ownerDid('bc service install', name ?? 'blackcat, at boot');
  if (name) {
    const ok = await installServices([name]);
    return p.outro(ok ? `Done. Check it with ${pc.cyan('bc status')}` : 'See above.');
  }
  setSwitchedOff([]);
  const other = bootOtherHome();
  if (other)
    return p.outro(
      pc.yellow(`This account already runs the blackcat in ${other} at boot. Run ${pc.cyan('bc service uninstall')} there first.`),
    );
  if (!(await hasSystemd())) {
    return p.outro(
      `There is no systemd here to start blackcat at boot. Run ${pc.cyan('blackcat service run')} as the command of whatever starts things on this machine (in a container: its command, with a restart policy).`,
    );
  }
  for (const [n, svc] of await targets()) {
    const warning = await svc.warn?.();
    if (warning) p.log.warn(`${n}: ${warning}`);
  }
  // One started by hand in a terminal would be a second copy of everything.
  const sup = supervisorState();
  if (sup && sup.keeper !== 'systemd') {
    // (Asked only of a person: something else running this is told, and nothing is stopped.)
    if (!process.stdin.isTTY)
      return p.outro(
        pc.yellow(`blackcat is running from a terminal (pid ${sup.pid}). Stop that one first (Ctrl+C there), then run this again.`),
      );
    const ok = await p.confirm({
      message: `blackcat is running from a terminal (pid ${sup.pid}). Stop it so that it runs in the background instead?`,
    });
    if (p.isCancel(ok) || !ok) return p.cancel('Nothing changed');
    await ask({ op: 'quit' });
    for (let i = 0; i < 80 && supervisorState(); i++) await sleep(250);
  }
  writeUnit();
  p.log.success(`Wrote ${pc.dim(BOOT_UNIT.replace(os.homedir(), '~'))}`);
  await systemctl('daemon-reload');
  if (!(await lingerEnabled())) {
    p.log.info('Allowing blackcat to start at boot, before you log in. This needs sudo once:');
    const r = spawnSync('sudo', ['loginctl', 'enable-linger', os.userInfo().username], { stdio: 'inherit' });
    if (r.status === 0 && (await lingerEnabled())) p.log.success('Start at boot enabled');
    else p.log.warn('Could not enable start at boot. blackcat will only run while you are logged in.');
  } else p.log.success('Start at boot already enabled');
  const s = p.spinner();
  s.start('Starting blackcat');
  await systemctl('enable', UNIT);
  await systemctl('restart', UNIT); // restart, so a reinstall takes up changes
  for (let i = 0; i < 40 && !supervisorState(); i++) await sleep(250);
  await sleep(process.env.BLACKCAT_SUPERVISOR_FAST ? 300 : 4000);
  if (!supervisorState()) {
    s.error('blackcat did not start. See: journalctl --user -u blackcat -n 50');
    return p.outro('Not running.');
  }
  s.stop('blackcat is running');
  for (const [n, svc] of await targets()) {
    const x = await show(svc);
    if (x.ActiveState === 'active') p.log.success(`${n} is running`);
    else p.log.info(`${n}: ${x.Result}`);
  }
  return p.outro(`Done. Check it with ${pc.cyan('bc status')} and ${pc.cyan('bc logs -f')}`);
}

export async function uninstall(name) {
  await targets(name);
  p.intro(pc.bgMagenta(pc.black(' blackcat · stop running in the background ')));
  if (name) {
    ownerDid('bc service uninstall', name);
    await removeServices([name]);
    return p.outro(`${name} is stopped and stays stopped. Put it back: ${pc.cyan(`bc service install ${name}`)}`);
  }
  if (!bootInstalled() && !supervisorState()) return p.outro('Nothing is installed or running.');
  if (bootOtherHome()) return p.outro(pc.yellow(`What starts at boot belongs to the blackcat in ${bootOtherHome()}. Run this there.`));
  const ok = await p.confirm({ message: 'Stop blackcat and no longer start it at boot? Your settings and data are kept.' });
  if (p.isCancel(ok) || !ok) return p.cancel('Nothing changed');
  ownerDid('bc service uninstall', 'blackcat, at boot');
  if (bootInstalled()) {
    await systemctl('disable', '--now', UNIT);
    removeUnit();
    await systemctl('daemon-reload');
    await systemctl('reset-failed');
  }
  if (supervisorState()) {
    await ask({ op: 'quit' });
    for (let i = 0; i < 80 && supervisorState(); i++) await sleep(250);
  }
  return p.outro(`Stopped. You can still run it by hand: ${pc.cyan('bc service run')}`);
}

// What the boot unit, a container or a terminal runs.
export async function runAll() {
  await (await import('./supervisor.js')).run();
}
