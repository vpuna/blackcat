// The temporary copy a check runs in: this installation's settings (so the agent is given
// the same instructions, about the same plugins and devices) with none of its secrets, none
// of its messages and none of its conversations. Made-up messages are loaded instead.
//
// Commands that need a secret (a server's key, a home's token) therefore fail in the copy.
// That is intended: a request is judged by what the agent asked to run. Nothing outside this
// machine can be changed or read by a check (a command may still try a device whose address
// is in the settings, and be turned away for having no login).
import { ARCHIVE_DB } from '../../archive/files.js';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DATA, HOME, load } from '../../config.js';
import { CODE_DIR, bornAt } from '../../service/units.js';
import { newToken } from './security.js';

// Outside blackcat's own folder, so that nothing an engine keeps per folder (its own copy of
// a conversation, what it remembers) is mixed with the real installation's.
const ROOT = os.tmpdir();
const PREFIX = 'blackcat-check-';

// `choice`: { role: { name, model, options } } to try, in place of what is set.
export function make(choice = {}) {
  clean(); // one left by a run that was interrupted
  const dir = fs.mkdtempSync(path.join(ROOT, PREFIX)); // readable by this account only
  // Whose it is, so that another check started meanwhile does not take it for one left behind.
  fs.writeFileSync(path.join(dir, OWNER), JSON.stringify({ pid: process.pid, born: bornAt(process.pid) }), { mode: 0o600 });
  fs.mkdirSync(path.join(dir, 'data/plugins'), { recursive: true, mode: 0o700 });
  // Its rules, as they are.
  fs.cpSync(path.join(HOME, 'agent'), path.join(dir, 'agent'), { recursive: true });
  const cfg = structuredClone(load());
  cfg.engine = { ...cfg.engine, ...choice };
  cfg.archive = { ...cfg.archive, embedder: { provider: 'hash' } }; // search by words only: nothing large to load
  cfg.activity = { ...cfg.activity, on: false };
  cfg.conversations = { ...cfg.conversations, on: false };
  fs.writeFileSync(path.join(dir, 'data/config.json'), JSON.stringify(cfg, null, 2), { mode: 0o600 });
  // The one secret that is needed: the engine's own (the key to where its model is), for
  // each engine being tried. Nothing else of data/plugins is copied.
  const engines = new Set(['chat', 'readers'].map((r) => cfg.engine?.[r]?.name ?? 'claude-code'));
  for (const name of engines) {
    const from = path.join(DATA, 'plugins', name);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(dir, 'data/plugins', name), { recursive: true });
  }
  // Plugins of the owner's own (an engine may be one) are the same code, not a copy.
  const own = path.join(HOME, 'user-plugins');
  if (fs.existsSync(own)) fs.symlinkSync(own, path.join(dir, 'user-plugins'));
  // Made-up messages, when this installation has a message archive at all (without one, the
  // agent is not told about messages, and the copy should be the same).
  const withMessages = fs.existsSync(ARCHIVE_DB);
  fs.writeFileSync(path.join(dir, 'check.json'), JSON.stringify({ token: newToken(), withMessages }), { mode: 0o600 });
  if (withMessages) {
    const r = spawnSync(process.execPath, [path.join(CODE_DIR, 'src/engines/check/prepare.js')], { env: env(dir), encoding: 'utf8' });
    if (r.status !== 0) {
      remove(dir);
      throw new Error(`could not prepare the temporary copy: ${String(r.stderr).trim().split('\n').at(-1)}`);
    }
  }
  // `blackcat`, as the agent types it, is this code acting on the copy.
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(
    path.join(dir, 'bin/blackcat'),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(CODE_DIR, 'bin/bc.js'))} "$@"\n`,
    { mode: 0o755 },
  );
  return dir;
}

// The environment a run in the copy is started with.
export const env = (dir) => ({
  ...process.env,
  BLACKCAT_HOME: dir,
  PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`,
  NO_COLOR: '1',
  BLACKCAT_CALLER: undefined,
  BLACKCAT_SLOW: '1',
});

const mine = (dir) => !!dir && path.dirname(dir) === ROOT && path.basename(dir).startsWith(PREFIX);

export function remove(dir) {
  if (mine(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

// Is this copy in use: made by a process that is still running? (The same process number
// given to another process later does not count: it was started at another moment.)
const OWNER = 'owner.json';
function inUse(dir) {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(dir, OWNER), 'utf8'));
    return o.pid !== process.pid && o.born != null && bornAt(o.pid) === o.born;
  } catch {
    // Not one of these copies (a check of another kind keeps a file under the same name for a moment): left alone while it is fresh.
    try {
      return Date.now() - fs.statSync(dir).mtimeMs < 10 * 60_000 && !fs.existsSync(path.join(dir, 'check.json'));
    } catch {
      return false;
    }
  }
}

// Copies left behind (a check that was killed): they hold a copy of the engine's secret.
// One that another check is using right now is not left behind, and is not touched.
export function clean() {
  let names = [];
  try {
    names = fs.readdirSync(ROOT).filter((n) => n.startsWith(PREFIX));
  } catch {}
  for (const n of names) {
    if (inUse(path.join(ROOT, n))) continue;
    try {
      fs.rmSync(path.join(ROOT, n), { recursive: true, force: true });
    } catch {}
  }
}
