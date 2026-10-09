import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA, HOME, load } from '../config.js';
import { loaded, makeCtx } from '../plugins/registry.js';
import { CODE_DIR } from '../service/units.js';
import { INBOX } from './inbox.js';
import { resolveHome } from '../util/paths.js';

const AGENT_DIR = path.join(HOME, 'agent');
const MARKER = /^\s*\[\[send:\s*(.+?)\s*\]\]\s*$/gm;

const expand = resolveHome;

// Folders that plugins open to the agent (`agent.readDirs` in the manifest), e.g. where
// message media is downloaded. Nothing else under data/ is exposed. What is in them was
// written by other people.
export function pluginReadDirs() {
  const dirs = [];
  for (const p of loaded()) {
    if (!p.manifest.agent?.readDirs) continue;
    // (A plugin that cannot say, or says something that is not a folder of its own, opens
    // nothing; the agent's instructions are still built, and everyone else's folders stand.)
    const complain = (why) => {
      if (!complained.has(`${p.name}:${why}`)) console.error(`plugin "${p.name}": ${why}`);
      complained.add(`${p.name}:${why}`);
    };
    let said;
    try {
      said = p.manifest.agent.readDirs(makeCtx(p, { caller: 'agent' })) ?? [];
      if (!Array.isArray(said)) throw new Error('agent.readDirs must return a list of folders');
    } catch (e) {
      complain(`opens no folder to the agent: ${e.message}`);
      continue;
    }
    for (const dir of said) {
      const why = notAFolderToOpen(dir);
      if (why) {
        complain(`agent.readDirs: ${typeof dir === 'string' ? dir : 'an entry'} ${why}, and is not opened`);
        continue;
      }
      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        dirs.push(path.resolve(dir));
      } catch (e) {
        complain(`agent.readDirs: ${dir} could not be made (${e.message})`);
      }
    }
  }
  return dirs;
}
const complained = new Set();
// A folder a plugin may open: a full path, and not one that takes in blackcat's own code
// or private data, or the whole of the home folder.
function notAFolderToOpen(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return 'is not a full path';
  const d = path.resolve(dir);
  const holds = (inner) => inner === d || inner.startsWith(d + path.sep);
  if (holds(os.homedir())) return 'takes in the whole home folder';
  if (holds(DATA) || holds(CODE_DIR)) return "takes in blackcat's own code or private data";
  // (The code and the data may share a folder, so the code is named part by part.)
  const kept = [
    ...['src', 'bin', 'plugins', 'agent', 'test', 'node_modules', '.git'].map((x) => path.join(CODE_DIR, x)),
    path.join(DATA, 'plugins'),
    path.join(DATA, 'wa-auth'),
    path.join(DATA, 'tg-account'),
  ];
  if (kept.some((k) => d === k || d.startsWith(k + path.sep))) return "is inside blackcat's own code or private data";
  return null;
}

// Folders the agent may read, and so the only folders files are ever sent from.
export const readDirs = () => [...(load().agent?.readDirs ?? []).map(expand).filter((d) => fs.existsSync(d)), INBOX, ...pluginReadDirs()];

// Pull [[send: path]] lines out of the agent's reply.
export function extractFiles(text) {
  const files = [...text.matchAll(MARKER)].map((m) => m[1]);
  return {
    text: text
      .replace(MARKER, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    files,
  };
}

// Is this a file the bot may send? → its real path, or null.
export function sendable(requested) {
  let file;
  try {
    // realpath so a symlink can't point the bot outside the allowed folders.
    file = fs.realpathSync(expand(String(requested)));
  } catch {
    return null;
  }
  return [AGENT_DIR, ...readDirs()].some((dir) => file === dir || file.startsWith(dir + path.sep)) && fs.statSync(file).isFile()
    ? file
    : null;
}
