// `bc selftest`: does everything that is set up actually work, right now?
//
// One read-only probe for each thing that is configured: every machine reached over SSH,
// every mail account, every calendar, each device system, the chat, the engine, the
// databases. Nothing is changed anywhere: a probe logs in, asks, and looks. (`bc status`
// says what blackcat last saw; this goes and asks.)
//
// A part of blackcat, or a plugin, offers its probes with `selftest` in its manifest:
//
//   selftest: (ctx) => [{ name: 'nas', run: async () => 'Linux 6.1' }, …]
//
// one per thing it has set up. `run` gives back a few words when all is well, and throws
// with a sentence when it is not. Throwing an error with `skip: true` (or returning
// { skip: 'why' }) means there was nothing to test, which is not a failure.
import fs from 'node:fs';
import path from 'node:path';
import { DATA, CONFIG_FILE } from './config.js';
import { openSqlite, withDb } from './db.js';
import { loadPlugins, loaded, makeCtx } from './plugins/registry.js';

// (The timer is what keeps the process alive for a probe that never answers; the command ends it itself when all are in.)
const PROBE_MS = 30_000;
const within = (ms, p) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`no answer within ${ms / 1000} s`)), ms))]);

// blackcat's own: what no plugin could say.
function own() {
  const probes = [];
  probes.push({
    name: 'settings file',
    run: () => {
      if (!fs.existsSync(CONFIG_FILE)) return { skip: 'nothing has been set up yet' };
      const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      return `readable · ${Object.keys(c.plugins?.settings ?? {}).length} parts have settings`;
    },
  });
  for (const [dir, files] of [
    [DATA, fs.existsSync(DATA) ? fs.readdirSync(DATA) : []],
    ...(fs.existsSync(path.join(DATA, 'plugins'))
      ? fs
          .readdirSync(path.join(DATA, 'plugins'))
          .map((n) => [path.join(DATA, 'plugins', n), fs.readdirSync(path.join(DATA, 'plugins', n))])
      : []),
  ]) {
    for (const f of files.filter((n) => n.endsWith('.db'))) {
      const file = path.join(dir, f);
      probes.push({
        name: `database ${path.relative(DATA, file)}`,
        run: () =>
          withDb(
            () => openSqlite(file, { readonly: true }),
            (db) => {
              const said = db.pragma('quick_check', { simple: true });
              if (said !== 'ok') throw new Error(`it is damaged: ${String(said).slice(0, 120)}`);
              return `sound · ${(fs.statSync(file).size / 1024 ** 2).toFixed(1)} MB`;
            },
          ),
      });
    }
  }
  if (fs.existsSync(path.join(DATA, 'plugins'))) {
    probes.push({
      name: 'secrets files',
      run: () => {
        let n = 0;
        for (const p of fs.readdirSync(path.join(DATA, 'plugins'))) {
          const f = path.join(DATA, 'plugins', p, 'secrets.json');
          if (!fs.existsSync(f)) continue;
          try {
            JSON.parse(fs.readFileSync(f, 'utf8'));
          } catch {
            throw new Error(`the secrets of ${p} cannot be read (the file is damaged)`);
          }
          if (fs.statSync(f).mode & 0o077)
            throw new Error(`the secrets of ${p} can be read by other accounts on this machine: chmod 600 ${f}`);
          n++;
        }
        return `${n} readable, and private`;
      },
    });
  }
  probes.push({
    name: 'plugins',
    run: async () => {
      const { refused, loaded: on } = await import('./plugins/registry.js');
      const no = refused();
      if (no.length) throw new Error(`not loaded: ${no.map((r) => `${r.name} (${r.why})`).join('; ')}`);
      return `${on().length} parts and plugins loaded, none refused`;
    },
  });
  probes.push({
    name: 'free space',
    run: () => {
      const s = fs.statfsSync(DATA);
      const gb = (s.bavail * s.bsize) / 1024 ** 3;
      if (gb < 0.5) throw new Error(`only ${Math.round(gb * 1024)} MB free where blackcat keeps its data`);
      return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB free`;
    },
  });
  probes.push({
    name: 'services',
    run: async () => {
      const { services, isInstalled, show } = await import('./service/units.js');
      const { otherHome } = await import('./service/commands.js');
      // (Only this installation's: a service installed from another folder is not this one's to answer for.)
      const all = Object.entries(await services()).filter(([, svc]) => isInstalled(svc) && !otherHome(svc));
      if (!all.length) return { skip: 'none installed (bc service install)' };
      const down = [];
      // (One that waits for something to be set up, an account not linked yet, is not a fault.)
      const waits = [];
      for (const [id, svc] of all) {
        const s = await show(svc);
        if (s.SubState === 'waiting') waits.push(id);
        else if (s.ActiveState !== 'active') down.push(id);
      }
      if (down.length) throw new Error(`not running: ${down.join(', ')} (bc start)`);
      const up = all.map(([id]) => id).filter((id) => !waits.includes(id));
      if (!up.length) return { skip: `none is set up to run yet (${waits.join(', ')})` };
      return `${up.join(', ')}: running${waits.length ? ` · not set up yet: ${waits.join(', ')}` : ''}`;
    },
  });
  probes.push({
    name: 'the chat',
    run: async () => {
      const { activeChannel, activeName, labelOf } = await import('./channels/registry.js');
      if (!activeName()) return { skip: 'no channel is in use: the terminal only (bc channel)' };
      if (!activeChannel()) throw new Error(`${labelOf(activeName())} is the channel in use, and it is not paired`);
      return `${labelOf(activeName())}, paired`;
    },
  });
  for (const role of ['chat', 'readers']) {
    probes.push({
      name: `engine for ${role}`,
      run: async () => {
        const { engineFor } = await import('./engines/registry.js');
        const e = await engineFor(role);
        const r = await e.def.ready(e.ctx);
        // A model that was never set up and checked is not expected: blackcat runs without one.
        if (!r.ok) {
          const { lastAccepted } = await import('./engines/check/report.js');
          if (!lastAccepted(role)) return { skip: `no model (${r.why}): commands, shortcuts, reminders and checks work without one` };
          throw new Error(`${e.label} is not ready: ${r.why}`);
        }
        return `${e.label}, ready${e.model ? ` · model ${e.model}` : ''}`;
      },
    });
  }
  probes.push({
    name: 'scheduled work',
    run: async () => {
      const { openAgentDb } = await import('./agentdb.js');
      const { hasTable } = await import('./db.js');
      return withDb(openAgentDb, (db) => {
        if (!hasTable(db, 'activity')) return { skip: 'no record is kept (bc activity setup)' };
        // The last run of each job, in the last two days: did it fail?
        const rows = db
          .prepare("SELECT category, ok, summary, MAX(ts) AS ts FROM activity WHERE kind = 'job' AND ts > ? GROUP BY category")
          .all(Math.floor(Date.now() / 1000) - 2 * 86400);
        const failed = rows.filter((r) => !r.ok);
        if (failed.length)
          throw new Error(
            `the last run failed for: ${failed.map((r) => `${r.category} (${String(r.summary ?? '').slice(0, 80)})`).join('; ')}`,
          );
        return rows.length ? `${rows.length} jobs, each one's last run went well` : { skip: 'nothing has run in the last two days' };
      });
    },
  });
  return probes;
}

