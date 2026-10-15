// What a plugin's own files may reach without a `ctx` in hand, each of them the plugin's
// own and no other's: which plugin is asking is read off where the asking file is, so a
// plugin cannot name another by mistake.
//
//   const mine = settingsFor(import.meta.url);   mine.get(), mine.set({ … })
//   const dir = ownDataDir(import.meta.url);     the same folder as ctx.dataDir
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE, DATA, HOME } from '../config.js';
import { CODE_DIR } from '../service/units.js';
import { PLUGIN_DATA, pluginSettings, setPluginSettings } from './registry.js';

// Which plugin a file belongs to: the folder it is in, under plugins/ or user-plugins/.
export function pluginOf(url) {
  const file = String(url).startsWith('file:') ? fileURLToPath(url) : path.resolve(String(url));
  for (const root of [path.join(CODE_DIR, 'plugins'), path.join(HOME, 'user-plugins')]) {
    const rel = path.relative(root, file);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel) && rel.includes(path.sep)) return rel.split(path.sep)[0];
  }
  throw new Error(`${file} is not a plugin's file: pass import.meta.url from a file inside the plugin's own folder`);
}

// The asking plugin's own settings (what ctx.config is, for code that has no ctx).
export function settingsFor(url) {
  const name = pluginOf(url);
  return { get: () => pluginSettings(name), set: (patch) => setPluginSettings(name, patch) };
}

// The asking plugin's private folder, data/plugins/<name>/ (what ctx.dataDir is).
export function ownDataDir(url) {
  const dir = path.join(PLUGIN_DATA, pluginOf(url));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// A folder or file of a plugin's own at the top of blackcat's data folder: a login it
// keeps (`dataPath('tg-account')`), the one folder it opens to the agent
// (`dataPath('unifi-media')`), the models it downloads. Not blackcat's own files, and not
// the plugins' private folders: those are refused.
const NOT_YOURS =
  /^(config\.json.*|permissions\.json|engine-checks\.json|plugins|readers|backup-tmp|run|compile-cache|inbox|.*\.db(-wal|-shm)?|.*\.lock)$/;
export function dataPath(first, ...rest) {
  const parts = [first, ...rest].map(String);
  const to = path.resolve(DATA, ...parts);
  const rel = path.relative(DATA, to);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel))
    throw new Error(`dataPath: "${parts.join('/')}" is not inside blackcat's data folder`);
  if (NOT_YOURS.test(rel.split(path.sep)[0]))
    throw new Error(
      `dataPath: "${rel.split(path.sep)[0]}" is blackcat's own. For a private folder of your plugin's use ctx.dataDir (or ownDataDir(import.meta.url)).`,
    );
  return to;
}

// When a setting last changed, in milliseconds (0 when none has been made yet): for a
// service that reads its settings again only when there is something new to read.
export const settingsChangedAt = () => fs.statSync(CONFIG_FILE, { throwIfNoEntry: false })?.mtimeMs ?? 0;
