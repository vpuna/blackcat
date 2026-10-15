// Carrying out a call to one of the four tools. Nothing here decides whether it MAY be done:
// that is the policy's, asked first by whoever calls `run` (src/agent/brain.js). This only
// does it, within limits: a time limit and an output limit on a command, a size limit on a
// file, and paths made plain (no link left to follow) before they are judged or opened.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec, killGroup, withoutSecrets } from '../util/run.js';
import { plural } from '../util/format.js';

export const LIMITS = {
  commandS: 120,
  commandMaxS: 280,
  output: 30_000,
  lines: 2000,
  lineChars: 2000,
  fileChars: 100_000,
  fileBytes: 30 * 1024 ** 2,
  matches: 250,
  found: 200,
  picture: 1568,
};

const text = (t) => [{ type: 'text', text: String(t) }];
export class ToolError extends Error {}
const fail = (m) => {
  throw new ToolError(m);
};

// A path as given → the real file it names: relative to the agent's folder, `~` expanded,
// and every link followed, so that what is judged is what would be opened. A file that
// does not exist yet keeps its name, under its folder's real path.
export function realPath(given, cwd) {
  const s = String(given ?? '').trim();
  if (!s) fail('Which file? Give file_path.');
  if (s.includes('\0')) fail('That is not a file name.');
  const p = path.resolve(cwd, s === '~' || s.startsWith('~/') ? path.join(os.homedir(), s.slice(1)) : s);
  try {
    return fs.realpathSync(p);
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(p)), path.basename(p));
    } catch {
      return p;
    }
  }
}

// ---- bash ----

// What a command the agent runs may see of blackcat's own surroundings: nothing that is a
// key or a login. (The engine's key, when it has one, is the engine's process's, not ours.)
function cleanEnv(extra) {
  const env = withoutSecrets(process.env);
  for (const k of Object.keys(env)) if (/^(ANTHROPIC_|OPENAI_|GEMINI_|GOOGLE_API|AWS_|CLAUDE|BLACKCAT_SLOW$)/i.test(k)) delete env[k];
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (v == null) delete env[k];
    else env[k] = String(v);
  }
  return env;
}

// Long output keeps its start and its end: the middle is what is left out.
export function clip(s, max = LIMITS.output) {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  return `${s.slice(0, head)}\n\n[… ${s.length - max} characters left out of the middle …]\n\n${s.slice(-tail)}`;
}

