// `bc engine …`: what is in use, and choosing.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CODE_DIR } from '../service/units.js';
import { DEFAULT_ENGINE, ROLES, choicesOf, choose, engineFor, enginePlugins, engineStamp, optionsFor, stored } from './registry.js';
import { findLoaded } from '../plugins/registry.js';

const WHO = { chat: 'the agent you talk to', readers: 'the background readers' };
const optionsText = (o) =>
  Object.entries(o ?? {})
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');

// Asking an engine whether it is ready can take a second (Claude Code is started to say
// whether it is signed in): each engine is asked once, however many roles use it.
const asked = new Map();
function readyOnce(e) {
  if (!asked.has(e.name))
    asked.set(
      e.name,
      e.def.ready(e.ctx).catch((err) => ({ ok: false, why: err.message })),
    );
  return asked.get(e.name);
}

// One role, as it stands: engine, model, options, where the model is, whether it is ready.
async function state(role) {
  try {
    const e = await engineFor(role);
    const ready = await readyOnce(e);
    return {
      for: role,
      engine: e.name,
      label: e.label,
      model: e.model,
      chosen: stored(role),
      options: e.options,
      where: e.def.where?.(e.ctx) ?? null,
      ready: !!ready.ok,
      detail: ready.ok ? (ready.detail ?? null) : (ready.why ?? null),
    };
  } catch (err) {
    return { for: role, engine: stored(role).name ?? null, ready: false, detail: err.message };
  }
}

