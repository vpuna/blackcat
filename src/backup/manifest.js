// Backups: a nightly copy of everything blackcat knows, kept somewhere else. One archive
// per backup, optionally encrypted, with old ones pruned.
//
// Part of blackcat itself, not a plugin: it copies every database, the settings and every
// plugin's private folder, and on a restore it puts all of that back, which is more than a
// plugin is given. It makes the file; where the file is kept is a "place" (src/storage.js):
// a folder on this machine, or whatever a plugin offers (a machine reached over SSH).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agoShort, clock, DATA, fromTimes, hasColumn, hasTable, HOME, openSqlite, serviceCommands, size, withDb } from '../internal.js';
import { HERE, placeOf, places } from '../storage.js';

const STAGE = path.join(DATA, 'backup-tmp'); // private, on the same disk as the data
const PREFIX = `blackcat-${os.hostname()}-`; // this machine's backups
// Any machine's backup: blackcat-<hostname>-<YYYYMMDD>-<HHMMSS>.tar.zst[.gpg]
const NAME = /^blackcat-(.+)-(\d{8})-(\d{6})\.tar\.zst(\.gpg)?$/;
const whenOf = (name) => {
  const m = NAME.exec(name);
  return m ? `${m[2].slice(0, 4)}-${m[2].slice(4, 6)}-${m[2].slice(6)} ${m[3].slice(0, 2)}:${m[3].slice(2, 4)}` : '';
};
const machineOf = (name) => NAME.exec(name)?.[1] ?? '';
// Databases are copied with SQLite's own backup, which is safe while they are in use.
const DATABASES = ['archive.db', 'agent.db'];
// Everything else that can't be recreated. Left out: the search index and the embedding
// model (both rebuilt or downloaded again), and camera snapshots.
// The form of a backup, noted in its manifest. Raised when a backup changes in a way an
// earlier blackcat could not restore.
const FORMAT = 1;
const FILES = ['config.json', 'wa-auth', 'tg-account', 'plugins', 'readers', 'inbox', 'archive-media'];

// Where backups go: a place and a folder there. (An installation from when they could only
// go to an SSH host has `host`; that is the place `ssh:<host>`.)
function settings(ctx) {
  const c = ctx.config.get();
  return { keep: 14, time: '03:30', ...c, place: c.place ?? (c.host ? `ssh:${c.host}` : undefined) };
}
// What came of the last one: kept with what changes with use, not among the settings.
// (It was among them; what is there is carried over the first time this is asked.)
function last(ctx) {
  const c = ctx.config.get();
  if (c.last !== undefined || c.lastError !== undefined) {
    if (ctx.store.get('last') === undefined && c.last) ctx.store.set('last', c.last);
    if (ctx.store.get('lastError') === undefined && c.lastError) ctx.store.set('lastError', c.lastError);
    ctx.config.set({ last: undefined, lastError: undefined });
  }
  return { last: ctx.store.get('last') ?? null, lastError: ctx.store.get('lastError') ?? null };
}
const whereText = (s) => (s.place === HERE ? s.dir : `${String(s.place).replace(/^[a-z0-9-]+:/, '')}:${s.dir}`);
// This machine's time zone, e.g. "Europe/Lisbon". Every schedule and reminder is in local time.
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
// A backup is packed with tar and zstd, and encrypted with gpg. Say so plainly when one is not installed.
async function needTools(ctx, names) {
  const missing = [];
  for (const n of names) if ((await run('sh', ['-c', `command -v ${n}`])).code !== 0) missing.push(n);
  if (missing.length)
    ctx.fail(
      `This needs ${missing.join(' and ')}, which ${missing.length === 1 ? 'is' : 'are'} not installed on this machine. Install ${missing.length === 1 ? 'it' : 'them'} (on Debian, Ubuntu or Raspberry Pi OS: sudo apt install ${missing.map((n) => (n === 'gpg' ? 'gnupg' : n)).join(' ')}) and try again. Nothing was changed.`,
    );
}
const configured = (ctx) => !!(settings(ctx).place && settings(ctx).dir);
const mb = size;
const ago = agoShort;
const stamp = () =>
  new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

// Run a program. → { code, stdout, stderr }. Never throws.
const run = (cmd, args, { timeoutMs = 30 * 60_000, env } = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 ** 2, env }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout,
        stderr: stderr || (err && !stdout ? err.message : ''),
      });
    });
  });
