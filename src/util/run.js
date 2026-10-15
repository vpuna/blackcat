import { execFile } from 'node:child_process';

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

// Run a command line through bash, the way the owner approved it. Never throws.
// → { code, out (the end of what it printed, stdout then stderr), timedOut }
export const shell = async (cmd, { timeoutMs = 60_000, keep = 3000, cwd } = {}) => {
  const r = await exec('bash', ['-c', cmd], { timeoutMs, maxBuffer: 4 * 1024 ** 2, cwd });
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