export async function show() {
  const { standing } = await import('./check/report.js');
  const roles = (await Promise.all(ROLES.map(state))).map((r) => ({ ...r, check: standing(r.for) }));
  const engines = enginePlugins().map((p) => ({ name: p.name, ...choicesOf(p.name) }));
  const lines = [];
  for (const r of roles) {
    if (!r.label) {
      lines.push(`${r.for} (${WHO[r.for]}): ${r.detail}`);
      continue;
    }
    lines.push(`${r.for} (${WHO[r.for]})`);
    lines.push(`  engine   ${r.label}${r.ready ? '' : '  ✗ not ready'}${r.detail ? ` · ${r.detail}` : ''}`);
    lines.push(`  model    ${r.model ?? `left to ${r.label}`}${r.model && !r.chosen.model ? ` (${r.label}'s default for this)` : ''}`);
    if (Object.keys(r.options ?? {}).length) lines.push(`  options  ${optionsText(r.options)}`);
    if (r.where) lines.push(`  where    ${r.where}`);
    lines.push(`  check    ${r.check}`);
  }
  for (const e of engines) {
    lines.push('', `${e.label} (${e.name}) can be asked for:`);
    lines.push(`  models   ${e.models.map((m) => m.id).join(', ') || 'none listed'}, or any other by name`);
    for (const o of e.options) lines.push(`  ${o.id.padEnd(8)} ${o.values.join(', ')}${o.roles ? ` (${o.roles.join(', ')} only)` : ''}`);
  }
  lines.push('', 'Change with: bc engine setup · check what is in use: bc engine check');
  return { text: lines.join('\n'), data: { roles, engines } };
}

export async function set(a, { DEFAULT, OTHER }) {
  const role = a.for;
  const model = a.model === DEFAULT ? null : a.model === OTHER ? String(a.name).trim() : a.model;
  const offered = optionsFor((await engineFor(role)).name, role);
  const options = Object.fromEntries(offered.filter((o) => a[o.id] !== undefined).map((o) => [o.id, a[o.id] === DEFAULT ? null : a[o.id]]));
  choose(role, { model, options });
  const e = await engineFor(role);
  const opts = optionsText(e.options);
  const { acceptedFor } = await import('./check/report.js');
  const unchecked = acceptedFor(role)
    ? ''
    : `\nThis choice has not been checked for security, accuracy and speed. To check it: bc engine check --for ${role}`;
  return {
    text:
      `Saved for ${WHO[role]}: ${e.model ? `model ${e.model}` : `the model is left to ${e.label}`}${opts ? `, ${opts}` : ''}.` +
      (role === 'chat'
        ? '\nIt takes effect with your next message to the agent (a conversation in progress carries on).'
        : '\nIt takes effect with the next thing the readers are given.') +
      unchecked,
    data: { for: role, engine: e.name, model: e.model, options: e.options },
  };
}

// ---- the check ----

const rolesOf = (which) => (!which || which === 'both' ? ROLES : ROLES.includes(which) ? [which] : null);

// Run the check in a temporary copy. `choice`: { role: { name, model, options } } to try in
// place of what is set. → { role: { stamp, result } }
// It can be stopped part-way (Ctrl+C in a terminal, Stop in the chat): the run and the
// conversations it started are ended, the copy is removed, and what comes back says
// `stopped` and holds nothing for the part that did not finish.
export async function runCheck({ roles, choice = {}, quick = false, say = () => {} }) {
  const { collect } = await import('./check/cases.js');
  const sandbox = await import('./check/sandbox.js');
  const { cases, skipped } = collect({ quick });
  // What the agent is told here, in the real installation: the copy is given the same.
  const { runtimePrompt } = await import('../channels/commands.js');
  const instructions = runtimePrompt({ surface: 'chat' });
  const dir = sandbox.make(choice);
  const out = {};
  // Stopping: the run is in a group of its own with whatever it started (the engine's
  // conversations), and the whole group is ended. Then the `finally` below tidies up as usual.
  let stopped = false;
  let current = null;
  const stop = () => {
    stopped = true;
    if (!current?.pid) return;
    try {
      process.kill(-current.pid, 'SIGTERM');
    } catch {
      current.kill('SIGTERM');
    }
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    for (const role of roles) {
      if (stopped) break;
      const started = Date.now();
      const file = path.join(dir, `plan-${role}.json`);
      fs.writeFileSync(file, JSON.stringify({ role, cases: role === 'chat' ? cases : [], instructions }));
      const code = await new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join(CODE_DIR, 'bin/bc.js'), 'engine', 'check-run', file], {
          env: sandbox.env(dir),
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        });
        current = child;
        let buf = '';
        let err = '';
        child.stdout.on('data', (d) => {
          buf += d;
          let n;
          while ((n = buf.indexOf('\n')) >= 0) {
            say(buf.slice(0, n));
            buf = buf.slice(n + 1);
          }
        });
        child.stderr.on('data', (d) => (err = (err + d).slice(-600)));
        child.on('error', () => resolve(1));
        child.on('close', (c) => resolve(c === 0 ? 0 : err.trim() || 1));
      });
      current = null;
      if (stopped) {
        // It used some of the owner's plan before it was stopped: that it ran is on the record,
        // though how much it used is known only to a run that finishes.
        const { record } = await import('../activity/log.js');
        record({
          kind: 'model',
          category: 'engine check',
          surface: 'terminal',
          ok: false,
          ms: Date.now() - started,
          summary: `${role}: stopped before it finished`,
          data: { role, stopped: true },
        });
        break;
      }
      let result;
      try {
        result = JSON.parse(fs.readFileSync(`${file}.result`, 'utf8'));
      } catch {
        const c = { ...stored(role), ...choice[role] };
        result = {
          role,
          engine: c.name ?? DEFAULT_ENGINE,
          label: c.name ?? DEFAULT_ENGINE,
          model: c.model ?? null,
          options: c.options ?? {},
          at: new Date().toISOString(),
          error: `the run did not finish${typeof code === 'string' ? `: ${code.slice(-300)}` : ''}`,
        };
      }
      result.skipped = role === 'chat' ? skipped : [];
      // A check uses the owner's plan like anything else: it goes on this installation's record.
      const p = result.performance;
      const { record } = await import('../activity/log.js');
      record({
        kind: 'model',
        category: 'engine check',
        surface: 'terminal',
        ok: !result.error,
        ms: Date.now() - started,
        model: p?.model ?? result.model ?? null,
        ...p?.used,
        cost: p?.cost ?? null,
        summary: result.error ? `failed: ${String(result.error).slice(0, 80)}` : `${role}: ${p?.requests ?? 0} requests`,
        data: { engine: result.engine, role },
      });
      out[role] = { stamp: engineStamp(role, { ...stored(role), ...choice[role] }), result };
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    // What the engine kept about the conversations it had in the copy goes with it (also for a
    // part that was stopped, and so has no result to say which engine it was).
    for (const name of new Set(
      roles.map((r) => out[r]?.result.engine ?? { ...stored(r), ...choice[r] }.name ?? DEFAULT_ENGINE).filter(Boolean),
    )) {
      const p = findLoaded(name);
      try {
        await p?.manifest.engine?.forget?.(null, path.join(dir, 'agent'));
      } catch {}
    }
    sandbox.remove(dir);
  }
  if (stopped) Object.defineProperty(out, 'stopped', { value: true });
  return out;
}

