// Places files can be kept, away from blackcat's own data: where a backup goes. One is
// built in: a folder on this machine (a USB disk, a mounted share). A plugin offers others
// by declaring `storage` in its manifest; the SSH plugin offers every machine it reaches.
// The core asks whoever offers, and names no plugin.
//
//   storage: {
//     label: 'machines reached over SSH',
//     places: (ctx) => [{ id: 'nas', label: 'nas (me@10.0.0.5)' }],
//     list:   async (ctx, place, dir) => [{ name, bytes, folder }],
//     mkdir:  async (ctx, place, dir) => {},                // and what is above it
//     put:    async (ctx, place, file, to) => {},           // whole or not at all; private to its account
//     get:    async (ctx, place, from, file) => {},
//     remove: async (ctx, place, paths) => {},
//     free:   async (ctx, place, dir) => '1.2T',            // optional: free space, in words
//   }
//
// A place's id here is `<plugin>:<its id>` (`ssh:nas`), or `here`.
import fs from 'node:fs';
import path from 'node:path';
import { loaded, makeCtx } from './plugins/registry.js';

export const HERE = 'here';

const here = {
  label: 'this machine (a folder, a USB disk, a mounted share)',
  list: async (dir) =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isFile())
      .map((e) => ({ name: e.name, folder: e.isDirectory(), bytes: e.isFile() ? fs.statSync(path.join(dir, e.name)).size : 0 })),
  mkdir: async (dir) => void fs.mkdirSync(dir, { recursive: true, mode: 0o700 }),
  put: async (file, to) => {
    fs.copyFileSync(file, `${to}.part`);
    fs.chmodSync(`${to}.part`, 0o600);
    fs.renameSync(`${to}.part`, to);
  },
  get: async (from, file) => {
    fs.copyFileSync(from, `${file}.part`);
    fs.chmodSync(`${file}.part`, 0o600);
    fs.renameSync(`${file}.part`, file);
  },
  remove: async (paths) => paths.forEach((p) => fs.rmSync(p, { force: true })),
  free: async (dir) => {
    const s = fs.statfsSync(dir);
    const gb = (s.bavail * s.bsize) / 1024 ** 3;
    return gb >= 1 ? `${gb.toFixed(gb >= 10 ? 0 : 1)}G` : `${Math.round(gb * 1024)}M`;
  },
};

const offering = () => loaded().filter((p) => p.manifest.storage);

// Every place there is. → [{ id, label }]
export function places() {
  const out = [{ id: HERE, label: here.label }];
  for (const p of offering()) {
    try {
      for (const pl of p.manifest.storage.places(makeCtx(p)) ?? [])
        if (pl?.id != null) out.push({ id: `${p.name}:${pl.id}`, label: pl.label ?? String(pl.id) });
    } catch {
      // (a plugin that cannot say offers none just now)
    }
  }
  return out;
}

export class StorageError extends Error {}
const full = (p) => {
  if (typeof p !== 'string' || !p.startsWith('/') || /[\0\n]/.test(p))
    throw new StorageError(`"${p}" is not a full path (it must start with /).`);
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
};

// One place, by its id: its operations, each given full paths. Whatever goes wrong comes
// back as a StorageError saying so in words.
export function placeOf(id) {
  const tell = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof StorageError) throw e;
      throw new StorageError(e.message);
    }
  };
  if (id === HERE) {
    return {
      id,
      label: here.label,
      list: (dir) => tell(() => here.list(full(dir))),
      mkdir: (dir) => tell(() => here.mkdir(full(dir))),
      put: (file, to) => tell(() => here.put(file, full(to))),
      get: (from, file) => tell(() => here.get(full(from), file)),
      remove: (paths) => tell(() => here.remove(paths.map(full))),
      free: (dir) => tell(() => here.free(full(dir))).catch(() => null),
    };
  }
  const [name, ...rest] = String(id ?? '').split(':');
  const place = rest.join(':');
  const p = offering().find((x) => x.name === name);
  if (!p || !place)
    throw new StorageError(
      id
        ? `"${id}" is not a place files can be kept just now (is the ${name} plugin switched on?). See what there is: bc backup setup`
        : 'No place has been chosen.',
    );
  const s = p.manifest.storage;
  // Asked as the owner: a file goes only where the owner said, whoever set it going.
  const ctx = () => makeCtx(p, { caller: 'owner', surface: 'job' });
  return {
    id,
    label: `${place}`,
    list: (dir) =>
      tell(async () =>
        ((await s.list(ctx(), place, full(dir))) ?? []).map((e) => ({
          name: String(e.name),
          folder: !!e.folder,
          bytes: Number(e.bytes) || 0,
        })),
      ),
    mkdir: (dir) => tell(() => s.mkdir(ctx(), place, full(dir))),
    put: (file, to) => tell(() => s.put(ctx(), place, file, full(to))),
    get: (from, file) => tell(() => s.get(ctx(), place, full(from), file)),
    remove: (paths) => tell(async () => (paths.length ? s.remove(ctx(), place, paths.map(full)) : undefined)),
    free: (dir) => (s.free ? tell(() => s.free(ctx(), place, full(dir))).catch(() => null) : Promise.resolve(null)),
  };
}