// → { content, isError }. `running`: a set this call adds itself to while it runs, so that
// whoever owns the conversation can stop what is still going when the conversation ends.
function bash(input, { cwd, env, running }) {
  const command = String(input.command ?? '');
  if (!command.trim()) fail('Which command? Give command.');
  const seconds = Math.min(LIMITS.commandMaxS, Math.max(1, Number(input.timeout) || LIMITS.commandS));
  return new Promise((resolve) => {
    // Its own process group, so that everything it started goes when it is stopped.
    const child = spawn('bash', ['-c', command], { cwd, env: cleanEnv(env), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    let dropped = 0;
    const add = (d) => {
      // Enough is kept to give the start and the end; a command that pours out megabytes does not fill memory.
      out += d;
      if (out.length > LIMITS.output * 4) {
        const cut = out.length - LIMITS.output * 3;
        dropped += cut;
        out = out.slice(0, LIMITS.output) + out.slice(LIMITS.output + cut);
      }
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    let why = null;
    const kill = (reason) => {
      why ??= reason;
      for (const sig of ['SIGTERM', 'SIGKILL']) {
        setTimeout(() => killGroup(child.pid, sig), sig === 'SIGKILL' ? 2000 : 0).unref();
      }
    };
    const timer = setTimeout(() => kill(`It was stopped after ${seconds} seconds.`), seconds * 1000);
    const entry = { stop: () => kill('It was stopped: the conversation ended.') };
    running?.add(entry);
    child.on('error', (e) => {
      clearTimeout(timer);
      running?.delete(entry);
      resolve({ content: text(`Could not run it: ${e.message}`), isError: true });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      running?.delete(entry);
      const body = clip(out.replace(/\s+$/, '')) + (dropped ? `\n[${dropped} more characters were not kept.]` : '');
      if (why) return resolve({ content: text(`${body}${body ? '\n\n' : ''}${why}`), isError: true });
      if (code !== 0) return resolve({ content: text(`${body}${body ? '\n\n' : ''}Exit code ${code ?? signal}`), isError: true });
      return resolve({ content: text(body || '(no output)'), isError: false });
    });
  });
}

// ---- read ----

const PICTURES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };

// A picture, made small enough to look at: a camera's full frame is far larger than a model
// takes in, and costs accordingly.
async function picture(file) {
  const { default: sharp } = await import('sharp');
  const img = sharp(file, { failOn: 'none' }).rotate();
  const meta = await img.metadata();
  const big = Math.max(meta.width ?? 0, meta.height ?? 0) > LIMITS.picture;
  const buf = await (big ? img.resize({ width: LIMITS.picture, height: LIMITS.picture, fit: 'inside' }) : img)
    .jpeg({ quality: 82 })
    .toBuffer();
  return [
    { type: 'text', text: `The picture ${file} (${meta.width}×${meta.height}${big ? `, shown smaller` : ''}):` },
    { type: 'image', data: buf.toString('base64'), mimeType: 'image/jpeg' },
  ];
}

const run = (cmd, args, opts = {}) => exec(cmd, args, opts);

function numbered(all, input) {
  const lines = all.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const from = Math.max(1, Math.floor(Number(input.offset) || 1));
  const count = Math.max(1, Math.min(LIMITS.lines, Math.floor(Number(input.limit) || LIMITS.lines)));
  if (!lines.length) return '(the file is empty)';
  if (from > lines.length) return `(the file has ${plural(lines.length, 'line')}: nothing at line ${from})`;
  const shown = lines.slice(from - 1, from - 1 + count);
  let body = shown
    .map((l, i) => `${String(from + i).padStart(6)}\t${l.length > LIMITS.lineChars ? `${l.slice(0, LIMITS.lineChars)}… [line cut]` : l}`)
    .join('\n');
  let cut = false;
  if (body.length > LIMITS.fileChars) {
    body = body.slice(0, body.lastIndexOf('\n', LIMITS.fileChars));
    cut = true;
  }
  const last = from - 1 + body.split('\n').length;
  return last < lines.length || cut ? `${body}\n\n[Lines ${from} to ${last} of ${lines.length}. For more: offset ${last + 1}.]` : body;
}

async function read(input, { file }) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    fail(`There is no file at ${file}.`);
  }
  if (st.isDirectory()) fail(`${file} is a folder. To see what is in it, use glob with path "${file}" and pattern "*".`);
  if (!st.isFile()) fail(`${file} is not an ordinary file.`);
  if (st.size > LIMITS.fileBytes) fail(`${file} is ${(st.size / 1024 ** 2).toFixed(0)} MB: too large to read.`);
  const ext = path.extname(file).toLowerCase();
  if (PICTURES[ext]) {
    try {
      return { content: await picture(file), isError: false };
    } catch (e) {
      fail(`${file} could not be read as a picture (${e.message}).`);
    }
  }
  if (ext === '.pdf') {
    const r = await run('pdftotext', ['-layout', file, '-']);
    if (r.missing) fail('A PDF needs the pdftotext program, which is not installed here (the package poppler-utils).');
    if (r.code !== 0) fail(`${file} could not be read as a PDF: ${r.stderr.trim().slice(0, 200)}`);
    return { content: text(r.stdout.trim() ? numbered(r.stdout, input) : '(the PDF has no text in it: it may be a scan)'), isError: false };
  }
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 8192).includes(0)) fail(`${file} is not text (${st.size} bytes of something else).`);
  return { content: text(numbered(buf.toString('utf8'), input)), isError: false };
}

// ---- glob, grep ----

