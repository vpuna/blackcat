import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pause } from './util/wait.js';

// A test must point blackcat at a folder of its own (test/helpers.js, home()) before any of
// this is loaded: without that it would be looking at, and could change, the real installation.
if (process.env.NODE_TEST_CONTEXT && !process.env.BLACKCAT_HOME)
  throw new Error('A test loaded blackcat without BLACKCAT_HOME: call home() from test/helpers.js first.');
// Where this installation lives: the folder the code is in, wherever it was put. Its data,
// the agent's rules and your own plugins are kept beside the code. BLACKCAT_HOME names
// another folder for those (a second installation run from the same code, or a test).
export const HOME = process.env.BLACKCAT_HOME || path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const DATA = path.join(HOME, 'data');
const CONFIG = path.join(DATA, 'config.json');
export const CONFIG_FILE = CONFIG;

export function load() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
}

// Config holds the bot token, so keep it readable by this user only.
export function save(cfg) {
  fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
  // A temporary file of this process's own, then a rename: a reader sees the old file or
  // the new one, never half of one, and two writers can't write into the same temporary file.
  const tmp = `${CONFIG}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, CONFIG);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// Change the config: read it, apply `change(cfg)`, write it back, with other processes kept
// out in between. The bot, the sources, scheduled jobs and commands all write this file;
// with a plain load() … save() two of them at once would lose one of the changes.
const LOCK = `${CONFIG}.lock`;
const LOCK_WAIT_MS = 3000;
const LOCK_STALE_MS = 10_000;
export function update(change) {
  fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
  const until = Date.now() + LOCK_WAIT_MS;
  let held = false;
  while (!held) {
    try {
      fs.mkdirSync(LOCK);
      held = true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // A lock left by a process that died is taken over.
      const age = Date.now() - (fs.statSync(LOCK, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
      if (age > LOCK_STALE_MS) fs.rmSync(LOCK, { recursive: true, force: true });
      else if (Date.now() > until)
        break; // rather write unlocked than not at all
      else pause(15);
    }
  }
  try {
    const cfg = load();
    const before = JSON.stringify(cfg);
    const out = change(cfg) ?? cfg;
    // Nothing changed: nothing is written. (The file's date is how a process that is kept
    // waiting learns that settings have changed: it should not move for nothing.)
    if (JSON.stringify(out) !== before) save(out);
    return out;
  } finally {
    if (held) fs.rmSync(LOCK, { recursive: true, force: true });
  }
}
