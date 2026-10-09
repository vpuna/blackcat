#!/usr/bin/env node
// Runs the tests.
//
//   npm test                  lint, format check, then every test file
//   npm test -- watch bot     only the test files with these words in their names
//   npm run test:changed      lint, format check, and the test files a change touches
//
// Options: --jobs N (test files at once; default: one per core), --no-lint, --list (say
// what would run, and run nothing).
//
// Each test file is a process of its own with its own empty installation, so files can run
// side by side. The slowest are started first (from how long each took last time), which is
// what keeps the last minute of a run from being one long file on its own.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const valueOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const words = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--jobs');
const jobs = Math.max(1, Number(valueOf('--jobs')) || os.availableParallelism());
const TIMES = path.join(root, 'node_modules/.cache/blackcat-test-times.json');
const KEPT = path.join(root, 'node_modules/.cache/blackcat-test-failures');
const times = (() => {
  try {
    return JSON.parse(fs.readFileSync(TIMES, 'utf8'));
  } catch {
    return {};
  }
})();

const every = fs
  .readdirSync(path.join(root, 'test'))
  .filter((f) => f.endsWith('.test.js'))
  .map((f) => `test/${f}`);
const nameOf = (f) => path.basename(f, '.test.js');

// ---- which test files a change touches

function changedFiles() {
  const git = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' }).stdout.trim();
  const base = git('merge-base', 'HEAD', 'main') || 'HEAD';
  const out = new Set([
    ...git('diff', '--name-only', base).split('\n'), // committed on this branch, and not yet committed
    ...git('ls-files', '--others', '--exclude-standard').split('\n'), // new files
  ]);
  out.delete('');
  return [...out];
}

// The test files that have to do with a changed file: by the part of blackcat it is in.
export function touchedBy(changed, tests = every, read = (f) => fs.readFileSync(path.join(root, f), 'utf8')) {
  const all = () => new Set(tests);
  const out = new Set();
  const keys = new Set();
  for (const f of changed) {
    if (/^(docs\/|.*\.md$|\.git|\.prettier|LICENSE)/.test(f)) continue;
    if (f.startsWith('test/') && f.endsWith('.test.js')) out.add(f);
    else if (/^(test\/|scripts\/|bin\/|package(-lock)?\.json$|eslint\.config\.js$)/.test(f)) return all();
    else {
      const m = /^(?:src|plugins|agent)\/([^/]+)\/|^src\/([^/]+)\.js$/.exec(f);
      if (!m) return all();
      keys.add(m[1] ? { dir: m[1] } : { file: m[2] });
    }
  }
  if (!keys.size) return out;
  // What every change to the code is held to, whatever part it is in.
  for (const f of tests) if (/\/(conventions|rules|parts-apart|plugin-api)\.test\.js$/.test(f)) out.add(f);
  for (const f of tests) {
    if (out.has(f)) continue;
    const text = read(f);
    for (const k of keys) {
      const hit = k.dir
        ? nameOf(f).includes(k.dir) || text.includes(`/${k.dir}/`) || text.includes(`'${k.dir}'`)
        : nameOf(f).includes(k.file) || text.includes(`/${k.file}.js`);
      if (hit) {
        out.add(f);
        break;
      }
    }
  }
  return out;
}

// ---- running

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
function run(cmd, argv) {
  return new Promise((resolve) => {
    const began = Date.now();
    const { FORCE_COLOR: _f, ...env } = process.env;
    const child = spawn(cmd, argv, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out: strip(out), ms: Date.now() - began }));
  });
}

// What failed in a test file's output: each failing test with what it said.
function failures(out) {
  const lines = out.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*not ok /.test(lines[i])) continue;
    const block = [lines[i].trim()];
    for (let j = i + 1; j < lines.length && !/^\s*(not )?ok /.test(lines[j]) && block.length < 25; j++) {
      if (/^\s*(duration_ms|type|location|failureType|code|name|\.\.\.|---|stack: \|-|\s+at |.*node:internal)/.test(lines[j])) continue;
      if (lines[j].trim()) block.push(`    ${lines[j].trim()}`);
    }
    blocks.push(block.join('\n'));
  }
  return blocks;
}