// The backups in the place they are kept, newest first. Every machine's are listed (so a
// new machine can restore an old one's). → [{ name, bytes, machine, made, mine }]
async function listKept(ctx) {
  const s = settings(ctx);
  const key = (n) => n.replace(/^blackcat-.+-(\d{8}-\d{6})\./, '$1');
  return (await placeOf(s.place).list(s.dir))
    .filter((e) => !e.folder && NAME.test(e.name))
    .map((e) => ({ name: e.name, bytes: e.bytes, machine: machineOf(e.name), made: whenOf(e.name), mine: e.name.startsWith(PREFIX) }))
    .sort((a, b) => key(b.name).localeCompare(key(a.name)));
}
// A place says what went wrong in its own words; the person is told, not shown a stack.
const kept = (ctx, fn) => fn().catch((e) => ctx.fail(e.message));

export async function makeArchive(ctx) {
  const s = settings(ctx);
  await needTools(ctx, ['tar', 'zstd', ...(s.encrypt ? ['gpg'] : [])]);
  fs.rmSync(STAGE, { recursive: true, force: true });
  const tree = path.join(STAGE, 'blackcat');
  fs.mkdirSync(path.join(tree, 'data'), { recursive: true, mode: 0o700 });

  for (const name of DATABASES) {
    const src = path.join(DATA, name);
    if (!fs.existsSync(src)) continue;
    await withDb(
      () => openSqlite(src, { readonly: true }),
      (db) => db.backup(path.join(tree, 'data', name)),
    );
    fs.chmodSync(path.join(tree, 'data', name), 0o600); // SQLite's backup makes the copy readable by everyone
  }
  for (const name of FILES) {
    const src = path.join(DATA, name);
    // (Sockets, such as an open SSH connection's, can't be copied and aren't data.)
    if (!fs.existsSync(src)) continue;
    // A plugin's own SQLite database is copied with SQLite's backup, like the main ones: a
    // plain copy of a database that is in use can come out broken.
    const dbs = [];
    fs.cpSync(src, path.join(tree, 'data', name), {
      recursive: true,
      filter: (f) => {
        if (fs.lstatSync(f).isSocket()) return false;
        if (/\.db(-wal|-shm)?$/.test(f)) return (f.endsWith('.db') && dbs.push(f), false);
        return true;
      },
    });
    for (const f of dbs) {
      await withDb(
        () => openSqlite(f, { readonly: true }),
        (db) => db.backup(path.join(tree, 'data', path.relative(DATA, f))),
      );
      fs.chmodSync(path.join(tree, 'data', path.relative(DATA, f)), 0o600);
    }
  }
  // (What the agent remembers is in agent.db, among the databases above.)
  // Plugins you wrote yourself are code, but they live outside the repository.
  const own = path.join(HOME, 'user-plugins');
  if (fs.existsSync(own)) fs.cpSync(own, path.join(tree, 'user-plugins'), { recursive: true });
  // Where this installation lived, so a restore somewhere else can correct stored paths.
  fs.writeFileSync(
    path.join(tree, 'manifest.json'),
    JSON.stringify(
      {
        format: FORMAT,
        made: new Date().toISOString(),
        hostname: os.hostname(),
        home: HOME,
        data: DATA,
        userHome: os.homedir(),
        timezone: zone(),
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(tree, 'README.txt'),
    `blackcat backup, made ${new Date().toISOString()} on ${os.hostname()}.\nTo restore: bc backup restore (README.md, "Backups").\n`,
  );

  let file = path.join(STAGE, `${PREFIX}${stamp()}.tar.zst`);
  const tar = await run('tar', ['--zstd', '-cf', file, '-C', STAGE, 'blackcat']);
  fs.rmSync(tree, { recursive: true, force: true });
  if (tar.code !== 0) ctx.fail(`Could not pack the backup: ${tar.stderr.trim()}`);
  fs.chmodSync(file, 0o600);

  const pass = ctx.secrets.get('passphrase');
  if (s.encrypt && pass) {
    const passFile = path.join(STAGE, 'pass');
    fs.writeFileSync(passFile, pass, { mode: 0o600 });
    const gpg = await run('gpg', [
      '--batch',
      '--yes',
      '--pinentry-mode',
      'loopback',
      '--passphrase-file',
      passFile,
      '--cipher-algo',
      'AES256',
      '--symmetric',
      '-o',
      `${file}.gpg`,
      file,
    ]);
    fs.rmSync(passFile, { force: true });
    fs.rmSync(file, { force: true });
    if (gpg.code !== 0) ctx.fail(`Could not encrypt the backup: ${gpg.stderr.trim()}`);
    file = `${file}.gpg`;
  }
  return file;
}

// A backup can be restored on another machine, or under another user or folder. A few
// things are stored by full path (the picture attached to a reminder or a list item, the
// folders the agent may read), and those are rewritten to where blackcat lives now.
// `origin` is the backup's manifest; `dataDir` is the restored data folder.
export function relocate(dataDir, origin) {
  const { changed, from } = withDb(
    () => openSqlite(path.join(dataDir, 'agent.db')),
    (db) => {
      const has = (table, col) => hasColumn(db, table, col);
      const tables = [
        ['reminders', 'file'],
        ['watch_items', 'file'],
      ].filter(([t, c]) => has(t, c));
      const from = origin?.data;
      let changed = 0;
      if (from && path.resolve(from) !== path.resolve(DATA)) {
        for (const [t, c] of tables) {
          changed += db
            .prepare(`UPDATE ${t} SET ${c} = ? || substr(${c}, ?) WHERE ${c} LIKE ? ESCAPE '\\'`)
            .run(DATA, from.length + 1, `${from.replace(/[\\%_]/g, '\\$&')}/%`).changes;
        }
      }
      return { changed, from };
    },
  );

  // Folders named in the config under the old user's home.
  const cfgFile = path.join(dataDir, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  const oldHome = origin?.userHome;
  if (oldHome && oldHome !== os.homedir() && Array.isArray(cfg.agent?.readDirs)) {
    cfg.agent.readDirs = cfg.agent.readDirs.map((d) =>
      d === oldHome || d.startsWith(`${oldHome}/`) ? os.homedir() + d.slice(oldHome.length) : d,
    );
  }
  // The engine's side of each conversation stays on the old machine; start fresh ones here.
  const moved = origin.hostname !== os.hostname() || origin.home !== HOME;
  if (moved) {
    withDb(
      () => openSqlite(path.join(dataDir, 'agent.db')),
      (kept) => hasTable(kept, 'chat_sessions') && kept.exec('DELETE FROM chat_sessions'),
    );
  }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return { changed, from: from ?? null };
}

// Make a backup, send it, check it arrived whole, and prune old ones.
async function backup(ctx) {
  if (!configured(ctx)) ctx.fail('Backups are not set up yet. Run `bc backup setup` (or /setup in the bot).');
  const s = settings(ctx);
  let file;
  try {
    const place = await kept(ctx, async () => placeOf(s.place));
    file = await makeArchive(ctx);
    const name = path.basename(file);
    const bytes = fs.statSync(file).size;
    const dir = s.dir.replace(/\/+$/, '') || '/';
    await place.put(file, `${dir}/${name}`).catch((e) => ctx.fail(`Could not send the backup to ${whereText(s)}: ${e.message}`));
    const there = (await kept(ctx, () => listKept(ctx))).find((b) => b.name === name);
    if (there?.bytes !== bytes) ctx.fail(`The backup did not arrive whole at ${whereText(s)} (${there?.bytes ?? 0} of ${bytes} bytes).`);

    // Keep the newest `keep` of this machine's own; the rest go.
    const old = (await kept(ctx, () => listKept(ctx))).filter((b) => b.mine).slice(Math.max(1, Number(s.keep) || 14));
    if (old.length) await kept(ctx, () => place.remove(old.map((b) => `${dir}/${b.name}`)));
    last(ctx);
    ctx.store.set('last', { at: Math.floor(Date.now() / 1000), name, bytes });
    ctx.store.delete('lastError');
    return { name, bytes, removed: old.length };
  } catch (e) {
    last(ctx);
    ctx.store.set('lastError', { at: Math.floor(Date.now() / 1000), message: e.message.slice(0, 300) });
    throw e;
  } finally {
    fs.rmSync(STAGE, { recursive: true, force: true });
  }
}

export default {
  api: 1,
  name: 'backup',
  title: 'Backups',
  description: 'a nightly copy of your messages, lists, settings and logins, kept somewhere else',
  help: `Where backups are kept is a place and a folder there: one
a plugin offers (the SSH plugin: every machine added with bc ssh add), or a folder on
this one (a USB disk, a mounted share).
  bc backup setup      where, which folder, when, how many to keep, and whether to encrypt

  bc backup now        make one now
  bc backup list       the backups that are kept, from this and any other machine
  bc backup restore    choose one and unpack it; add --apply to put it in place

Moving to another machine: install blackcat there, add the same place, run bc backup setup with the same folder and passphrase, then bc backup restore --apply.`,

  commands: {
    setup: {
      summary: 'where backups go, when, how many to keep, and whether to encrypt them',
      access: 'owner',
      form: [
        {
          id: 'place',
          type: 'select',
          message: 'Keep backups where?',
          default: (_a, ctx) => settings(ctx).place,
          options: () => places().map((p) => ({ value: p.id, label: p.label })),
        },
        {
          id: 'dir',
          type: 'browse',
          message: 'Which folder there should backups go in?',
          // Start where backups go now, or at the top.
          start: (a, ctx) => (a.place === settings(ctx).place ? settings(ctx).dir : null) ?? '/',
          list: async (dir, a) =>
            (await placeOf(a.place).list(dir))
              .filter((e) => e.folder && !e.name.startsWith('.'))
              .map((e) => e.name)
              .sort((x, y) => x.localeCompare(y)),
          create: (dir, a) => placeOf(a.place).mkdir(dir),
          validate: (v) =>
            /^\/[^\0]*$/.test(String(v)) && !/['\n]/.test(String(v))
              ? undefined
              : 'A full path starting with /, e.g. /mnt/user/Personal/blackcat-backups',
        },
        {
          id: 'time',
          type: 'text',
          message: 'At what time each day? (24-hour HH:MM)',
          default: (_a, ctx) => settings(ctx).time,
          validate: (v) => (clock(v) ? undefined : 'Use 24-hour HH:MM, e.g. 03:30'),
        },
        {
          id: 'keep',
          type: 'text',
          message: 'How many backups to keep?',
          default: (_a, ctx) => String(settings(ctx).keep),
          validate: (v) => (/^\d+$/.test(String(v)) && Number(v) >= 1 && Number(v) <= 365 ? undefined : 'A number from 1 to 365'),
        },
        {
          id: 'encrypt',
          type: 'confirm',
          message: 'Encrypt the backups? They contain your messages and the logins for your accounts.',
          default: (_a, ctx) => ctx.config.get().encrypt ?? true,
        },
        {
          id: 'passphrase',
          type: 'secret',
          message: "A passphrase to encrypt with. Keep it somewhere safe: without it a backup can't be restored.",
          when: (a) => a.encrypt,
          keep: true,
          validate: (v) => (String(v).length >= 8 ? undefined : 'At least 8 characters'),
        },
      ],
      run: async (ctx, a) => {
        if (!places().some((p) => p.id === a.place))
          ctx.fail(
            `"${a.place}" is not a place backups can be kept. There is: ${places()
              .map((p) => p.id)
              .join(', ')}.`,
          );
        const dir = String(a.dir).replace(/\/+$/, '') || '/';
        // (`host` is how the place was written before there were places.)
        ctx.config.set({
          place: a.place,
          host: undefined,
          dir,
          time: String(a.time).trim().padStart(5, '0'),
          keep: Number(a.keep),
          encrypt: !!a.encrypt,
        });
        // Left empty: the passphrase that is saved stays. (It also stays when encryption is
        // switched off: the backups made with it still need it to be restored.)
        if (a.encrypt && a.passphrase) ctx.secrets.set('passphrase', String(a.passphrase));
        // Make sure it will work before the first night: the folder is there, and a file can be put in it and taken out.
        const s = settings(ctx);
        const place = placeOf(a.place);
        const probe = path.join(STAGE, '.blackcat-write-test');
        try {
          fs.mkdirSync(STAGE, { recursive: true, mode: 0o700 });
          fs.writeFileSync(probe, 'blackcat', { mode: 0o600 });
          await place.mkdir(dir);
          await place.put(probe, `${dir}/.blackcat-write-test`);
          await place.remove([`${dir}/.blackcat-write-test`]);
        } catch (e) {
          ctx.fail(`Saved, but nothing can be written to ${whereText(s)}: ${e.message}. Check the folder and run setup again.`);
        } finally {
          fs.rmSync(STAGE, { recursive: true, force: true });
        }
        const free = await place.free(dir);
        return [
          `Backups will go to ${whereText(s)} every day at ${s.time}, keeping the last ${a.keep}${a.encrypt ? ', encrypted' : ', NOT encrypted'}.`,
          free ? `Free space there: ${free}.` : null,
          'Make the first one now with: bc backup now',
          'Restart the agent so it picks up the schedule: bc restart agent',
        ]
          .filter(Boolean)
          .join('\n');
      },
    },

    now: {
      summary: 'make a backup now and send it',
      // It only ever goes where the owner configured, so the agent may start one.
      access: 'allow',
      untrusted: false,
      run: async (ctx) => {
        const r = await backup(ctx);
        const s = settings(ctx);
        return {
          text: `Backup sent to ${whereText(s)}/${r.name} (${mb(r.bytes)})${r.removed ? `. Removed ${r.removed} old one${r.removed === 1 ? '' : 's'}.` : '.'}`,
          data: r,
        };
      },
    },

    list: {
      summary: 'the backups that are kept',
      access: 'allow',
      untrusted: false,
      run: async (ctx) => {
        if (!configured(ctx)) ctx.fail('Backups are not set up yet. Run `bc backup setup`.');
        const all = await kept(ctx, () => listKept(ctx));
        const s = settings(ctx);
        return {
          text: all.length
            ? [
                `${all.length} backup${all.length === 1 ? '' : 's'} on ${whereText(s)}`,
                ...all.map(
                  (b) => `  ${b.made}  ${mb(b.bytes).padStart(9)}  from ${b.machine}${b.mine ? '' : ' (another machine)'}  ${b.name}`,
                ),
              ].join('\n')
            : `No backups on ${whereText(s)} yet.`,
          data: { place: s.place, dir: s.dir, backups: all },
        };
      },
    },

    restore: {
      summary: 'fetch a backup and unpack it; with --apply, put it in place of the current data',
      access: 'owner',
      usage: '[name]',
      options: [
        [
          '--file <path>',
          'restore from a backup file that is already on this machine (copied by hand, a USB stick, a mounted folder) instead of fetching one; needs no backup setup',
        ],
        ['--apply', "replace this installation's data with the backup (the current data is kept aside)"],
        ['--to <dir>', 'without --apply: where to unpack it (default: ~/blackcat-restore-<date>)'],
        ['--yes', "with --apply: don't ask for confirmation"],
        [
          '--paused',
          'with --apply: leave every service switched off afterwards (the agent, and each message source), so that nothing logs in, sends or runs on a schedule until you say: for trying a backup while the installation it came from is still running',
        ],
      ],
      run: async (ctx, i) => {
        const ask = process.stdin.isTTY && process.stdout.isTTY ? await import('@clack/prompts') : null;
        // A file already here: nothing to fetch, and backups need not be set up on this machine yet.
        const local = i.file ? path.resolve(i.file) : null;
        if (local && i.name) ctx.fail('Give a backup name or --file, not both.');
        if (local && (!fs.existsSync(local) || !NAME.test(path.basename(local))))
          ctx.fail(`${local} is not a blackcat backup (a file named blackcat-<machine>-<date>-<time>.tar.zst, or .tar.zst.gpg).`);
        if (!local && !configured(ctx))
          ctx.fail('Backups are not set up yet. Run `bc backup setup`, or restore from a file you have here with --file <path>.');
        const s = settings(ctx);
        const all = local
          ? [
              {
                name: path.basename(local),
                bytes: fs.statSync(local).size,
                machine: machineOf(path.basename(local)),
                made: whenOf(path.basename(local)),
              },
            ]
          : await kept(ctx, () => listKept(ctx));
        if (!all.length) ctx.fail(`There are no backups on ${whereText(s)}.`);

        await needTools(ctx, ['tar', 'zstd']);
        // Which one: named, chosen from a list, or the newest.
        let pick = local ? all[0] : i.name ? all.find((b) => b.name === i.name || b.name.includes(i.name)) : null;
        if (i.name && !pick) ctx.fail(`No backup matches "${i.name}". See: bc backup list`);
        if (!pick && ask) {
          const chosen = await ask.select({
            message: `Restore which backup? (${all.length} on ${whereText(s)})`,
            maxItems: 12,
            options: all.map((b, n) => ({
              value: b.name,
              label: `${b.made}  ${mb(b.bytes)}  from ${b.machine}`,
              hint: n === 0 ? 'newest' : undefined,
            })),
          });
          if (ask.isCancel(chosen)) return 'Cancelled. Nothing was changed.';
          pick = all.find((b) => b.name === chosen);
        }
        pick ??= all[0];

        if (i.apply) {
          // Nothing may be writing to the data while it is swapped.
          const { services, isInstalled, show } = await import('../internal.js');
          const { otherHome } = await serviceCommands();
          const running = [];
          for (const [id, svc] of Object.entries(await services()))
            if (isInstalled(svc) && !otherHome(svc) && (await show(svc)).ActiveState === 'active') running.push(id);
          if (running.length) ctx.fail(`blackcat is running here (${running.join(', ')}). Stop it first: bc stop`);
          if (!i.yes) {
            if (!ask) ctx.fail('This replaces the data of this installation. Run it in a terminal, or add --yes.');
            const ok = await ask.confirm({
              message: `Replace this installation's data with the backup from ${pick.made} (made on ${pick.machine})? The current data is kept aside.`,
              initialValue: false,
            });
            if (ask.isCancel(ok) || !ok) return 'Cancelled. Nothing was changed.';
          }
        }

        const stampNow = stamp();
        // Where the backup is unpacked, and where the data it replaces is kept: beside the
        // data folder, when that is possible. When the data folder is a place of its own (a
        // volume mounted into a container), or nothing may be written beside it, both are inside it.
        const beside = (() => {
          try {
            fs.accessSync(HOME, fs.constants.W_OK);
            return fs.statSync(HOME).dev === fs.statSync(DATA).dev;
          } catch {
            return false;
          }
        })();
        const to = i.apply
          ? path.join(beside ? HOME : DATA, `restore-tmp-${stampNow}`)
          : path.resolve(i.to ?? path.join(os.homedir(), `blackcat-restore-${pick.name.replace(/^blackcat-.+-(\d{8}-\d{6})\..*$/, '$1')}`));
        if (fs.existsSync(to) && fs.readdirSync(to).length) ctx.fail(`${to} already exists and is not empty. Choose another with --to.`);
        fs.mkdirSync(to, { recursive: true, mode: 0o700 });
        let file = path.join(to, pick.name);
        if (local) {
          // (The original is left where it is. One that cannot be read is said so, with nothing left behind.)
          try {
            fs.copyFileSync(local, file);
          } catch (e) {
            fs.rmSync(to, { recursive: true, force: true });
            ctx.fail(
              e.code === 'EACCES'
                ? `${local} cannot be read by this account (a backup is kept private to the account that made it). Make it readable, or copy it, then try again. Nothing was changed.`
                : `${local} could not be read: ${e.message}. Nothing was changed.`,
            );
          }
        } else {
          await placeOf(s.place)
            .get(`${s.dir.replace(/\/+$/, '')}/${pick.name}`, file)
            .catch((e) => ctx.fail(`Could not fetch ${pick.name}: ${e.message}`));
        }
        if (file.endsWith('.gpg')) {
          await needTools(ctx, ['gpg']).catch((e) => {
            fs.rmSync(to, { recursive: true, force: true });
            throw e;
          });
          let pass = ctx.secrets.get('passphrase');
          // On a machine where backups are not set up yet, ask for it (typed here, never stored by this).
          if (!pass && ask) {
            const typed = await ask.password({ message: `${pick.name} is encrypted. The passphrase it was made with:` });
            if (!ask.isCancel(typed)) pass = typed;
          }
          if (!pass)
            ctx.fail(
              `${pick.name} is encrypted and no passphrase is stored. Run \`bc backup setup\` and enter the passphrase it was made with, then try again. (The file is in ${to}.)`,
            );
          const passFile = path.join(to, '.pass');
          fs.writeFileSync(passFile, pass, { mode: 0o600 });
          const out = file.replace(/\.gpg$/, '');
          const gpg = await run('gpg', [
            '--batch',
            '--yes',
            '--pinentry-mode',
            'loopback',
            '--passphrase-file',
            passFile,
            '-o',
            out,
            '--decrypt',
            file,
          ]);
          fs.rmSync(passFile, { force: true });
          if (gpg.code !== 0)
            ctx.fail(
              `Could not decrypt ${pick.name}: the passphrase stored here is not the one it was made with. Run \`bc backup setup\` again with the right one. (The file is in ${to}.)`,
            );
          fs.rmSync(file, { force: true });
          file = out;
        }
        const tar = await run('tar', ['--zstd', '-xf', file, '-C', to]);
        if (tar.code !== 0) {
          fs.rmSync(to, { recursive: true, force: true });
          ctx.fail(`Could not unpack ${pick.name}: ${tar.stderr.trim()}. Nothing was changed.`);
        }
        fs.rmSync(file, { force: true });
        const from = path.join(to, 'blackcat');

        if (!i.apply) {
          return [
            `Unpacked the backup from ${pick.made} into ${from}`,
            '',
            'Nothing live has been changed. To put it in place, run the same command with --apply:',
            `  bc stop && bc backup restore ${local ? `--file ${local}` : pick.name} --apply`,
            '',
            `Then delete ${to}.`,
          ].join('\n');
        }

        // Put it in place. The current data is moved aside, never deleted.
        const aside = beside ? `${DATA}.before-restore-${stampNow}` : path.join(DATA, `before-restore-${stampNow}`);
        const restored = path.join(from, 'data');
        if (!fs.existsSync(path.join(restored, 'config.json')))
          ctx.fail(`That backup has no data in it. Nothing was changed. (It is unpacked in ${to}.)`);
        // A backup says what made it and where (its manifest). One that does not, or that is
        // of a form this version does not know, is not put in place.
        let origin = null;
        try {
          origin = JSON.parse(fs.readFileSync(path.join(from, 'manifest.json'), 'utf8'));
        } catch {}
        if (!origin?.data)
          ctx.fail(
            `That backup was made by an earlier blackcat than this one can restore. Nothing was changed. (It is unpacked in ${to}.)`,
          );
        if ((origin.format ?? 1) > FORMAT)
          ctx.fail(
            `That backup was made by a newer blackcat than this one. Update blackcat, then restore it. Nothing was changed. (It is unpacked in ${to}.)`,
          );
        if (beside) {
          fs.renameSync(DATA, aside);
          fs.renameSync(restored, DATA);
        } else {
          // (The folder itself stays where it is: what is in it moves aside, and what was restored moves in.)
          fs.mkdirSync(aside, { mode: 0o700 });
          for (const e of fs.readdirSync(DATA))
            if (![path.basename(aside), path.basename(to)].includes(e)) fs.renameSync(path.join(DATA, e), path.join(aside, e));
          for (const e of fs.readdirSync(restored)) fs.renameSync(path.join(restored, e), path.join(DATA, e));
        }
        // Left switched off, when asked: the agent and every source, until `bc service install`.
        let paused = [];
        if (i.paused) {
          const { services, setSwitchedOff } = await import('../service/units.js');
          const known = ['agent', ...Object.keys(await services().catch(() => ({})))];
          // (A source the restored settings switch on is not known yet to this process: the bundled ones are named.)
          paused = [...new Set([...known, 'wa', 'tg'])];
          setSwitchedOff(paused);
        }
        // Kept from this machine, because the backup doesn't carry it: the embedding model.
        if (fs.existsSync(path.join(aside, 'models')) && !fs.existsSync(path.join(DATA, 'models')))
          fs.renameSync(path.join(aside, 'models'), path.join(DATA, 'models'));
        const rel = relocate(DATA, origin);
        const did = [`the data (the previous data is in ${aside})`];
        if (rel.changed) did.push(`${rel.changed} attached file path${rel.changed === 1 ? '' : 's'} moved from ${rel.from} to ${DATA}`);
        if (fs.existsSync(path.join(from, 'user-plugins'))) {
          fs.cpSync(path.join(from, 'user-plugins'), path.join(HOME, 'user-plugins'), { recursive: true });
          did.push('your own plugins');
        }
        fs.rmSync(to, { recursive: true, force: true });
        const moved = pick.machine !== os.hostname();
        // Schedules are local time: on a machine set to another time zone everything would arrive at the wrong hour.
        const zoneNote =
          origin?.timezone && origin.timezone !== zone()
            ? [
                '',
                `⚠️  This machine's time zone is ${zone()}; the backup was made in ${origin.timezone}. Your briefing, reminders and schedules are in local time, so they would arrive at the wrong hour. Set it before starting blackcat: sudo timedatectl set-timezone ${origin.timezone}`,
              ]
            : [];
        return [
          `Restored the backup from ${pick.made}${moved ? ` (made on ${pick.machine})` : ''}: ${did.join(', ')}.`,
          '',
          'Next:',
          ...(moved
            ? [`  On ${pick.machine}: bc stop && bc service uninstall     (a login to a chat service can be in use in only one place)`]
            : []),
          ...(i.paused
            ? [
                `  Everything is switched off (${paused.join(', ')}): nothing logs in, sends or runs by itself.`,
                '  Commands and `bc chat` work. To switch one on: bc service install <name>. All of them: bc service install',
              ]
            : ['  bc service install     start blackcat here']),
          '  bc msg index           rebuild the search index (it is not in the backup)',
          '  bc status              check everything',
          ...(moved
            ? [
                '',
                'On a new machine also check: the engine is ready (bc engine status), and any check that looks at this machine itself (bc watch list).',
              ]
            : []),
          ...zoneNote,
          '',
          `When you are happy, delete ${aside}.`,
        ].join('\n');
      },
    },
  },

  jobs: [
    {
      id: 'nightly',
      // Every day at the time chosen in setup.
      cron: (ctx) => fromTimes(settings(ctx).time, 'daily'),
      when: configured,
      summary: 'make a backup and send it',
      run: async (ctx) => {
        try {
          const r = await backup(ctx);
          ctx.log(`backup sent: ${r.name} (${mb(r.bytes)})`);
          return { did: `backup sent (${mb(r.bytes)})` };
        } catch (e) {
          ctx.log(`backup failed: ${e.message}`);
          await ctx.notify(`⚠️ Last night's backup failed: ${e.message}\n\nTry it by hand on this machine: bc backup now`);
          throw e; // so the run is recorded as failed
        }
      },
    },
  ],

  // `bc selftest`: the place backups are kept is reached and its folder read; and the last backup is not old. Nothing is written.
  selftest: (ctx) =>
    configured(ctx)
      ? [
          {
            name: whereText(settings(ctx)),
            run: async () => {
              const s = settings(ctx);
              const all = await listKept(ctx);
              const mine = all.filter((b) => b.mine);
              const { last: l, lastError: e } = last(ctx);
              if (e && (!l || e.at > l.at)) throw new Error(`reachable, and the last backup failed ${ago(e.at)}: ${e.message}`);
              if (l && Date.now() / 1000 - l.at > 2 * 86400) throw new Error(`reachable, and the last backup is ${ago(l.at)} old`);
              return `reachable · ${mine.length} backup${mine.length === 1 ? '' : 's'} of this machine kept${mine[0] ? ` · the newest is ${mine[0].made} (${mb(mine[0].bytes)})` : ''}${s.encrypt ? ' · encrypted' : ' · not encrypted'}`;
            },
          },
        ]
      : [],

  status: (ctx) => {
    if (!configured(ctx)) return 'not set up → bc backup setup';
    const s = { ...settings(ctx), ...last(ctx) };
    const failed = s.lastError && (!s.last || s.lastError.at > s.last.at);
    return `${failed ? `THE LAST ONE FAILED ${ago(s.lastError.at)}: ${s.lastError.message} · ` : ''}${s.last ? `last backup ${ago(s.last.at)} (${mb(s.last.bytes)})` : 'no backup made yet'} · next at ${s.time}`;
  },

  settings: (ctx) => {
    const s = settings(ctx);
    return configured(ctx)
      ? { 'kept on': whereText(s), 'every day at': s.time, keep: `the last ${s.keep}`, encrypted: s.encrypt ? 'yes' : 'no' }
      : { 'not set up': 'run bc backup setup' };
  },

  // For `bc engine check`: what the owner might say, and the command it should lead to.
  checks: (ctx) => (configured(ctx) ? [{ say: 'is my data backed up?', expect: /blackcat backup (list|status)\b/ }] : []),
  agent: {
    fill: (ctx) => ({ ready: configured(ctx), where: configured(ctx) ? whereText(settings(ctx)) : null, time: settings(ctx).time }),
  },
};