function glob(input, { file: base }) {
  const pattern = String(input.pattern ?? '').trim();
  if (!pattern) fail('Which files? Give pattern.');
  // The pattern stays inside the folder it is asked of: the folder is what was judged.
  if (path.isAbsolute(pattern) || pattern.split(/[\\/]/).includes('..'))
    fail('The pattern is relative to `path`, and cannot leave it: give the folder as `path`.');
  let names;
  try {
    names = fs.globSync(pattern, { cwd: base, exclude: (n) => n === 'node_modules' || n === '.git' });
  } catch (e) {
    fail(`That pattern could not be used: ${e.message}`);
  }
  const found = [];
  for (const n of names) {
    try {
      const st = fs.lstatSync(path.join(base, n));
      found.push({ n, dir: st.isDirectory(), t: st.mtimeMs });
    } catch {}
  }
  found.sort((a, b) => b.t - a.t || (a.n < b.n ? -1 : a.n > b.n ? 1 : 0)); // (changed at the same moment: by name)
  if (!found.length) return { content: text(`Nothing in ${base} matches ${pattern}.`), isError: false };
  const shown = found
    .slice(0, LIMITS.found)
    .map((f) => path.join(base, f.n) + (f.dir ? '/' : ''))
    .join('\n'); // a folder ends in /
  return {
    content: text(found.length > LIMITS.found ? `${shown}\n\n[The newest ${LIMITS.found} of ${found.length}.]` : shown),
    isError: false,
  };
}

async function grep(input, { file: base }) {
  const pattern = String(input.pattern ?? '');
  if (!pattern) fail('What to look for? Give pattern.');
  // -r, not -R: a link inside the folder is not followed out of it. The pattern and the
  // names are arguments, never part of a command line.
  const args = [
    '-rIn',
    '-E',
    '--color=never',
    '--exclude-dir=.git',
    '--exclude-dir=node_modules',
    ...(input.ignore_case ? ['-i'] : []),
    ...(input.files_only ? ['-l'] : []),
    ...(input.glob ? [`--include=${String(input.glob)}`] : []),
    '-e',
    pattern,
    '--',
    base,
  ];
  const r = await run('grep', args, { cwd: path.dirname(base) });
  if (r.code > 1) fail(`The search failed: ${r.stderr.trim().slice(0, 200) || 'the pattern could not be used'}`);
  // In the order of the files' names, then of their lines: what a folder happens to hand
  // back first differs from one file system to the next, and the answer should not.
  const at = (l) => /^(.*?):(\d+):/.exec(l) ?? [null, l, 0];
  const lines = r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => ({ l, k: at(l) }))
    .sort((a, b) => (a.k[1] < b.k[1] ? -1 : a.k[1] > b.k[1] ? 1 : Number(a.k[2]) - Number(b.k[2])))
    .map((x) => x.l);
  if (!lines.length) return { content: text(`Nothing in ${base} matches.`), isError: false };
  const shown = lines
    .slice(0, LIMITS.matches)
    .map((l) => (l.length > 400 ? `${l.slice(0, 400)}…` : l))
    .join('\n');
  return {
    content: text(lines.length > LIMITS.matches ? `${shown}\n\n[The first ${LIMITS.matches} of ${lines.length} matches.]` : shown),
    isError: false,
  };
}

const DO = { bash, read, glob, grep };
// Which tools name a file or folder, and what they mean when none is named.
const NAMES_A_PATH = { read: 'file_path', glob: 'path', grep: 'path' };

// What a call is about, made plain for the policy: the input with its path, if it has one,
// replaced by the real path it names. → { input, file }
export function settle(tool, input, cwd) {
  const key = NAMES_A_PATH[tool];
  if (!key) return { input: { ...input }, file: null };
  const file = realPath(input?.[key] ?? (key === 'path' ? '.' : ''), cwd);
  return { input: { ...input, [key]: file }, file };
}

// Carry it out. `call`: what `settle` gave. → { content, isError }: never throws for
// something the model got wrong, which is said to it instead.
export async function run_(tool, call, env = {}) {
  if (!DO[tool]) return { content: text(`There is no tool called ${tool}.`), isError: true };
  try {
    return await DO[tool](call.input, { ...env, file: call.file });
  } catch (e) {
    if (e instanceof ToolError) return { content: text(e.message), isError: true };
    return { content: text(`It failed: ${e.message}`), isError: true };
  }
}
export { run_ as run };
