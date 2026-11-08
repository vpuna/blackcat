// The machine blackcat runs on: how it is doing, and running commands on it. A command that
// only looks runs freely; anything else is asked about, the same rules as for another
// machine over SSH. Whatever its mode, blackcat's own secrets are never read through it.
import { existsSync, globSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import { COMMAND_MODES, commandAccess, expandHome, shell, touchesSecrets } from '../../src/api.js';

const THERMAL = '/sys/class/thermal/thermal_zone0/temp';
// (A Raspberry Pi says whether its power supply dipped: vcgencmd.)
const hasPower = () => ['/usr/bin/vcgencmd', '/usr/local/bin/vcgencmd', '/opt/vc/bin/vcgencmd'].some((f) => existsSync(f));

async function health(ctx) {
  const temp = await fs
    .readFile(THERMAL, 'utf8')
    .then((t) => Number(t) / 1000)
    .catch(() => null);
  const disk = await fs
    .statfs('/')
    .then((s) => Math.round((1 - s.bavail / s.blocks) * 100))
    .catch(() => null);
  // Bit 0 = under-voltage now, bit 16 = under-voltage since boot (a weak power supply).
  const t = await ctx.exec('vcgencmd', ['get_throttled']);
  const flags = t.code === 0 ? parseInt(t.stdout.split('=')[1], 16) : null;
  return {
    tempC: temp,
    diskUsedPercent: disk,
    load: os.loadavg().map((l) => Number(l.toFixed(2))),
    memoryUsedPercent: Math.round((1 - os.freemem() / os.totalmem()) * 100),
    uptimeHours: Math.round(os.uptime() / 3600),
    underVoltageNow: flags == null ? null : !!(flags & 0x1),
    underVoltageSinceBoot: flags == null ? null : !!(flags & 0x10000),
    throttledSinceBoot: flags == null ? null : !!(flags & 0x40000),
  };
}

const MODES = COMMAND_MODES;
const mode = (ctx) => (MODES[ctx.config.get().mode] ? ctx.config.get().mode : 'ask');
const TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 20_000;
// `bc host run 'df -h'` arrives as one word; `bc host run df -h` as several.
const commandOf = (tokens) => (tokens.length === 1 ? tokens[0] : tokens.join(' '));

// A word of the command that names one of blackcat's private files or folders, or a folder
// that holds them. Wildcards are expanded and links followed, the way the shell would, so
// the check is made on the files the command would really reach.
function privatePath(cmd) {
  // Does the command read through whole folders (a recursive search, a copy, an archive)?
  const deep =
    /\b(tar|zip|7z|rsync|scp|cp|mv|dd|strings|xxd|base64)\b|\b(grep|egrep|fgrep|zgrep|rg|ag)\b[^|;&]*\s(-[a-zA-Z]*[rR]|--recursive|--dereference-recursive)\b|\bfind\b[^|;&]*-exec/.test(
      cmd,
    );
  const words = cmd
    .replace(/['"]/g, ' ')
    .split(/[\s=|;&<>()]+/)
    .filter((w) => w && !w.startsWith('-'));
  for (const w of words) {
    // (Every word may be a path: "blackcat" is the folder of that name in the home folder,
    // where a command runs.)
    const expanded = expandHome(w).replace(/\$\{?HOME\}?/g, os.homedir());
    let found = [expanded];
    if (/[*?[]/.test(expanded)) {
      try {
        found = globSync(expanded, { cwd: os.homedir() });
      } catch {
        found = [expanded];
      }
    }
    for (const f of found) if (touchesSecrets(pathOf(f), { deep })) return w;
  }
  return null;
}
const pathOf = (f) => (f.startsWith('/') ? f : `${os.homedir()}/${f}`);

const line = (h) =>
  [
    h.tempC != null ? `${h.tempC.toFixed(1)}°C` : null,
    `load ${h.load[0]}`,
    `memory ${h.memoryUsedPercent}%`,
    h.diskUsedPercent != null ? `disk ${h.diskUsedPercent}%` : null,
    h.underVoltageSinceBoot ? '⚠️ power supply dipped since boot' : null,
  ]
    .filter(Boolean)
    .join(' · ');

export default {
  api: 1,
  name: 'host',
  title: 'This machine',
  description:
    'the machine blackcat runs on: its health (a check offered for heat, a full disk or a weak power supply) and running commands on it',
  help: `Examples:
  bc host health
  bc host run 'df -h'                       a command that only looks runs straight away
  bc host run 'sudo systemctl restart x'    for the agent, anything else needs your approval
  bc host mode ask                          read | ask | full: what the agent may do here
  bc check add --from host:health           be told when it runs hot, the disk fills or the power dips`,

  commands: {
    // A read-only command the agent may run without asking.
    health: {
      summary: 'temperature, load, memory, disk and power-supply warnings',
      access: 'allow',
      untrusted: false, // the output is measurements, not text written by other people
      run: async (ctx) => {
        const h = await health(ctx);
        return { text: line(h), data: h };
      },
    },

    run: {
      summary: "run a command on this machine: bc host run '<command>'",
      raw: true,
      // Decided per command: the mode, and whether the command only looks.
      access: (ctx, tokens) => {
        if (!tokens.length) return { level: 'never', reason: 'say what to run' };
        return commandAccess(mode(ctx), commandOf(tokens), { where: 'on this machine', machine: 'this machine' });
      },
      run: async (ctx, { _: tokens }) => {
        if (!tokens?.length) ctx.fail("Usage: bc host run '<command>'");
        const cmd = commandOf(tokens);
        // Whatever the mode, and however the command is put together: not blackcat's own secrets.
        if (ctx.caller !== 'owner') {
          const hit = privatePath(cmd);
          if (hit) ctx.fail(`Not run: ${hit} is one of blackcat's own private files or folders, which can't be read through this command.`);
        }
        // Run from the home folder, so a relative path means the same thing every time.
        const r = await shell(cmd, { timeoutMs: TIMEOUT_MS, keep: MAX_OUTPUT, cwd: os.homedir(), secrets: false });
        return {
          text: [r.out, r.timedOut ? '(stopped: it ran longer than the time limit)' : r.code ? `(exit code ${r.code})` : null]
            .filter(Boolean)
            .join('\n'),
          data: { command: cmd, exitCode: r.code, timedOut: r.timedOut, output: r.out },
        };
      },
    },

    mode: {
      summary: 'what the agent may do on this machine: read, ask or full',
      access: 'owner',
      usage: '[mode]',
      run: (ctx, i) => {
        if (!i.mode) return `${mode(ctx)}: ${MODES[mode(ctx)]}.`;
        if (!MODES[i.mode]) ctx.fail(`The mode is one of: ${Object.keys(MODES).join(', ')}.`);
        ctx.config.set({ mode: i.mode });
        return `This machine is now "${i.mode}": ${MODES[i.mode]}.`;
      },
    },
  },

  settings: (ctx) => ({
    alerts: 'the check offered: bc check add --from host:health',
    "the agent's mode": `${mode(ctx)}: ${MODES[mode(ctx)]}`,
  }),

  // Shown in `bc status`.
  // `bc selftest`: can the machine's own figures be read.
  selftest: (ctx) => [{ name: os.hostname(), run: async () => line(await health(ctx)) }],

  status: async (ctx) => `${line(await health(ctx))} · the agent's mode here: ${mode(ctx)}`,

  // Added to the agent's instructions while the plugin is enabled.
  // For `bc engine check`: what the owner might say, and the command it should lead to.
  // A check offered (bc check offered): this machine's figures kept over time, what was using it
  // when one went past a limit, and the limits it tells at: hotter than 75°C, a disk fuller than
  // 90%, a power dip. Only what this machine can measure. (The limits once set with this
  // plugin's own setup, before the check took its place, are kept.)
  checks: (ctx) => {
    const c = ctx.config.get();
    const temp = existsSync(THERMAL);
    const power = hasPower();
    return [
      {
        id: 'health',
        name: 'This machine',
        summary: `this machine's temperature, load, memory and disk, every 5 minutes; tells you ${[temp && 'when it runs hot', 'when the disk fills', power && 'when the power dips'].filter(Boolean).join(', ')}`,
        run: 'blackcat host health --json',
        measure: [...(temp ? ['tempC'] : []), 'load.0', 'memoryUsedPercent', 'diskUsedPercent', ...(power ? ['underVoltageNow'] : [])],
        limit: [
          ...(temp ? [`tempC>${c.tempLimit ?? 75}`] : []),
          `diskUsedPercent>${c.diskLimit ?? 90}`,
          ...(power ? ['underVoltageNow>0'] : []),
        ],
        context: 'ps -eo pcpu,pmem,comm --sort=-pcpu | head -11',
        every: '5m',
      },
    ];
  },
  trials: [{ say: 'how hot is this machine running, and how full is its disk', expect: /blackcat host (health|status)\b/ }],
  agent: {
    fill: (ctx) => ({ hostname: os.hostname(), mode: MODES[mode(ctx)] }),
  },
};