// How many requests a check makes, to say before it starts.
async function size(roles, quick) {
  const { collect } = await import('./check/cases.js');
  const n = collect({ quick }).cases.length;
  return (roles.includes('chat') ? n + 9 : 0) + (roles.includes('readers') ? 2 : 0);
}

// Show what was found, and (in a terminal) ask whether to accept it. → true if everything asked about was accepted
async function decide(found, { ask }) {
  const report = await import('./check/report.js');
  const lines = [];
  for (const [role, f] of Object.entries(found)) {
    lines.push(report.text(f.result, report.lastAccepted(role)?.summary), '');
    if (f.result.skipped?.length) lines.push(`  Not checked, because it is not set up here: ${f.result.skipped.join('; ')}`, '');
    report.keepPending(role, f.stamp, f.result);
  }
  console.log(lines.join('\n'));
  const failed = Object.values(found).filter((f) => f.result.error);
  if (failed.length) return false;
  if (!ask) return null;
  const p = await import('@clack/prompts');
  let all = true;
  for (const [role, f] of Object.entries(found)) {
    const s = report.summary(f.result);
    let yes;
    if (s.broken.length) {
      // Not a tap: something that was refused was done all the same.
      const typed = await p.text({
        message: `With this engine, something that was refused was DONE (${s.broken.length} safeguard${s.broken.length === 1 ? '' : 's'} broken, above). To use it for ${WHO[role]} anyway, type its name (${s.engine}); anything else declines.`,
      });
      yes = !p.isCancel(typed) && String(typed).trim() === s.engine;
    } else {
      const a = await p.confirm({ message: `Accept this for ${WHO[role]}?`, initialValue: true });
      yes = !p.isCancel(a) && a;
    }
    if (yes) report.accept(role, f);
    else all = false;
  }
  return all;
}

export async function check(i, fail) {
  const roles = rolesOf(i.for);
  if (!roles) return fail(`--for is ${ROLES.join(', ')} or both.`);
  const tty = !!process.stdin.isTTY && !i.json;
  const n = await size(roles, i.quick);
  console.log(
    `Checking ${roles.map((r) => WHO[r]).join(' and ')}: about ${n} requests to the model, in a temporary copy with made-up messages. It takes a few minutes and uses some of your plan. Nothing outside this machine is changed or read.\n`,
  );
  if (tty && !i.yes) {
    const p = await import('@clack/prompts');
    const go = await p.confirm({ message: 'Run it now?', initialValue: true });
    if (p.isCancel(go) || !go) return { text: 'Not run.' };
  }
  const found = await runCheck({ roles, quick: !!i.quick, say: (l) => console.log(`  ${l}`) });
  console.log();
  // Stopped part-way: nothing is made of what it had found. What was checked before stands.
  if (found.stopped)
    return {
      text: 'Stopped before it finished. Nothing was kept from it, and the temporary copy is gone: what was checked before stands.',
      data: { stopped: true },
    };
  const accepted = await decide(found, { ask: tty });
  const data = Object.fromEntries(Object.entries(found).map(([r, f]) => [r, f.result]));
  if (accepted === null) return { text: 'To accept what is in use on the strength of this: bc engine accept', data };
  return { text: accepted ? 'Accepted.' : 'Not accepted. What is in use is unchanged; see bc engine status.', data };
}

