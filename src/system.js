import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import { promisify } from 'node:util';

export const run = (cmd, args) =>
  promisify(execFile)(cmd, args)
    .then((r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }))
    .catch((e) => ({ code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? e.message }));

export async function systemInfo() {
  const temp = await fs
    .readFile('/sys/class/thermal/thermal_zone0/temp', 'utf8')
    .then((t) => Number(t) / 1000)
    .catch(() => null);
  const disk = await fs
    .statfs('/')
    .then((s) => ({ total: s.blocks * s.bsize, free: s.bavail * s.bsize }))
    .catch(() => null);
  return {
    hostname: os.hostname(),
    uptime: os.uptime(),
    temp,
    load: os.loadavg(),
    mem: { total: os.totalmem(), used: os.totalmem() - os.freemem() },
    disk,
  };
}

export function duration(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m ${Math.floor(sec % 60)}s`;
}

export const gb = (b) => (b / 1024 ** 3).toFixed(1);
