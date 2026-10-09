import { execFile } from 'node:child_process';

// Run a command line through bash, the way the owner approved it. Never throws.
// → { code, out (the end of what it printed, stdout then stderr), timedOut }
export const shell = (cmd, { timeoutMs = 60_000, keep = 3000, cwd } = {}) =>
  new Promise((resolve) => {
    execFile('bash', ['-c', cmd], { timeout: timeoutMs, maxBuffer: 4 * 1024 ** 2, ...(cwd ? { cwd } : {}) }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        out: `${stdout}${stderr}`.trim().slice(-keep),
        timedOut: !!err?.killed,
      });
    });
  });

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
