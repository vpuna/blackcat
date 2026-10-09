// The waiting process behind src/agent/warm.js: load everything a command needs, wait to be
// handed one command, run it exactly as `blackcat …` would, and end.
//
// What the command prints goes back over the connection instead of to this process's own
// output. To the caller:  A (accepted), then any number of  O/E + length + bytes  (output and
// errors, in the order written), then  X + exit code.  The caller answers A with G (go):
// nothing runs until then, so a caller that gave up waiting can never have its command run
// here as well as there.
import path from 'node:path';

const FRAME = { out: 0x4f, err: 0x45, exit: 0x58 };
class Exit extends Error {}

// ---- load, as a command would at its start ----
await Promise.all([import('better-sqlite3'), import('../internal.js')]);
const main = await import('../main.js');
const program = await main.build();

let started = false;
const idleExit = () => {
  if (!started) process.exit(0);
};
process.on('disconnect', idleExit); // the agent service has gone, and no command is running
process.on('message', (m, sock) => {
  if (m !== 'job' || !sock || started) return;
  process.off('disconnect', idleExit);
  serve(sock);
});
process.send?.('ready');

function serve(sock) {
  const realExit = process.exit.bind(process);
  let finishing = false;
  let request = null;
  let buf = Buffer.alloc(0);
  const giveUp = setTimeout(() => realExit(0), 5000); // the caller never said go

  const frame = (type, data) => {
    const body = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const head = Buffer.alloc(5);
    head[0] = type;
    head.writeUInt32BE(body.length, 1);
    return Buffer.concat([head, body]);
  };
  function finish(code) {
    if (finishing) return;
    finishing = true;
    const c = Number.isInteger(code) ? code : 0;
    sock.ref();
    sock.end(frame(FRAME.exit, String(c)), () => realExit(c));
    setTimeout(() => realExit(c), 3000);
  }

  sock.on('error', () => {});
  // The caller has gone. Before the command started, nothing has happened; during it, stop,
  // as a command whose terminal closed would.
  sock.on('close', () => {
    if (finishing) return;
    if (started) {
      try {
        process.kill(-process.pid, 'SIGTERM'); // this process and everything it started
      } catch {}
    }
    realExit(started ? 1 : 0);
  });
  // The request (one line) is answered with A; G follows once the caller has seen that.
  sock.on('data', (d) => {
    if (started) return;
    buf = Buffer.concat([buf, d]);
    if (!request) {
      const nl = buf.indexOf(0x0a);
      if (nl < 0) return void (buf.length > 256 * 1024 && realExit(0));
      try {
        request = JSON.parse(buf.subarray(0, nl).toString('utf8'));
      } catch {
        return void realExit(0);
      }
      buf = buf.subarray(nl + 1);
      sock.write('A');
    }
    if (buf.length && buf[0] === 0x47) {
      clearTimeout(giveUp);
      run(request);
    }
  });
  sock.resume();

  async function run(req) {
    started = true;
    // Become the command: its arguments, its folder, its environment. Who is asking is not
    // taken from the request: this path only ever serves the agent.
    const { BLACKCAT_HOME: home } = process.env;
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, req.env ?? {}, { BLACKCAT_CALLER: 'agent' });
    if (home === undefined) delete process.env.BLACKCAT_HOME;
    else process.env.BLACKCAT_HOME = home;
    process.argv = [process.argv[0], path.join(import.meta.dirname, '../../bin/bc.js'), ...(req.argv ?? [])];
    try {
      process.chdir(req.cwd);
    } catch {}

    const send = (type) =>
      function write(chunk, enc, cb) {
        const done = typeof enc === 'function' ? enc : cb;
        if (!finishing)
          sock.write(
            frame(type, typeof chunk === 'string' ? Buffer.from(chunk, typeof enc === 'string' ? enc : 'utf8') : Buffer.from(chunk)),
          );
        done?.();
        return true;
      };
    process.stdout.write = send(FRAME.out);
    process.stderr.write = send(FRAME.err);
    process.exit = (code) => {
      finish(code ?? process.exitCode ?? 0);
      throw new Exit(); // nothing after process.exit() may run
    };
    // What Node does with an error nobody caught: print it, and end with a failure.
    process.on('uncaughtException', (e) => {
      if (e instanceof Exit) return;
      process.stderr.write(`${e?.stack ?? e}\n`);
      finish(1);
    });
    // When the command has nothing left to do, it is over.
    process.on('beforeExit', () => finish(process.exitCode ?? 0));
    sock.unref();

    try {
      await main.run(req.argv ?? [], program);
    } catch (e) {
      if (!(e instanceof Exit)) {
        process.stderr.write(`${e?.stack ?? e}\n`);
        finish(1);
      }
    }
  }
}