// Every probe there is, by who offers it. → [{ part, title, probes }]
async function gather(only) {
  await loadPlugins();
  const groups = [{ part: 'blackcat', title: 'blackcat itself', probes: own() }];
  for (const p of loaded()) {
    if (!p.manifest.selftest) continue;
    let probes = [];
    try {
      probes = (await p.manifest.selftest(makeCtx(p, { caller: 'owner', surface: 'job' }))) ?? [];
      if (!Array.isArray(probes)) throw new Error('selftest must return a list');
    } catch (e) {
      probes = [
        {
          name: 'its tests',
          run: () => {
            throw new Error(`could not be worked out: ${e.message}`);
          },
        },
      ];
    }
    groups.push({
      part: p.name,
      title: p.manifest.title,
      probes: probes.filter((x) => x && typeof x.name === 'string' && typeof x.run === 'function'),
    });
  }
  return only?.length ? groups.filter((g) => only.includes(g.part)) : groups;
}

// Run them. Each part's probes one after another, the parts side by side.
// → { ok, passed, failed, skipped, parts: [{ part, title, results: [{ name, outcome: 'ok' | 'failed' | 'skipped', detail, ms }] }] }
export async function selftest({ only, onResult } = {}) {
  const groups = await gather(only);
  const parts = await Promise.all(
    groups.map(async (g) => {
      const results = [];
      for (const probe of g.probes) {
        const t0 = Date.now();
        let r;
        try {
          const said = await within(
            probe.timeoutMs ?? PROBE_MS,
            Promise.resolve().then(() => probe.run()),
          );
          r =
            said && typeof said === 'object' && said.skip
              ? { outcome: 'skipped', detail: String(said.skip) }
              : { outcome: 'ok', detail: said == null ? '' : String(said) };
        } catch (e) {
          r = e?.skip ? { outcome: 'skipped', detail: e.message } : { outcome: 'failed', detail: e?.message ?? String(e) };
        }
        const res = { name: probe.name, ...r, ms: Date.now() - t0 };
        results.push(res);
        onResult?.(g, res);
      }
      return { part: g.part, title: g.title, results };
    }),
  );
  const all = parts.flatMap((p) => p.results);
  const count = (o) => all.filter((r) => r.outcome === o).length;
  return {
    ok: count('failed') === 0,
    passed: count('ok'),
    failed: count('failed'),
    skipped: count('skipped'),
    parts: parts.filter((p) => p.results.length),
  };
}

// `bc selftest [part…] [--json]`
export async function command(names, opts) {
  const pc = (await import('picocolors')).default;
  const known = (await gather()).map((g) => g.part);
  const wrong = (names ?? []).filter((n) => !known.includes(n));
  if (wrong.length) {
    console.error(`Nothing to test called ${wrong.map((n) => `"${n}"`).join(', ')}. There is: ${known.join(', ')}.`);
    process.exit(1);
  }
  if (!opts.json && process.stdout.isTTY)
    console.log(pc.dim('Asking each thing that is set up whether it works. Nothing is changed anywhere.\n'));
  const out = await selftest({ only: names });
  if (opts.json) console.log(JSON.stringify(out, null, 2));
  else {
    const mark = { ok: pc.green('✓'), failed: pc.red('✗'), skipped: pc.dim('·') };
    for (const p of out.parts) {
      console.log(pc.bold(p.title));
      for (const r of p.results)
        console.log(
          `  ${mark[r.outcome]} ${r.name}${r.detail ? `: ${r.outcome === 'failed' ? pc.red(r.detail) : r.detail}` : ''}${r.ms >= 1000 ? pc.dim(`  (${(r.ms / 1000).toFixed(1)} s)`) : ''}`,
        );
    }
    console.log(
      `\n${out.ok ? pc.green('All well') : pc.red(`${out.failed} not working`)}: ${out.passed} working${out.failed ? `, ${out.failed} not` : ''}${out.skipped ? `, ${out.skipped} with nothing to test` : ''}.`,
    );
  }
  // (Decided here, and at once: a probe that never answered must not keep this waiting.)
  process.exit(out.ok ? 0 : 1);
}
