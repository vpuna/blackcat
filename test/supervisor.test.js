// blackcat's own supervisor: it starts every service, keeps each running, and stops them.
// Tried here on an installation of its own with stand-in services, as it would run under
// the boot unit, in a container or in a terminal.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { home } from './helpers.js';

const dir = home();
const root = new URL('..', import.meta.url).pathname;
const { FORCE_COLOR: _f, BLACKCAT_CALLER: _c, ...base } = process.env;
const env = { ...base, NO_COLOR: '1', BLACKCAT_SUPERVISOR_FAST: '1' };
const bc = (...a) => {
  const r = spawnSync(process.execPath, [`${root}bin/bc.js`, ...a], { encoding: 'utf8', env, timeout: 60_000, input: '' });
  return { ...r, said: r.stdout + r.stderr };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (what, fn, ms = 15_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
    const v = await fn();
    if (v) return v;
  }
  throw new Error(`never happened: ${what}\n${JSON.stringify(state(), null, 1)}`);
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Stand-in services: one that stays up (and starts a process of its own), one that keeps
// dying, one that says it needs the owner, one that will not stop when asked, and one that
// is not ready until something is set up.
fs.mkdirSync(path.join(dir, 'user-plugins/svc'), { recursive: true });
fs.writeFileSync(
  path.join(dir, 'user-plugins/svc/plugin.js'),
  `import { spawn } from 'node:child_process';
const forever = () => new Promise(() => setInterval(() => {}, 1000));
const cmd = (run) => ({ summary: 'a stand-in', access: 'owner', hidden: true, run });
export default {
  api: 1, name: 'svc', title: 'Stand-ins', description: 'services for the tests',
  services: [
    { id: 'steady', summary: 'stays up', command: 'steady' },
    { id: 'crashy', summary: 'keeps dying', command: 'crashy' },
    { id: 'needy', summary: 'needs the owner', command: 'needy' },
    { id: 'stubborn', summary: 'will not stop', command: 'stubborn' },
    { id: 'later', summary: 'not ready at first', command: 'steady', ready: (ctx) => (ctx.config.get().go ? null : 'not set up yet') },
  ],
  commands: {
    steady: cmd(async () => { console.log('steady is up as ' + process.env.BLACKCAT_SERVICE); await forever(); }),
    crashy: cmd(async () => { console.log('about to fall over'); await new Promise((r) => setTimeout(r, 30)); process.exit(1); }),
    needy: cmd(async () => { console.error('logged out: link the account again'); process.exit(3); }),
    stubborn: cmd(async () => {
      const kid = spawn('sleep', ['300'], { stdio: 'ignore' });
      console.log('its own process is ' + kid.pid);
      process.on('SIGTERM', () => console.log('asked to stop, and will not'));
      await forever();
    }),
  },
};
`,
);
const { save, update } = await import('../src/config.js');
save({ plugins: { enabled: ['svc'], disabled: ['wa', 'tg'] } });
const U = await import('../src/service/units.js');
U.setSwitchedOff(['agent']); // (the agent itself is tried in its own tests; here it would only be slow)
const state = () => U.supervisorState();
const svc = (id) => state()?.services?.[id];
const logOf = (id) => (fs.existsSync(U.logFile(id)) ? fs.readFileSync(U.logFile(id), 'utf8') : '');

let sup = null;
let out = '';
const startSupervisor = () => {
  out = '';
  sup = spawn(process.execPath, [`${root}bin/bc.js`, 'service', 'run'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  sup.stdout.on('data', (d) => (out += d));
  sup.stderr.on('data', (d) => (out += d));
  sup.gone = new Promise((r) => sup.on('exit', (code, signal) => r({ code, signal })));
  return until(
    'the supervisor is up',
    () => state()?.pid === sup.pid && svc('steady')?.state === 'running' && svc('later') && svc('agent'),
  );
};
// Whatever a failed test leaves behind is ended: the supervisor, and anything running for this folder.
after(() => {
  sup?.kill('SIGKILL');
  const pids = spawnSync('pgrep', ['-f', 'bin/bc.js'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map(Number);
  for (const pid of pids) {
    let its = '';
    try {
      its = fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
    } catch {}
    if (!its.includes(`BLACKCAT_HOME=${dir}\0`) || pid === process.pid) continue;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  }
});

test('with nothing running, the commands say so and say how to start it', () => {
  assert.match(
    bc('start', 'steady').said,
    /blackcat is not running\. Start it at boot and now: bc service install\. Or in this terminal: bc service run/,
  );
  const st = JSON.parse(bc('status', '--json').stdout);
  assert.deepEqual([st.supervisor.running, st.services.steady.state, st.services.steady.detail], [false, 'inactive', 'not running']);
  assert.match(bc('status').stdout, /blackcat +○ not running/);
});

test('it starts what is ready, each as blackcat would run it; what is not ready waits, and says why', async () => {
  await startSupervisor();
  assert.deepEqual([svc('steady').state, svc('later').state, svc('later').why], ['running', 'waiting', 'not set up yet']);
  assert.ok(alive(svc('steady').pid));
  await until('it has written something', () => /steady is up as steady/.test(logOf('steady')));
  assert.match(
    logOf('steady'),
    /^\d{4}-\d\d-\d\dT[\d:.]+Z \[blackcat\] started \(pid \d+\)\n\d{4}-\d\d-\d\dT[\d:.]+Z steady is up as steady$/m,
    'each line with its time',
  );
  // switched off: not started
  assert.equal(svc('agent').state, 'stopped');
  assert.match(svc('agent').why, /switched off/);
  // and it is all in bc status
  const st = JSON.parse(bc('status', '--json').stdout);
  // (Run inside a container, these tests find that a container is what keeps it.)
  const inContainer = fs.existsSync('/.dockerenv');
  assert.deepEqual([st.supervisor.running, st.supervisor.pid, st.supervisor.keeper], [true, sup.pid, inContainer ? 'container' : null]);
  assert.deepEqual([st.services.steady.state, st.services.steady.pid, st.services.agent.installed], ['active', svc('steady').pid, false]);
  assert.ok(st.services.steady.memory > 1024 ** 2, 'what it uses is counted');
  const text = bc('status').stdout;
  assert.match(text, /steady +● running +up 0m \d+s · pid \d+ · \d+ MB/);
  assert.match(text, /later +○ waiting +not set up yet/);
  assert.match(text, /agent +○ switched off +→ bc service install agent/);
  assert.match(text, inContainer ? /boot +● started with its container/ : /boot +● started by hand: not at boot → bc service install/);
});

test('one that dies is started again, a little later each time; one that says it needs the owner is left stopped', async () => {
  await until('crashy has been restarted a few times', () => svc('crashy')?.restarts >= 3);
  const log = logOf('crashy');
  const waits = [...log.matchAll(/starting it again in ([\d.]+) s/g)].map((m) => Number(m[1]));
  assert.deepEqual(waits.slice(0, 3), [0.1, 0.2, 0.4], 'the wait grows');
  assert.match(log, /about to fall over\n.*\[blackcat\] ended with code 1 after \d s/);
  // exit code 3: once, and no more
  await until('needy has been tried', () => svc('needy')?.state === 'needs you');
  await sleep(1500);
  assert.equal((logOf('needy').match(/\[blackcat\] started/g) ?? []).length, 1, 'not started again by itself');
  assert.match(logOf('needy'), /logged out: link the account again\n.*ended saying it needs you \(exit code 3\)/);
  assert.match(bc('status').stdout, /needy +● needs you +it needs you: see its log, put it right, then bc start needy/);
  // started by hand, it is tried once more
  bc('start', 'needy');
  await until('needy was tried again, and said the same', () => (logOf('needy').match(/ended saying it needs you/g) ?? []).length === 2);
  assert.equal((logOf('needy').match(/\[blackcat\] started/g) ?? []).length, 2);
  await until('it is left stopped again', () => svc('needy').state === 'needs you');
  // killed from outside: back, and counted
  const was = svc('steady').pid;
  process.kill(was, 'SIGKILL');
  await until('steady is back', () => svc('steady')?.state === 'running' && svc('steady').pid !== was);
  assert.equal(svc('steady').restarts, 1);
  assert.match(logOf('steady'), /was ended by SIGKILL/);
  // and what matters of it is on the activity record: that it started, one that ended by itself, one that needs the owner
  const d = JSON.parse(bc('activity', 'recent', '--kind', 'event', '-n', '100', '--json').stdout);
  const ev = (d.entries ?? d.events ?? d).map((e) => `${e.category ?? e.for}: ${e.summary}`);
  assert.ok(ev.includes('blackcat: started (by hand)') || ev.includes('blackcat: started (kept by container)'), ev.join('\n'));
  assert.ok(ev.some((e) => /^service: crashy: ended with code 1 after \d+ s; started again$/.test(e)));
  assert.ok(ev.includes('service: needy: stopped, and needs you (see its log)'));
  assert.ok(ev.some((e) => /^service: steady: was ended by SIGKILL after \d+ s; started again$/.test(e)));
  assert.ok(!ev.some((e) => /^service: later/.test(e)), 'one that only waits is not an event');
});

test('stop, start and restart; a stopped service stays stopped; one that will not stop is killed with what it started', async () => {
  const pid = svc('steady').pid;
  assert.match(bc('stop', 'steady').stdout, /○ steady stopped/);
  assert.equal(alive(pid), false);
  await sleep(1000);
  assert.deepEqual([svc('steady').state, svc('steady').why], ['stopped', 'stopped by you'], 'and is not started again behind your back');
  assert.match(bc('start', 'steady').stdout, /● steady started/);
  const second = svc('steady').pid;
  assert.ok(second && second !== pid && alive(second));
  assert.match(bc('restart', 'steady').stdout, /● steady restarted/);
  assert.ok(svc('steady').pid !== second && !alive(second));
  // the stubborn one, and the process it started
  await until('stubborn said what it started', () => /its own process is \d+/.test(logOf('stubborn')));
  const kid = Number(/its own process is (\d+)/.exec(logOf('stubborn'))[1]);
  const stubborn = svc('stubborn').pid;
  assert.ok(alive(kid) && alive(stubborn));
  assert.match(bc('stop', 'stubborn').stdout, /○ stubborn stopped/);
  assert.deepEqual([alive(stubborn), alive(kid)], [false, false]);
  assert.match(logOf('stubborn'), /asked to stop, and will not\n.*did not stop when asked: killed/);
  // asked to stop twice at the same moment: one stop, and nothing said or done afterwards
  bc('start', 'stubborn');
  await until('stubborn is up again', () => svc('stubborn')?.state === 'running');
  const two = await Promise.all([U.ask({ op: 'stop', id: 'stubborn' }), U.ask({ op: 'stop', id: 'stubborn' })]);
  assert.deepEqual(
    two.map((r) => r.ok),
    [true, true],
  );
  const kills = () => (logOf('stubborn').match(/did not stop when asked: killed/g) ?? []).length;
  const n = kills();
  await sleep(1500);
  assert.equal(kills(), n, 'no second kill is sent after it has gone');
  assert.match(bc('start', 'nonesuch').said, /Unknown service "nonesuch"\. Choose from: agent, steady, crashy, needy, stubborn, later/);
});

test('what becomes ready is started by itself; a service switched off stays off until it is put back', async () => {
  update((c) => {
    c.plugins.settings = { ...c.plugins.settings, svc: { go: true } };
  });
  await until('later runs once it is set up', () => svc('later')?.state === 'running');
  // and the record says how long it had to wait for what it needs
  const waited = JSON.parse(bc('activity', 'recent', '--category', 'service: later', '--json').stdout).entries;
  assert.equal(waited.length, 1, JSON.stringify(waited));
  assert.match(waited[0].summary, /^started after waiting \d+ s for what it needs$/);
  // switched off by name: stopped, and not started by a restart of everything
  assert.match(bc('service', 'uninstall', 'steady').said, /steady is stopped and stays stopped\. Put it back: bc service install steady/);
  assert.equal(svc('steady').state, 'stopped');
  assert.deepEqual(U.switchedOff(), ['agent', 'steady']);
  assert.match(bc('start', 'steady').said, /steady is switched off\. Put it back: bc service install steady/);
  await sleep(800);
  assert.equal(svc('steady').state, 'stopped');
  const back = bc('service', 'install', 'steady').said;
  assert.match(
    back,
    /steady is running/,
    `${back}\n${JSON.stringify(state())}\n${logOf('blackcat').slice(-1500)}\n${logOf('steady').slice(-600)}`,
  );
  assert.equal(svc('steady').state, 'running');
  assert.deepEqual(U.switchedOff(), ['agent']);
});

test('bc logs shows what each wrote; a second supervisor for the same installation is refused', async () => {
  await until('steady has said it is up since it was last started', () =>
    /started \(pid \d+\)\n[^\n]*steady is up as steady\n$/.test(logOf('steady')),
  );
  const one = bc('logs', 'steady', '-n', '3').stdout;
  assert.match(one, /steady is up as steady/);
  const all = bc('logs', '-n', '2').stdout;
  assert.match(all, /blackcat\.log/);
  assert.match(all, /crashy\.log/);
  const second = bc('service', 'run');
  assert.equal(second.status, 1);
  assert.match(second.said, new RegExp(`blackcat is already running here \\(pid ${sup.pid}\\)`));
  assert.equal(state().pid, sup.pid, 'and the first is untouched');
});

test('stopped, it stops everything it started and leaves nothing behind', async () => {
  const pids = Object.values(state().services)
    .map((s) => s.pid)
    .filter(Boolean);
  assert.ok(pids.length >= 2, JSON.stringify(state()));
  sup.kill('SIGTERM');
  assert.deepEqual(await sup.gone, { code: 0, signal: null });
  assert.deepEqual(pids.filter(alive), []);
  assert.deepEqual([fs.existsSync(U.STATE_FILE), fs.existsSync(U.SOCKET), state()], [false, false, null]);
  assert.match(out, /stopping\n.*stopped\n$/);
});

test('killed outright, what it left running is stopped by the next one before anything is started beside it', async () => {
  await startSupervisor();
  const left = svc('steady').pid;
  sup.kill('SIGKILL');
  await sup.gone;
  assert.equal(alive(left), true, 'its services outlive it: that is the case to deal with');
  await startSupervisor();
  assert.equal(alive(left), false);
  assert.match(out, new RegExp(`stopping pid ${left}, left running by a supervisor that ended without stopping it`));
  const running = spawnSync('pgrep', ['-f', 'bin/bc.js svc steady'], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
  // (steady, and "later", which runs the same command)
  assert.equal(
    running.length,
    2,
    `one of each, not two:\n${spawnSync('pgrep', ['-af', 'bin/bc.js svc steady'], { encoding: 'utf8' }).stdout}\n${JSON.stringify(state())}\n${out}`,
  );
  sup.kill('SIGTERM');
  await sup.gone;
});

test('a note left by a supervisor that was killed is not taken for one that is running, whoever has its number now', async () => {
  // As in a container that was removed and made again: the note names a process number that is
  // in use (here, this test's own), but it is not that supervisor.
  fs.mkdirSync(U.RUN_DIR, { recursive: true });
  const left = {
    pid: process.pid,
    born: '1',
    started: 1,
    home: dir,
    keeper: null,
    services: { steady: { state: 'running', pid: process.pid, born: '1' } },
  };
  fs.writeFileSync(U.STATE_FILE, JSON.stringify(left));
  assert.equal(state(), null, 'the number is alive, and it is somebody else');
  // (and a note that does not say when its process started is not believed either)
  fs.writeFileSync(U.STATE_FILE, JSON.stringify({ ...left, born: undefined }));
  assert.equal(state(), null);
  fs.writeFileSync(U.STATE_FILE, JSON.stringify(left));
  assert.match(bc('status').stdout, /blackcat +○ not running/);
  await startSupervisor();
  assert.equal(state().pid, sup.pid);
  assert.doesNotMatch(out, /already running/);
  assert.doesNotMatch(out, new RegExp(`stopping pid ${process.pid}`), 'and what has that number now is left alone');
  sup.kill('SIGTERM');
  await sup.gone;
  // The same from a note that names the new supervisor's own number (in a container the
  // first numbers are the same each time): it is made to find one by writing it once it
  // is known, with nothing to tell the two apart, as an earlier version left it.
  const { run } = await import('../src/service/supervisor.js');
  assert.equal(typeof run, 'function');
  const src = fs.readFileSync(new URL('../src/service/supervisor.js', import.meta.url), 'utf8');
  assert.match(src, /supervisorState\(\)\.pid !== process\.pid/, 'its own number in a note is never another supervisor');
});

test('started at boot by one unit, where there is systemd: written for this installation, and never over another one', async () => {
  const unit = path.join(dir, 'units/blackcat.service');
  assert.equal(state(), null, 'nothing is running for this installation');
  const r = bc('service', 'install');
  assert.ok(fs.existsSync(unit), r.said);
  const text = fs.readFileSync(unit, 'utf8');
  assert.match(text, new RegExp(`^ExecStart=\\S+node\\S* ${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}bin/bc\\.js service run$`, 'm'));
  assert.match(text, new RegExp(`^Environment=BLACKCAT_HOME=${dir}$`, 'm'));
  assert.match(text, /^Restart=always$/m);
  assert.match(r.said, /Wrote .*blackcat\.service/);
  assert.match(r.said, /Start at boot already enabled/);
  // (the stand-in systemctl starts nothing, so it is said that it did not come up)
  assert.match(r.said, /blackcat did not start/);
  // an installation somewhere else does not take it over
  const other = fs.mkdtempSync(path.join(dir, 'other-'));
  fs.mkdirSync(path.join(other, 'data'), { mode: 0o700 });
  const o = spawnSync(process.execPath, [`${root}bin/bc.js`, 'service', 'install'], {
    encoding: 'utf8',
    env: { ...env, BLACKCAT_HOME: other },
    input: '',
  });
  assert.match(o.stdout + o.stderr, new RegExp(`This account already runs the blackcat in ${dir} at boot`));
  assert.equal(fs.readFileSync(unit, 'utf8'), text);
});
