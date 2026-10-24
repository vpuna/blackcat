import { execFile } from 'node:child_process';
import fs from 'node:fs';

// What looks like a key or a login, by its name.
const SECRET = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIALS?)$/i;
// An environment without the keys and logins in it, but for those whose names `keep` matches.
export function withoutSecrets(env, keep = null) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !SECRET.test(k) || keep?.test(k)));
}

// Run a program, without a shell. Never throws: what went wrong is in what comes back.
// → { code (1 when it could not be run at all), stdout, stderr, timedOut, missing (no such program) }
export const exec = (cmd, args = [], { timeoutMs = 60_000, maxBuffer = 8 * 1024 ** 2, env, cwd, input } = {}) =>
  new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer, ...(env ? { env } : {}), ...(cwd ? { cwd } : {}) },
      (err, stdout, stderr) =>
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: String(stdout ?? ''),
          // (When it could not be run, or was stopped, that is said; a program that ran and failed says for itself.)
          stderr: String(stderr || (err && typeof err.code !== 'number' && !stdout ? err.message : '')),
          timedOut: !!err?.killed,
          missing: err?.code === 'ENOENT',
        }),
    );
    if (input != null) child.stdin.end(input);
  });

// Stop a process and everything it started (it leads a group of its own), or just the
// process when it does not. Never throws: one that has gone already is stopped.
export function killGroup(pid, sig = 'SIGTERM') {
  if (!pid) return;
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch {}
  }
}

// The processes this one started that are still there: [{ pid, cmd }]. (Linux: from each
// process's parent in /proc, which every kernel has; the `children` list needs a kernel
// option some lack, Unraid's for one. Elsewhere none are known.)
export function childProcesses(pid = process.pid) {
  const out = [];
  let all = [];
  try {
    all = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d));
  } catch {}
  for (const d of all) {
    let cmd = '';
    try {
      const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
      // (pid (name) state ppid …: the name may hold spaces and brackets, so after the last ")")
      if (Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) !== pid) continue;
      cmd = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
    } catch {
      continue;
    }
    out.push({ pid: Number(d), cmd });
  }
  return out;
}

// Before a service ends: nothing it started is left behind. Each is given `waitMs` to end by
// itself (it was told to stop), then asked to (with all it started), then killed.
// → { asked: [{ pid, cmd }], killed: [{ pid, cmd }] }: what had to be asked or killed.
export async function endChildren({ waitMs = 3000, graceMs = 3000 } = {}) {
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return !fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.startsWith('Z');
    } catch {
      return false;
    }
  };
  const until = async (ms) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100)))
      if (!childProcesses().some((c) => alive(c.pid))) return;
  };
  await until(waitMs);
  const asked = childProcesses().filter((c) => alive(c.pid));
  for (const c of asked) killGroup(c.pid, 'SIGTERM');
  await until(graceMs);
  const killed = childProcesses().filter((c) => alive(c.pid));
  for (const c of killed) killGroup(c.pid, 'SIGKILL');
  return { asked, killed };
}

// Run a command line through bash, the way the owner approved it. Never throws. `env`: added
// to this process's own. → { code, out (the end of what it printed, stdout then stderr), timedOut }
export const shell = async (cmd, { timeoutMs = 60_000, keep = 3000, cwd, env } = {}) => {
  const r = await exec('bash', ['-c', cmd], {
    timeoutMs,
    maxBuffer: 4 * 1024 ** 2,
    cwd,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  return { code: r.code, out: `${r.stdout}${r.stderr}`.trim().slice(-keep), timedOut: r.timedOut };
};

// The text of a Word document (.docx), or null if it can't be opened.
export const docxText = (file) =>
  new Promise((resolve) => {
    execFile('unzip', ['-p', file, 'word/document.xml'], { maxBuffer: 32 * 1024 ** 2, timeout: 30_000 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(
        stdout
          .replace(/<\/w:p>/g, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'"),
      );
    });
  });
