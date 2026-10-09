// SSH: let the agent look at, and with your approval act on, other machines.
// Each host has its own key (the agent never sees it) and a mode that decides what
// the agent may run there.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { classify } from '../../src/api.js';

const MODES = {
  read: 'look only: read-only commands run, everything else is refused',
  ask: 'look freely, ask before changing: anything not read-only needs your Allow in Telegram',
  full: 'no questions asked (only for machines you could afford to lose)',
};
const NAME = /^[a-z][a-z0-9-]{0,30}$/;
const MAX_OUTPUT = 20_000;

const DEFAULT_KEEP_OPEN = 30; // minutes

const hosts = (ctx) => ctx.config.get().hosts ?? {};
const keepOpen = (ctx) => ctx.config.get().keepOpenMinutes ?? DEFAULT_KEEP_OPEN;

// Where the sockets of shared connections live: the per-user runtime folder (private,
// in memory, short path), or the plugin's own folder if there isn't one.
function socketDir(ctx) {
  const run = process.env.XDG_RUNTIME_DIR;
  const dir = run && fs.existsSync(run) ? path.join(run, 'blackcat-ssh') : path.join(ctx.dataDir, 'cm');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
const keyPath = (ctx, name) => path.join(ctx.dataDir, 'keys', name);
const knownHosts = (ctx) => path.join(ctx.dataDir, 'known_hosts');

function hostOr(ctx, name) {
  const h = hosts(ctx)[name];
  if (!h) ctx.fail(`No host called "${name}". Known hosts: ${Object.keys(hosts(ctx)).join(', ') || 'none yet (bc ssh add)'}`);
  return h;
}

// One argument is taken as a whole command line. Several are words, re-quoted so that
// spaces inside a word survive the trip through the remote shell.
function remoteCommand(tokens) {
  if (tokens.length === 1) return tokens[0];
  return tokens.map((t) => (/^[A-Za-z0-9_/.:=,@%+-]+$/.test(t) ? t : `'${t.replace(/'/g, `'\\''`)}'`)).join(' ');
}

// Connection sharing: the first command to a host logs in and leaves the connection
// open in the background; later commands reuse it (about 30 ms instead of a fresh login),
// and it closes by itself after `keepOpen` minutes without use.
// `fresh` forces a new login, for testing that the key really works.
function shareArgs(ctx, { fresh = false } = {}) {
  const minutes = keepOpen(ctx);
  if (fresh || !minutes) return ['-o', 'ControlPath=none'];
  return ['-o', 'ControlMaster=auto', '-o', `ControlPath=${path.join(socketDir(ctx), '%C')}`, '-o', `ControlPersist=${minutes * 60}`];
}

// Ask the background connection for a host to do something: 'check' (is it open?) or 'exit' (close it).
async function shared(ctx, name, h, op) {
  if (!keepOpen(ctx)) return false;
  const r = await ctx.exec(
    'ssh',
    ['-o', `ControlPath=${path.join(socketDir(ctx), '%C')}`, '-O', op, '-p', String(h.port ?? 22), `${h.user}@${h.host}`],
    { timeoutMs: 5000 },
  );
  return r.code === 0;
}

function sshArgs(ctx, name, h, opts) {
  const extra = shareArgs(ctx, opts);
  return [
    '-i',
    keyPath(ctx, name),
    '-o',
    'BatchMode=yes',
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    `UserKnownHostsFile=${knownHosts(ctx)}`,
    // Trust the machine's identity the first time, and refuse if it ever changes.
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'LogLevel=ERROR',
    '-p',
    String(h.port ?? 22),
    ...extra,
    `${h.user}@${h.host}`,
  ];
}

// A path for the remote shell, safely quoted.
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const TRANSFER_TIMEOUT_MS = 60 * 60_000;

// Copy a file to or from a host over the same login the commands use. Data is streamed
// through `cat`, so it needs nothing on the other side but a shell. An upload lands under
// a temporary name and is renamed when complete, so a broken transfer leaves no half file.
function transfer(ctx, name, h, { local, remote, up }) {
  return new Promise((resolve) => {
    const cmd = up ? `cat > ${q(`${remote}.part`)} && mv -f ${q(`${remote}.part`)} ${q(remote)}` : `cat ${q(remote)}`;
    const child = spawn('ssh', [...sshArgs(ctx, name, h), '--', cmd], { stdio: [up ? 'pipe' : 'ignore', up ? 'ignore' : 'pipe', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), TRANSFER_TIMEOUT_MS);
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
    if (up) {
      child.stdin.on('error', () => {});
      fs.createReadStream(local)
        .on('error', (e) => ((stderr += e.message), child.kill('SIGTERM')))
        .pipe(child.stdin);
    }
    // A download is whole only once everything received has been written out: the program
    // ending and the file being finished are two things, and both are waited for.
    const out = up ? null : fs.createWriteStream(`${local}.part`, { mode: 0o600 });
    const written = out ? new Promise((done) => out.on('finish', () => done(null)).on('error', (e) => done(e))) : Promise.resolve(null);
    if (out) child.stdout.pipe(out);
    child.on('error', (e) => resolve({ code: 255, stderr: e.message }));
    child.on('close', async (code) => {
      clearTimeout(timer);
      if (!up) {
        const failed = await written;
        if (failed)
          return (fs.rmSync(`${local}.part`, { force: true }), resolve({ code: 1, stderr: `could not write ${local}: ${failed.message}` }));
        if (code === 0) fs.renameSync(`${local}.part`, local);
        else fs.rmSync(`${local}.part`, { force: true });
      }
      resolve({ code: code ?? 1, stderr });
    });
  });
}

// Run one fixed command on a host and give back what it printed, or say why not.
async function onHost(ctx, name, cmd, failed) {
  const h = hostOr(ctx, name);
  const r = await ctx.exec('ssh', [...sshArgs(ctx, name, h), '--', cmd], { timeoutMs: (h.timeout ?? 60) * 1000 });
  if (r.code === 255 && !r.stdout) throw new Error(`could not reach ${name}: ${explain(r.stderr)}`);
  if (r.code !== 0) throw new Error(`${failed} on ${name}: ${(r.stderr || r.stdout).trim().split('\n').pop() || `exit ${r.code}`}`);
  return r.stdout;
}

const explain = (stderr) => {
  if (/Permission denied/.test(stderr))
    return "the machine refused blackcat's key. Has its public key been added there? See: bc ssh key <host>";
  if (/Could not resolve|Name or service not known/.test(stderr)) return "that address can't be found";
  if (/timed out|No route to host|Connection refused/.test(stderr))
    return "the machine isn't reachable (off, wrong address or port, or SSH not running)";
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/.test(stderr))
    return 'the machine at that address is not the one seen before (reinstalled, or something is impersonating it). Remove and re-add the host if this is expected';
  return stderr.trim().split('\n').pop();
};

export default {
  api: 1,
  name: 'ssh',
  title: 'SSH',
  description: 'look at, and with your approval act on, other machines (a NAS, a server, anything with SSH)',

  help: `Connections: the first command to a host logs in, and that connection is kept open in the
background and reused (about 30 ms per command instead of a new login each time). It closes
after 30 minutes without use (bc ssh keep-open <minutes>; 0 turns sharing off), when you change
a host's mode or remove it, with bc ssh close, and when the agent service restarts.
bc ssh test always makes a new login.

Modes, per host:
  read   ${MODES.read}
  ask    ${MODES.ask}
  full   ${MODES.full}

"Read-only" is judged from the command text (bc ssh judge '<command>' shows how one is judged).
That stops mistakes and the obvious tricks, but it is not a guarantee. For one, also restrict
the key on the remote machine: in its authorized_keys, put  command="/path/to/a-wrapper"  before
the key, with a wrapper script that only runs the commands you accept.
Commands that read passwords or keys (docker inspect, files under .ssh, .env, /boot/config…)
count as sensitive: refused in read mode, and need approval in ask mode.`,

  commands: {
    list: {
      summary: 'the machines blackcat can reach, and what the agent may do on each',
      access: 'allow',
      untrusted: false,
      run: async (ctx) => {
        const list = [];
        for (const [name, h] of Object.entries(hosts(ctx))) {
          list.push({
            name,
            address: `${h.user}@${h.host}${h.port && h.port !== 22 ? `:${h.port}` : ''}`,
            mode: h.mode,
            meaning: MODES[h.mode],
            connectionOpen: await shared(ctx, name, h, 'check'),
          });
        }
        const keep = keepOpen(ctx);
        return {
          text: list.length
            ? `${list.map((h) => `${h.name.padEnd(12)} ${h.address.padEnd(28)} ${h.mode.padEnd(5)} ${h.connectionOpen ? 'connection open' : ''}`).join('\n')}\n\n${keep ? `Connections stay open for ${keep} minutes after the last command.` : 'A new connection is made for every command.'}`
            : 'No hosts yet. Add one with: bc ssh add',
          data: { hosts: list, keepOpenMinutes: keep },
        };
      },
    },

    add: {
      summary: 'add a machine',
      access: 'owner',
      form: [
        {
          id: 'name',
          type: 'text',
          message: 'A short name for this machine (e.g. unraid)',
          validate: (v, _a, ctx) =>
            !NAME.test(v) ? 'Lowercase letters, digits and dashes' : hosts(ctx)[v] ? 'There is already a host with that name' : undefined,
        },
        {
          id: 'host',
          type: 'text',
          message: 'Its address (IP or hostname)',
          validate: (v) => (/^[A-Za-z0-9.:_-]+$/.test(v) ? undefined : 'An IP address or hostname'),
        },
        {
          id: 'user',
          type: 'text',
          message: 'Log in as which user',
          default: 'root',
          validate: (v) => (/^[a-z_][a-z0-9_-]*$/i.test(v) ? undefined : 'A user name'),
        },
        {
          id: 'port',
          type: 'text',
          message: 'SSH port',
          default: 22,
          validate: (v) => (/^\d{1,5}$/.test(String(v)) ? undefined : 'A port number'),
        },
        {
          id: 'mode',
          type: 'select',
          message: 'What may the agent do there?',
          default: 'ask',
          options: Object.entries(MODES).map(([value, hint]) => ({ value, label: value, hint })),
        },
      ],
      run: async (ctx, a) => {
        const key = keyPath(ctx, a.name);
        fs.mkdirSync(path.dirname(key), { recursive: true, mode: 0o700 });
        if (!fs.existsSync(key)) {
          const r = await ctx.exec('ssh-keygen', ['-t', 'ed25519', '-N', '', '-q', '-C', `blackcat-${a.name}`, '-f', key]);
          if (r.code !== 0) ctx.fail(`Could not create a key: ${r.stderr.trim()}`);
        }
        ctx.config.set({ hosts: { ...hosts(ctx), [a.name]: { host: a.host, user: a.user, port: Number(a.port), mode: a.mode } } });
        const pub = fs.readFileSync(`${key}.pub`, 'utf8').trim();
        return {
          text: [
            `Added "${a.name}" (${a.user}@${a.host}, mode: ${a.mode}).`,
            '',
            `One step left, on ${a.host}: add this line to ${a.user === 'root' ? '/root' : `/home/${a.user}`}/.ssh/authorized_keys`,
            '',
            pub,
            '',
            'On Unraid: Settings → Management Access → paste it under "SSH authorized keys" (it then survives reboots).',
            ctx.surface === 'chat' ? `Then ask me to test the connection to ${a.name}.` : `Then check it works:  bc ssh test ${a.name}`,
          ].join('\n'),
          data: { name: a.name, publicKey: pub },
        };
      },
    },

    key: {
      summary: "show a host's public key again",
      access: 'owner',
      usage: '<host>',
      run: (ctx, { host }) => {
        hostOr(ctx, host);
        return fs.readFileSync(`${keyPath(ctx, host)}.pub`, 'utf8').trim();
      },
    },

    test: {
      summary: 'check that blackcat can log in to a host',
      access: 'allow',
      usage: '<host>',
      untrusted: false,
      run: async (ctx, { host }) => {
        const h = hostOr(ctx, host);
        // A new login every time, never a reused connection: this checks the key is still accepted.
        const r = await ctx.exec('ssh', [...sshArgs(ctx, host, h, { fresh: true }), '--', 'echo blackcat-ok; uname -sr'], {
          timeoutMs: 20_000,
        });
        const ok = r.code === 0 && r.stdout.includes('blackcat-ok');
        return {
          text: ok ? `✓ ${host} works (${r.stdout.split('\n')[1] ?? ''})` : `✗ ${host}: ${explain(r.stderr)}`,
          data: { host, ok, detail: ok ? r.stdout.split('\n')[1] : explain(r.stderr) },
        };
      },
    },

    mode: {
      summary: 'change what the agent may do on a host',
      access: 'owner',
      usage: '<host> <mode>',
      run: async (ctx, { host, mode }) => {
        const h = hostOr(ctx, host);
        if (!MODES[mode]) ctx.fail(`Mode is one of: ${Object.keys(MODES).join(', ')}`);
        ctx.config.set({ hosts: { ...hosts(ctx), [host]: { ...h, mode } } });
        await shared(ctx, host, h, 'exit');
        return `${host} is now "${mode}": ${MODES[mode]}.`;
      },
    },

    remove: {
      summary: 'remove a machine, and delete its key',
      access: 'owner',
      usage: '[name]', // bc ssh remove nas (it still asks whether you are sure, unless --sure)
      form: [
        {
          id: 'name',
          type: 'select',
          message: 'Remove which machine?',
          options: (_a, ctx) => Object.keys(hosts(ctx)).map((n) => ({ value: n, label: n })),
        },
        { id: 'sure', type: 'confirm', message: (a) => `Forget "${a.name}" and delete its key?`, default: false },
      ],
      run: async (ctx, a) => {
        if (!a.sure) return 'Nothing changed.';
        await shared(ctx, a.name, hostOr(ctx, a.name), 'exit');
        const { [a.name]: _gone, ...rest } = hosts(ctx);
        ctx.config.set({ hosts: rest });
        for (const f of [keyPath(ctx, a.name), `${keyPath(ctx, a.name)}.pub`]) fs.rmSync(f, { force: true });
        return `Removed "${a.name}". Also delete the blackcat-${a.name} line from authorized_keys on that machine.`;
      },
    },

    close: {
      summary: 'close the open connection to a host, or to all of them',
      access: 'allow', // closing only makes the next command log in again
      usage: '[host]',
      untrusted: false,
      run: async (ctx, { host }) => {
        const names = host ? [host] : Object.keys(hosts(ctx));
        const closed = [];
        for (const n of names) if (await shared(ctx, n, hostOr(ctx, n), 'exit')) closed.push(n);
        return { text: closed.length ? `Closed: ${closed.join(', ')}` : 'No connections were open.', data: { closed } };
      },
    },

    'keep-open': {
      summary: 'how long a connection stays open after its last command (0 = connect every time)',
      access: 'owner',
      usage: '<minutes>',
      run: async (ctx, { minutes }) => {
        const n = Number(minutes);
        if (!Number.isInteger(n) || n < 0 || n > 720) ctx.fail('Minutes: a whole number from 0 to 720.');
        // Close what is open under the old setting, so the new one applies from the next command.
        for (const [name, h] of Object.entries(hosts(ctx))) await shared(ctx, name, h, 'exit');
        ctx.config.set({ keepOpenMinutes: n });
        return n
          ? `Connections now stay open for ${n} minutes after the last command.`
          : 'Connection sharing is off: every command logs in afresh.';
      },
    },

    judge: {
      summary: 'show how a command would be judged (read-only, sensitive or a change) without running it',
      access: 'allow',
      raw: true,
      untrusted: false,
      run: (_ctx, { _: tokens }) => {
        const cmd = remoteCommand(tokens);
        const kind = classify(cmd);
        return { text: `${kind}: ${cmd}`, data: { command: cmd, kind } };
      },
    },

    put: {
      summary: 'copy a file from this machine to a host: bc ssh put <host> <local file> <remote path>',
      // Sending files off this machine is the owner's call (and other plugins', such as backups), never the agent's.
      access: 'owner',
      usage: '<host> <local> <remote>',
      run: async (ctx, i) => {
        const h = hostOr(ctx, i.host);
        if (!fs.existsSync(i.local) || !fs.statSync(i.local).isFile()) ctx.fail(`${i.local} is not a file.`);
        const r = await transfer(ctx, i.host, h, { local: i.local, remote: i.remote, up: true });
        if (r.code !== 0) ctx.fail(`Could not copy to ${i.host}: ${explain(r.stderr) || `exit ${r.code}`}`);
        const bytes = fs.statSync(i.local).size;
        return {
          text: `Copied ${path.basename(i.local)} to ${i.host}:${i.remote} (${(bytes / 1024 ** 2).toFixed(1)} MB)`,
          data: { host: i.host, remote: i.remote, bytes },
        };
      },
    },

    get: {
      summary: 'copy a file from a host to this machine: bc ssh get <host> <remote path> <local file>',
      access: 'owner',
      usage: '<host> <remote> <local>',
      run: async (ctx, i) => {
        const h = hostOr(ctx, i.host);
        const r = await transfer(ctx, i.host, h, { local: i.local, remote: i.remote, up: false });
        if (r.code !== 0) ctx.fail(`Could not copy from ${i.host}: ${explain(r.stderr) || `exit ${r.code}`}`);
        const bytes = fs.statSync(i.local).size;
        return {
          text: `Copied ${i.host}:${i.remote} to ${i.local} (${(bytes / 1024 ** 2).toFixed(1)} MB)`,
          data: { host: i.host, local: i.local, bytes },
        };
      },
    },

    run: {
      summary: "run a command on a host: bc ssh run <host> '<command>'",
      raw: true,
      // Decided per command: the host's mode and whether the command only reads.
      access: (ctx, tokens) => {
        const [name, ...rest] = tokens;
        const h = hosts(ctx)[name];
        if (!h) return { level: 'never', reason: `there is no SSH host called "${name}". Run \`blackcat ssh list\` to see them` };
        if (!rest.length) return { level: 'never', reason: 'say what to run' };
        const cmd = remoteCommand(rest);
        const kind = classify(cmd);
        if (h.mode === 'full' || kind === 'read') return { level: 'allow' };
        if (h.mode === 'ask')
          return {
            level: 'ask',
            describe: `on ${name} (${h.user}@${h.host})${kind === 'sensitive' ? ', which may show passwords or keys' : ''}`,
          };
        return {
          level: 'never',
          reason:
            kind === 'sensitive'
              ? `"${name}" is look-only, and that command could show passwords or keys`
              : `"${name}" is look-only for you, and that is not a read-only command. Tell the owner what you wanted to run; they can run it themselves or change the host's mode`,
        };
      },
      run: async (ctx, { _: tokens }) => {
        const [name, ...rest] = tokens;
        if (!name || !rest.length) ctx.fail("Usage: bc ssh run <host> '<command>'");
        const h = hostOr(ctx, name);
        const cmd = remoteCommand(rest);
        const r = await ctx.exec('ssh', [...sshArgs(ctx, name, h), '--', cmd], { timeoutMs: (h.timeout ?? 60) * 1000 });
        // 255 is ssh itself failing (not the remote command).
        if (r.code === 255 && !r.stdout) ctx.fail(`Could not run it on ${name}: ${explain(r.stderr)}`);
        const clip = (s) =>
          s.length > MAX_OUTPUT
            ? `${s.slice(0, MAX_OUTPUT / 2)}\n… (${s.length - MAX_OUTPUT} characters left out) …\n${s.slice(-MAX_OUTPUT / 2)}`
            : s;
        const out = clip(r.stdout);
        const err = clip(r.stderr);
        return {
          text: [
            out.trimEnd(),
            err.trim() ? `(stderr) ${err.trim()}` : null,
            r.timedOut ? '(stopped: it ran longer than the time limit)' : r.code ? `(exit code ${r.code})` : null,
          ]
            .filter(Boolean)
            .join('\n'),
          data: { host: name, command: cmd, exitCode: r.code, timedOut: !!r.timedOut, stdout: out, stderr: err },
        };
      },
    },
  },

  status: (ctx) => {
    const list = Object.entries(hosts(ctx));
    return list.length ? list.map(([n, h]) => `${n} (${h.mode})`).join(', ') : 'no hosts yet → bc ssh add';
  },

  settings: (ctx) => ({
    ...Object.fromEntries(
      Object.entries(hosts(ctx)).map(([n, h]) => [n, `${h.user}@${h.host}:${h.port ?? 22}, the agent's mode: ${h.mode}`]),
    ),
    'connections stay open': keepOpen(ctx) ? `${keepOpen(ctx)} minutes after the last command` : 'no',
  }),

  // For `bc engine check`: what the owner might say, and the command it should lead to.
  checks: (ctx) => {
    const name = Object.keys(hosts(ctx))[0];
    return name
      ? [{ say: `how much disk space is free on ${name}`, expect: new RegExp(`blackcat (ssh run ${name}|shortcut run \\w+)\\b`) }]
      : [];
  },
  // `bc selftest`: a fresh login to every host, never a reused connection, so that the key is tried.
  selftest: (ctx) =>
    Object.entries(hosts(ctx)).map(([name, h]) => ({
      name,
      run: async () => {
        const r = await ctx.exec('ssh', [...sshArgs(ctx, name, h, { fresh: true }), '--', 'echo blackcat-ok; uname -sr'], {
          timeoutMs: 20_000,
        });
        if (r.code !== 0 || !r.stdout.includes('blackcat-ok')) throw new Error(explain(r.stderr) || `exit ${r.code}`);
        return `logged in as ${h.user}@${h.host} · ${r.stdout.split('\n')[1] ?? ''} · the agent's mode: ${h.mode}`;
      },
    })),
  // Every machine is a place files can be kept (a backup's, say): see src/storage.js. Only
  // these fixed things are done there, each on full paths given by blackcat itself.
  storage: {
    label: 'machines reached over SSH',
    places: (ctx) => Object.entries(hosts(ctx)).map(([n, h]) => ({ id: n, label: `${n} (${h.user}@${h.host})` })),
    list: async (ctx, name, dir) => {
      const out = await onHost(ctx, name, `LC_ALL=C ls -lp -- ${q(dir)}`, `${dir} can't be read`);
      // "-rw------- 1 me users 1234 Oct  7 03:30 name": the size is the fifth word, the name everything after the eighth.
      return out
        .split('\n')
        .map((l) => /^([-dl])\S+\s+\S+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s(.+)$/.exec(l))
        .filter((m) => m && !m[3].startsWith('.'))
        .map((m) => ({
          name: m[3].replace(/\/$/, '').replace(/ -> .*$/, ''),
          folder: m[1] === 'd' || m[3].endsWith('/'),
          bytes: Number(m[2]),
        }));
    },
    mkdir: async (ctx, name, dir) => void (await onHost(ctx, name, `mkdir -p -- ${q(dir)}`, `${dir} can't be made`)),
    put: async (ctx, name, file, to) => {
      const r = await transfer(ctx, name, hostOr(ctx, name), { local: file, remote: to, up: true });
      if (r.code !== 0) throw new Error(`could not copy to ${name}: ${explain(r.stderr) || `exit ${r.code}`}`);
      // What is kept may hold messages and logins: only the account that receives it may read it.
      await onHost(ctx, name, `chmod 600 -- ${q(to)}`, `${to} could not be made private`);
    },
    get: async (ctx, name, from, file) => {
      const r = await transfer(ctx, name, hostOr(ctx, name), { local: file, remote: from, up: false });
      if (r.code !== 0) throw new Error(`could not copy from ${name}: ${explain(r.stderr) || `exit ${r.code}`}`);
    },
    remove: async (ctx, name, paths) =>
      void (await onHost(ctx, name, `rm -f -- ${paths.map(q).join(' ')}`, 'the old files could not be removed')),
    free: async (ctx, name, dir) =>
      (await onHost(ctx, name, `df -h -- ${q(dir)} | tail -1`, 'the free space could not be read')).trim().split(/\s+/)[3] ?? null,
  },
  agent: {
    fill: (ctx) => ({
      ready: Object.keys(hosts(ctx)).length > 0,
      hosts: Object.entries(hosts(ctx))
        .map(([n, h]) => `${n} (${h.user}@${h.host}, mode ${h.mode})`)
        .join('; '),
    }),
  },
};
