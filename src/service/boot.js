// Starting blackcat when the machine starts. blackcat's own supervisor runs everything; all
// that is asked of the machine is to start that one process at boot and start it again
// should it ever end. Where there is systemd, that is one user unit, written here. In a
// container it is the container's own command and restart policy, and nothing is written.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOME } from '../config.js';
import { run } from '../system.js';
import { BOOT_UNIT, CODE_DIR } from './units.js';

export const UNIT = 'blackcat.service';
export const systemctl = (...args) => run('systemctl', ['--user', ...args]);

// Is there a systemd to ask, for this user?
export async function hasSystemd() {
  if (process.env.BLACKCAT_UNIT_DIR) return true; // (a test, with a stand-in systemctl)
  if (!fs.existsSync('/run/systemd/system')) return false;
  const r = await systemctl('show-environment');
  return r.code === 0;
}

export const unitText = () => `# Written by \`bc service install\`. Changes are overwritten on reinstall.
[Unit]
Description=blackcat: the agent and its services
StartLimitIntervalSec=600
StartLimitBurst=10

[Service]
Type=simple
WorkingDirectory=${CODE_DIR}
ExecStart=${process.execPath} ${path.join(CODE_DIR, 'bin/bc.js')} service run
Environment=PATH=${os.homedir()}/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=BLACKCAT_HOME=${HOME}
# blackcat's own supervisor starts, restarts and stops each service. This starts it at boot,
# and again should it ever end.
Restart=always
RestartSec=5
TimeoutStopSec=40
# Whatever else this machine is for comes first: run at lower CPU and disk priority.
Nice=10
CPUWeight=50
IOSchedulingClass=best-effort
IOSchedulingPriority=7

[Install]
WantedBy=default.target
`;

export const bootInstalled = () => fs.existsSync(BOOT_UNIT);
// The installation the unit there now was written for, if it is not this one.
export function otherHome() {
  try {
    const home = /^Environment=BLACKCAT_HOME=(.+)$/m.exec(fs.readFileSync(BOOT_UNIT, 'utf8'))?.[1];
    return home && path.resolve(home) !== path.resolve(HOME) ? home : null;
  } catch {
    return null;
  }
}
export function writeUnit() {
  fs.mkdirSync(path.dirname(BOOT_UNIT), { recursive: true });
  fs.writeFileSync(BOOT_UNIT, unitText());
}
export const removeUnit = () => fs.rmSync(BOOT_UNIT, { force: true });

export async function lingerEnabled() {
  const { stdout } = await run('loginctl', ['show-user', os.userInfo().username, '-p', 'Linger']);
  return stdout.trim() === 'Linger=yes';
}
