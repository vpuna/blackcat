// The machine blackcat runs on: how it is doing, and running commands on it. A command that
// only looks runs freely; anything else is asked about, the same rules as for another
// machine over SSH. Whatever its mode, blackcat's own secrets are never read through it.
import { globSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import { classify, expandHome, shell, touchesSecrets } from '../../src/api.js';

const num = (min, max) => (v) =>
  Number.isFinite(Number(v)) && Number(v) >= min && Number(v) <= max ? undefined : `A number from ${min} to ${max}`;

async function health(ctx) {
  const temp = await fs
    .readFile('/sys/class/thermal/thermal_zone0/temp', 'utf8')
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

const MODES = {
  read: 'commands that only look run freely; anything else is refused',
  ask: "commands that only look run freely; anything else needs the owner's approval",
  full: 'any command runs without asking',
};
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
    const expanded = expandHome(w).replace(/\$\{?HOME\}?/g, os.homedir());
    if (!/[/.~*?[]/.test(w)) continue; // not a path
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
    'the machine blackcat runs on: its health (with alerts for heat, a full disk or a weak power supply) and running commands on it',
  help: `Examples:
  bc host health
  bc host run 'df -h'                       a command that only looks runs straight away
  bc host run 'sudo systemctl restart x'    for the agent, anything else needs your approval
  bc host mode ask                          read | ask | full: what the agent may do here
  bc host setup                             when to be alerted`,

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
        const cmd = commandOf(tokens);
        const m = mode(ctx);
        const kind = classify(cmd);
        if (m === 'full' || kind === 'read') return { level: 'allow' };
        if (m === 'ask')
          return { level: 'ask', describe: `on this machine${kind === 'sensitive' ? ', which may show passwords or keys' : ''}` };
        return {
          level: 'never',
          reason:
            kind === 'sensitive'
              ? 'this machine is look-only for you, and that command could show passwords or keys'
              : 'this machine is look-only for you, and that is not a read-only command. Tell the owner what you wanted to run',
        };
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
        const r = await shell(cmd, { timeoutMs: TIMEOUT_MS, keep: MAX_OUTPUT, cwd: os.homedir() });
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

    // A setup command: its questions are asked in the terminal, or in the bot's /setup.
    setup: {
      summary: 'choose when to be alerted',
      // A preference, not a connection or a permission: the agent may change it when you ask, with your say each time.
      access: () => ({ level: 'ask', describe: 'change when this machine alerts you' }),
      form: [
        {
          id: 'alerts',
          type: 'confirm',
          message: 'Send a Telegram alert when this machine runs hot, the disk fills or the power dips?',
          default: (_a, ctx) => ctx.config.get().alerts ?? true,
        },
        {
          id: 'tempLimit',
          type: 'text',
          message: 'Alert above this temperature (°C)',
          default: (_a, ctx) => ctx.config.get().tempLimit ?? 75,
          validate: num(40, 90),
          when: (a) => a.alerts,
        },
        {
          id: 'diskLimit',
          type: 'text',
          message: 'Alert when the disk is fuller than this (%)',
          default: (_a, ctx) => ctx.config.get().diskLimit ?? 90,
          validate: num(50, 99),
          when: (a) => a.alerts,
        },
      ],
      run: (ctx, a) => {
        // (Switched off, the limits are not asked for: the ones that were set stay.)
        const was = ctx.config.get();
        ctx.config.set({
          alerts: !!a.alerts,
          tempLimit: Number(a.tempLimit ?? was.tempLimit ?? 75),
          diskLimit: Number(a.diskLimit ?? was.diskLimit ?? 90),
        });
        return a.alerts ? `Alerts on: above ${a.tempLimit}°C, disk over ${a.diskLimit}%, or a power dip.` : 'Alerts off.';
      },
    },
  },

  // A scheduled job. It runs in its own process; ctx.notify sends the owner a Telegram message.
  jobs: [
    {
      id: 'watch',
      cron: '*/10 * * * *', // every ten minutes
      summary: 'alert on heat, a full disk or under-voltage',
      run: async (ctx) => {
        const cfg = { alerts: true, tempLimit: 75, diskLimit: 90, ...ctx.config.get() };
        if (!cfg.alerts) return { idle: true };
        const h = await health(ctx);
        const problems = [];
        if (h.tempC > cfg.tempLimit) problems.push(`it is ${h.tempC.toFixed(1)}°C (limit ${cfg.tempLimit}°C)`);
        if (h.diskUsedPercent > cfg.diskLimit) problems.push(`the disk is ${h.diskUsedPercent}% full (limit ${cfg.diskLimit}%)`);
        if (h.underVoltageNow) problems.push('the power supply voltage is too low right now');
        // Say it once per problem, not every ten minutes.
        const key = problems
          .map((p) => p.replace(/[\d.]+/g, '#'))
          .sort()
          .join('|');
        if (key && key !== cfg.lastAlert) await ctx.notify(`🖥 ${os.hostname()}: ${problems.join('; ')}.`);
        if (key !== (cfg.lastAlert ?? '')) ctx.config.set({ lastAlert: key });
        // (For the activity record: nothing to note unless something changed.)
        return key !== (cfg.lastAlert ?? '') ? { did: key ? `alerted: ${problems.join('; ')}` : 'back to normal' } : { idle: true };
      },
    },
  ],

  settings: (ctx) => {
    const c = { alerts: true, tempLimit: 75, diskLimit: 90, ...ctx.config.get() };
    return {
      ...(c.alerts
        ? { alerts: 'on', 'alert above': `${c.tempLimit}°C`, 'alert when the disk is over': `${c.diskLimit}%` }
        : { alerts: 'off' }),
      "the agent's mode": `${mode(ctx)}: ${MODES[mode(ctx)]}`,
    };
  },

  // Shown in `bc status`.
  // `bc selftest`: can the machine's own figures be read.
  selftest: (ctx) => [{ name: os.hostname(), run: async () => line(await health(ctx)) }],

  status: async (ctx) => `${line(await health(ctx))} · the agent's mode here: ${mode(ctx)}`,

  // Added to the agent's instructions while the plugin is enabled.
  // For `bc engine check`: what the owner might say, and the command it should lead to.
  checks: [{ say: 'how hot is this machine running, and how full is its disk', expect: /blackcat host (health|status)\b/ }],
  agent: {
    fill: (ctx) => ({ hostname: os.hostname(), mode: MODES[mode(ctx)] }),
  },
};