const secs = (ms) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;

async function main() {
  const changedOnly = flag('--changed');
  let files;
  let why = '';
  if (words.length) {
    files = every.filter((f) => words.some((w) => nameOf(f).includes(w.replace(/^test\/|\.test\.js$/g, ''))));
    if (!files.length) {
      console.error(`No test file has ${words.join(' or ')} in its name.`);
      process.exit(2);
    }
  } else if (changedOnly) {
    const changed = changedFiles();
    files = [...touchedBy(changed)];
    why = ` for ${changed.length} changed file${changed.length === 1 ? '' : 's'}`;
    if (!changed.length) {
      console.log('Nothing has changed since main.');
      return;
    }
  } else files = every;
  const lint = !flag('--no-lint') && !words.length;

  // Slowest first; one never run before counts as slow.
  files.sort((a, b) => (times[b] ?? 1e9) - (times[a] ?? 1e9));
  const tasks = [
    ...(lint
      ? [
          { name: 'lint', cmd: path.join(root, 'node_modules/.bin/eslint'), argv: ['.'] },
          { name: 'format', cmd: path.join(root, 'node_modules/.bin/prettier'), argv: ['--check', '.'] },
        ].filter((t) => fs.existsSync(t.cmd) || (console.log(`- ${t.name}: not installed here (npm install)`), false))
      : []),
    ...files.map((f) => ({ name: nameOf(f), file: f, cmd: process.execPath, argv: ['--test', '--test-reporter=tap', f] })),
  ];
  if (flag('--list')) {
    for (const t of tasks) console.log(t.file ?? t.name);
    return;
  }
  console.log(
    `${files.length} of ${every.length} test files${why}${lint ? ', lint and format' : ''}, ${Math.min(jobs, tasks.length)} at a time`,
  );

  const began = Date.now();
  const failed = [];
  let pass = 0;
  let fail = 0;
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const t = tasks[next++];
      const r = await run(t.cmd, t.argv);
      const n = (re) => Number(new RegExp(`^# ${re} (\\d+)`, 'm').exec(r.out)?.[1] ?? 0);
      if (t.file) {
        times[t.file] = r.ms;
        pass += n('pass');
        fail += n('fail');
      }
      const ok = r.code === 0;
      console.log(
        `${ok ? '✓' : '✗'} ${t.name.padEnd(24)} ${secs(r.ms).padStart(7)}${t.file ? `  ${n('pass')} passed${n('fail') ? `, ${n('fail')} failed` : ''}` : ''}`,
      );
      if (!ok) failed.push({ ...t, said: t.file ? failures(r.out).join('\n') || r.out.slice(-2000) : r.out.slice(0, 3000) });
      // The whole of what a failing file printed is kept, for a failure that will not happen again when asked to.
      if (!ok)
        try {
          fs.mkdirSync(KEPT, { recursive: true });
          fs.writeFileSync(path.join(KEPT, `${t.name}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`), r.out);
        } catch {}
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, worker));

  try {
    fs.mkdirSync(path.dirname(TIMES), { recursive: true });
    fs.writeFileSync(TIMES, JSON.stringify(times));
  } catch {}
  for (const f of failed) console.log(`\n── ${f.file ?? f.name} ──\n${f.said}`);
  console.log(
    `\n${failed.length ? `FAILED: ${failed.map((f) => f.name).join(', ')}` : 'All passed'} · ${pass} tests passed${fail ? `, ${fail} failed` : ''} · ${secs(Date.now() - began)}`,
  );
  if (failed.length) console.log(`What each printed, in full: ${KEPT}`);
  if (failed.length)
    console.log(
      `Again, only those: npm test -- ${failed
        .filter((f) => f.file)
        .map((f) => f.name)
        .join(' ')}`,
    );
  process.exit(failed.length ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