// Accept the last check, when it is still about what is in use.
export async function accept(i, fail) {
  const report = await import('./check/report.js');
  const roles = rolesOf(i.for);
  if (!roles) return fail(`--for is ${ROLES.join(', ')} or both.`);
  const pending = report.pending();
  const done = [];
  for (const role of roles) {
    const f = pending[role];
    if (!f) continue;
    if (f.stamp !== engineStamp(role))
      return fail(`What ${WHO[role]} use has changed since that check. Run it again: bc engine check --for ${role}`);
    if (f.result.error)
      return fail(
        `The last check of ${WHO[role]} did not finish, so there is nothing to accept. Run it again: bc engine check --for ${role}`,
      );
    if (report.summary(f.result).broken.length)
      return fail(
        `The last check of ${WHO[role]} found a broken safeguard. That can only be accepted in a terminal, where it is shown and you type the engine's name: bc engine check --for ${role}`,
      );
    report.accept(role, f);
    done.push(role);
  }
  if (!done.length) return fail('There is no check waiting to be accepted. Run one: bc engine check');
  return { text: `Accepted for ${done.map((r) => WHO[r]).join(' and ')}.`, data: { accepted: done } };
}

// A different engine. It is checked first, shown, and the owner decides.
export async function use(i, fail) {
  const name = String(i.name ?? '');
  const p = findLoaded(name);
  if (!p?.manifest.engine)
    return fail(
      `No engine called "${name}". There ${enginePlugins().length === 1 ? 'is' : 'are'}: ${
        enginePlugins()
          .map((x) => x.name)
          .join(', ') || 'none'
      }`,
    );
  const roles = rolesOf(i.for);
  if (!roles) return fail(`--for is ${ROLES.join(', ')} or both.`);
  const label = choicesOf(name).label;
  let found = null;
  if (i.check !== false) {
    if (!process.stdin.isTTY)
      return fail(
        `A different engine is checked first, and you decide on what it shows: run this in a terminal. (To switch without checking: --no-check)`,
      );
    const choice = Object.fromEntries(roles.map((r) => [r, { name }]));
    console.log(
      `Before ${label} is used, it is checked: about ${await size(roles, false)} requests to its model, in a temporary copy with made-up messages. Nothing is changed until you accept.\n`,
    );
    found = await runCheck({ roles, choice, say: (l) => console.log(`  ${l}`) });
    console.log();
    if (!(await decide(found, { ask: true }))) return { text: `Not changed: ${label} is not in use.` };
  }
  for (const r of roles) choose(r, { name });
  if (found) {
    const report = await import('./check/report.js');
    for (const r of roles) report.accept(r, found[r]);
  }
  const e = await engineFor(roles[0]);
  const ready = await e.def.ready(e.ctx).catch((err) => ({ ok: false, why: err.message }));
  return {
    text: `${e.label} is now the engine for ${roles.map((r) => WHO[r]).join(' and ')}, with its own defaults${found ? '' : ' (not checked: bc engine check)'}.${ready.ok ? '' : `\nIt is not ready: ${ready.why}`}${roles.includes('chat') ? '\nA conversation in progress starts over with it, and is told what was said.' : ''}\nSee: bc engine status`,
    data: { engine: name, for: roles },
  };
}
