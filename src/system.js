import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import { exec } from './util/run.js';

export const run = (cmd, args) => exec(cmd, args);

// Running in a container (Docker sets /.dockerenv; another can say so with BLACKCAT_KEEPER).
export const inContainer = () => existsSync('/.dockerenv') || !!process.env.BLACKCAT_KEEPER;

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
