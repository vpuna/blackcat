// Shortcuts: commands the owner defines, a recipe of steps run with one word and no model.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { home } from './helpers.js';

const dir = home();
const data = path.join(dir, 'data');
const root = new URL('..', import.meta.url).pathname;
const { FORCE_COLOR: _f, BLACKCAT_CALLER: _c, ...env } = process.env;
const bc = (...a) => spawnSync(process.execPath, [`${root}bin/bc.js`, ...a], { encoding: 'utf8', env, timeout: 60_000 });
const json = (...a) => JSON.parse(bc(...a, '--json').stdout);
const { save, load } = await import('../src/config.js');
save({});
const saved = () => load().plugins?.settings?.shortcut?.shortcuts ?? {};
const mark = path.join(dir, 'ran.log');

test('a shortcut is made, tried at once, listed, run, and is a word of its own', () => {
  const r = bc('shortcut', 'add', 'hello', '--description', 'Says hello', '--run', `echo one >> ${mark}`, '--run', 'echo hello there');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Saved\./);
  assert.match(r.stdout, /Tested now: it works:\nhello there/);
  assert.match(r.stdout, /Use it: \/hello in the bot, or bc shortcut run hello/);
  assert.deepEqual(saved().hello, { description: 'Says hello', run: [`echo one >> ${mark}`, 'echo hello there'] });
  assert.equal(fs.readFileSync(mark, 'utf8'), 'one\n', 'trying it ran its steps, in order, once');
  assert.match(bc('shortcut', 'list').stdout, /\/hello: Says hello/);
  assert.deepEqual(json('shortcut', 'run', 'hello'), {
    notice: json('shortcut', 'run', 'hello').notice,
    output: 'hello there',
    files: [],
    caption: null,
  });
  assert.equal(bc('hello').stdout.trim(), 'hello there', '`bc hello` is `bc shortcut run hello`');
  assert.match(bc('--help').stdout, /hello .*Says hello .*your shortcut/);
});

test('steps stop at the first that fails, which is said; nothing after it runs', () => {
  const r = bc(
    'shortcut',
    'add',
    'brittle',
    '--run',
    'echo first',
    '--run',
    'sh -c "echo it broke >&2; exit 3"',
    '--run',
    `echo never >> ${mark}`,
  );
  assert.equal(r.status, 0, 'it is saved all the same: the owner is told it does not work');
  assert.match(r.stdout, /Tested now: it did NOT work|did not work|failed \(exit 3\)/i);
  const run = bc('shortcut', 'run', 'brittle');
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /failed \(exit 3\)/);
  assert.doesNotMatch(fs.readFileSync(mark, 'utf8'), /never/);
});

test('a file it fetches into its own folder is sent back; one outside the folders files may be sent from is refused', () => {
  const r = bc(
    'shortcut',
    'add',
    'chart',
    '--description',
    "Today's chart",
    '--run',
    'sh -c "echo png > {dir}/chart.png"',
    '--send',
    '{dir}/chart.png',
    '--caption',
    'Today',
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Tested now: it works \(chart\.png\)/);
  const out = json('shortcut', 'run', 'chart');
  assert.deepEqual([out.files, out.caption], [[path.join(data, 'shortcut-files/chart/chart.png')], 'Today']);
  assert.equal(fs.readFileSync(out.files[0], 'utf8'), 'png\n');
  fs.writeFileSync(path.join(dir, 'private.txt'), 'x');
  assert.match(
    bc('shortcut', 'add', 'leak', '--send', path.join(dir, 'private.txt')).stdout,
    /is outside the folders files may be sent from/,
  );
  assert.match(bc('shortcut', 'add', 'ghost', '--send', '{dir}/nothing.png').stdout, /There is no file at/);
});

test('what a shortcut may be called: its own short word, never one blackcat or the chat already uses, and it needs something to do', () => {
  for (const [name, why] of [
    ['Hello', /2 to 25 lowercase letters/],
    ['x', /2 to 25 lowercase letters/],
    ['status', /already a blackcat command/],
    ['watch', /already a blackcat command/],
    ['help', /already a blackcat command/],
    ['new', /already a blackcat command/],
  ]) {
    const r = bc('shortcut', 'add', name, '--run', 'true');
    assert.notEqual(r.status, 0, name);
    assert.match(r.stderr, why, name);
  }
  assert.match(bc('shortcut', 'add', 'empty').stderr, /needs something to do/);
  assert.match(bc('shortcut', 'add', 'odd', '--run', 'true', '--reply', 'loud').stderr, /--reply is output or none/);
  assert.match(bc('shortcut', 'run', 'nowhere').stderr, /There is no shortcut called "nowhere"/);
});

test('the agent may run one freely, and must ask before making, scheduling or removing one', async () => {
  const { loadPlugins } = await import('../src/plugins/registry.js');
  await loadPlugins();
  const { decide } = await import('../src/agent/policy.js');
  const act = (command) => decide('Bash', { command }).action;
  assert.equal(act('blackcat shortcut run hello --json'), 'allow');
  assert.equal(act('blackcat shortcut list --json'), 'allow');
  for (const c of [
    'blackcat shortcut add reboot --run "sudo reboot"',
    'blackcat shortcut schedule hello --at 08:00',
    'blackcat shortcut remove hello',
  ])
    assert.equal(act(c), 'ask', c);
  assert.match(decide('Bash', { command: 'blackcat shortcut add reboot --run "sudo reboot"' }).title, /create or change a shortcut/);
});

test('sent by itself: at times of day, on a cron schedule, once; and stopped', () => {
  assert.match(
    bc('shortcut', 'schedule', 'hello', '--at', '08:00', '--days', 'mon,fri').stdout,
    /\/hello will be sent to you at 08:00 on Mondays? and Fridays?\.|will be sent to you/,
  );
  assert.deepEqual(saved().hello.cron, ['0 8 * * 1,5']);
  assert.match(bc('shortcut', 'schedule', 'hello', '--in', '2h').stdout, /once, /);
  assert.equal(saved().hello.once.length, 1);
  assert.ok(Math.abs(saved().hello.once[0] - (Date.now() / 1000 + 7200)) < 120);
  assert.match(bc('shortcut', 'schedule', 'hello', '--cron', 'not a schedule').stderr, /./);
  assert.match(bc('shortcut', 'schedule', 'hello').stderr, /Say when/);
  assert.match(bc('shortcut', 'schedule', 'hello', '--off').stdout, /no longer sent by itself/);
  assert.deepEqual([saved().hello.cron, saved().hello.once], [undefined, undefined]);
});

test("when its time comes it is run and sent to the owner's chat, which the core hands it; one that fails says so there", async () => {
  const { loadPlugins, findLoaded, makeCtx } = await import('../src/plugins/registry.js');
  const now = Math.floor(Date.now() / 1000);
  save({
    ...load(),
    plugins: {
      ...load().plugins,
      settings: {
        ...load().plugins.settings,
        shortcut: {
          shortcuts: {
            ...saved(),
            hello: { ...saved().hello, once: [now - 30] },
            brittle: { ...saved().brittle, once: [now - 30] },
            chart: { ...saved().chart, once: [now - 5 * 3600] },
          },
        },
      },
    },
  });
  await loadPlugins();
  const p = findLoaded('shortcut');
  const sent = [];
  const ui = {
    send: async (chat, text) => void sent.push([chat, text]),
    sendFile: async (chat, file, o) => (sent.push([chat, `file ${path.basename(file)} ${o?.caption ?? ''}`]), true),
  };
  const running = [];
  const marks = new Map();
  await p.manifest.chat.tick(ui, {
    ctx: makeCtx(p, { caller: 'job', surface: 'chat' }),
    now,
    nowMs: now * 1000,
    last: (k) => marks.get(k) ?? 0,
    mark: (k, v) => marks.set(k, v),
    once: (n, fn) => running.push(fn()),
    chat: 4242,
  });
  await Promise.all(running);
  assert.deepEqual(
    sent.filter((s) => /hello/i.test(s[1])),
    [[4242, 'Says hello\nhello there']],
  );
  assert.ok(sent.some(([chat, text]) => chat === 4242 && /\/brittle, which you asked me to send by itself, did not work/.test(text)));
  assert.ok(!sent.some((s) => /chart/.test(s[1])), 'a time missed by hours (blackcat was off) is not sent late');
  for (const n of ['hello', 'brittle', 'chart']) assert.equal(saved()[n].once, undefined, `${n}: a one-off time is used up`);
  // with no channel in use there is nowhere to send one: nothing is run
  const before = fs.readFileSync(mark, 'utf8');
  await p.manifest.chat.tick(null, {
    ctx: makeCtx(p, { caller: 'job' }),
    now,
    nowMs: now * 1000,
    last: () => 0,
    mark() {},
    once: (n, fn) => fn(),
    chat: 0,
  });
  assert.equal(fs.readFileSync(mark, 'utf8'), before);
});

test('selftest looks each one over without running it: its steps are programs that are there', () => {
  const before = fs.readFileSync(mark, 'utf8');
  save({
    ...load(),
    plugins: {
      ...load().plugins,
      settings: {
        ...load().plugins.settings,
        shortcut: {
          shortcuts: {
            ...saved(),
            typo: { description: 'x', run: ['nosuchprogram-xyz --now'] },
            hollow: { description: 'x' },
            far: { description: 'x', run: ['blackcat status'] },
          },
        },
      },
    },
  });
  const out = JSON.parse(bc('selftest', 'shortcut', '--json').stdout);
  const by = Object.fromEntries(out.parts[0].results.map((r) => [r.name, r]));
  assert.deepEqual([by['/hello'].outcome, by['/hello'].detail], ['ok', '2 steps (looked over, not run)']);
  assert.match(by['/chart'].detail, /1 step, sends 1 file \(looked over, not run\)/);
  assert.deepEqual(
    [by['/typo'].outcome, by['/typo'].detail],
    ['failed', 'its step "nosuchprogram-xyz --now" starts with nosuchprogram-xyz, which is not a program on this machine'],
  );
  assert.match(by['/hollow'].detail, /it has nothing to do/);
  assert.equal(by['/far'].outcome, 'ok');
  assert.equal(fs.readFileSync(mark, 'utf8'), before, 'not one step was run');
});

test('removed: it is gone from the list, as a word of its own, and so are its files', () => {
  assert.equal(bc('shortcut', 'remove', 'chart').stdout.trim(), 'Removed /chart.');
  assert.equal(saved().chart, undefined);
  assert.equal(fs.existsSync(path.join(data, 'shortcut-files/chart')), false);
  assert.notEqual(bc('chart').status, 0);
  assert.match(bc('shortcut', 'remove', 'chart').stderr, /There is no shortcut called "chart"/);
});

// ---- actions: words after a shortcut's name, each with steps of its own

test("an action is a word after the name with steps of its own; the shortcut's own steps still run on the name alone", () => {
  const r = bc('shortcut', 'action', 'hello', 'loud', '--run', 'echo HELLO THERE', '--description', 'Says it loudly');
  assert.equal(r.status, 0, r.stderr);
  assert.match(
    r.stdout,
    /^Saved\.\n\/hello: Says hello\n {2}1\. run: echo one[\s\S]*\n {2}\/hello loud: Says it loudly\n {4}1\. run: echo HELLO THERE/,
  );
  assert.match(r.stdout, /Tested now: it works:\nHELLO THERE\nUse it: \/hello loud in the bot, or bc hello loud/);
  assert.deepEqual(saved().hello.actions, { loud: { run: ['echo HELLO THERE'], description: 'Says it loudly' } });
  assert.equal(json('shortcut', 'run', 'hello', 'loud').output, 'HELLO THERE');
  assert.equal(json('shortcut', 'run', 'hello').output, 'hello there', 'the name alone is as it was');
  assert.equal(bc('hello', 'loud').stdout.trim(), 'HELLO THERE', '`bc hello loud`');
  assert.equal(bc('hello').stdout.trim(), 'hello there');
  assert.match(bc('--help').stdout, /hello \[options\] \[action\] +Says hello \(loud\)/);
});

test('a word it does not have is refused, with what it does have; nothing is run', () => {
  const before = fs.readFileSync(mark, 'utf8');
  const r = bc('shortcut', 'run', 'hello', 'quietly');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /\/hello has no "quietly"\. It has: \/hello loud/);
  assert.match(bc('hello', 'quietly').stderr, /It has: \/hello loud/);
  assert.match(bc('shortcut', 'run', 'brittle', 'anything').stderr, /\/brittle takes nothing after its name\./);
  assert.equal(fs.readFileSync(mark, 'utf8'), before);
});

test('a shortcut made only of actions is a menu: the name alone shows what it has', () => {
  for (const [a, cmd] of [
    ['play', `echo play >> ${mark}; echo playing`],
    ['pause', 'echo paused'],
    ['stop', 'echo stopped'],
  ]) {
    const r = bc(
      'shortcut',
      'action',
      'waves',
      a,
      '--run',
      `sh -c '${cmd}'`,
      ...(a === 'play' ? ['--description', 'Rain in the bedroom'] : []),
      '--no-test',
    );
    assert.equal(r.status, 0, r.stderr);
  }
  assert.deepEqual(
    [saved().waves.description, Object.keys(saved().waves.actions), saved().waves.run],
    ['Rain in the bedroom', ['play', 'pause', 'stop'], undefined],
  );
  const alone = bc('shortcut', 'run', 'waves');
  assert.equal(alone.status, 0);
  assert.equal(alone.stdout.trim(), '/waves: Rain in the bedroom\nIt has: /waves play, /waves pause, /waves stop');
  assert.deepEqual(json('shortcut', 'run', 'waves').actions, ['play', 'pause', 'stop']);
  assert.equal(bc('waves').stdout.trim().split('\n')[1], 'It has: /waves play, /waves pause, /waves stop');
  assert.doesNotMatch(fs.readFileSync(mark, 'utf8'), /play/, 'showing the menu ran nothing');
  assert.equal(bc('waves', 'pause').stdout.trim(), 'paused');
  assert.match(bc('waves', 'louder').stderr, /\/waves has no "louder"\. It has: \/waves play, \/waves pause, \/waves stop/);
  assert.match(
    bc('shortcut', 'list').stdout,
    /\/waves: Rain in the bedroom\n {2}\(no steps of its own: it shows its actions\)\n {2}\/waves play\n {4}1\. run: /,
  );
  assert.match(
    bc('shortcut', 'schedule', 'waves', '--at', '21:00').stderr,
    /\/waves has no steps of its own to send by itself: it is a menu\. Name one of its actions: bc shortcut schedule waves play …, bc shortcut schedule waves pause …, bc shortcut schedule waves stop …/,
  );
});

test('one action is sent by itself, so that no shortcut has to be made for it; the rest of the shortcut is as it was', async () => {
  const before = saved().waves;
  const r = bc('shortcut', 'schedule', 'waves', 'play', '--at', '22:00', '--json');
  assert.equal(r.status, 0, r.stderr);
  const d = JSON.parse(r.stdout);
  assert.deepEqual([d.name, d.action, d.cron], ['waves', 'play', ['0 22 * * *']]);
  assert.match(d.schedule, /at 10:00 PM|at 22:00/i);
  assert.match(bc('shortcut', 'schedule', 'waves', 'play', '--in', '2h').stdout, /^\/waves play will be sent to you .*22:00.*; once, /i);
  const now = saved().waves;
  assert.deepEqual(now.actions.play.cron, ['0 22 * * *']);
  assert.equal(now.actions.play.once.length, 1);
  assert.deepEqual(now.actions.play.run, before.actions.play.run, 'its steps are untouched');
  assert.deepEqual(
    [now.actions.pause, now.actions.stop, now.cron],
    [before.actions.pause, before.actions.stop, undefined],
    'and so are the others',
  );
  // it is shown where the action is, and the agent is told
  assert.match(bc('shortcut', 'list').stdout, /\/waves play\n {4}1\. run: .*\n(.*\n)? {4}sent to you by itself: at 22:00/i);
  // an action given new steps keeps its times
  bc('shortcut', 'action', 'waves', 'play', '--run', 'echo rain again', '--no-test');
  assert.deepEqual([saved().waves.actions.play.run, saved().waves.actions.play.cron], [['echo rain again'], ['0 22 * * *']]);
  // an action that is not there is refused with what there is
  assert.match(
    bc('shortcut', 'schedule', 'waves', 'louder', '--at', '22:00').stderr,
    /\/waves has no action "louder"\. It has: \/waves play, \/waves pause, \/waves stop\./,
  );

  // when its time comes it is run and what it printed is sent, once
  const { loadPlugins, findLoaded, makeCtx } = await import('../src/plugins/registry.js');
  await loadPlugins();
  const plugin = findLoaded('shortcut');
  const ctx = makeCtx(plugin, { caller: 'owner', surface: 'job' });
  const sent = [];
  const ui = { send: async (chat, text) => void sent.push([chat, text]), sendFile: async () => true };
  const marks = new Map();
  const jobs = [];
  const tick = (atMs) =>
    plugin.manifest.chat.tick(ui, {
      ctx,
      now: Math.floor(atMs / 1000),
      nowMs: atMs,
      last: (k) => marks.get(k) ?? 0,
      mark: (k, v) => marks.set(k, v),
      once: (_name, fn) => void jobs.push(fn()),
      chat: 42,
    });
  const at = (h, m) => new Date(new Date().setHours(h, m, 0, 0)).getTime() + 86400000; // tomorrow
  await tick(at(21, 59)); // the first look only notes where it starts from
  await Promise.all(jobs);
  assert.deepEqual(sent, [], 'nothing before its time (and the one-off, two hours from now, is not due either)');
  await tick(at(22, 0) + 5000);
  await Promise.all(jobs);
  assert.equal(sent.length, 1, JSON.stringify(sent));
  assert.equal(sent[0][0], 42);
  assert.match(sent[0][1], /rain again/);
  await tick(at(22, 1));
  await Promise.all(jobs);
  assert.equal(sent.length, 1, 'once for that time');

  // and stopped: only this action's times go
  assert.match(bc('shortcut', 'schedule', 'waves', 'play', '--off').stdout, /^\/waves play is no longer sent by itself/);
  assert.deepEqual([saved().waves.actions.play.cron, saved().waves.actions.play.once], [undefined, undefined]);
  assert.deepEqual(saved().waves.actions.play.run, ['echo rain again']);
});

test("a shortcut's own steps are made an action in one step, leaving it a menu; when it is sent by itself goes with them", () => {
  bc('shortcut', 'add', 'lamp', '--description', 'The desk lamp', '--run', 'echo lamp on', '--no-test');
  bc('shortcut', 'schedule', 'lamp', '--at', '07:00');
  const r = bc('shortcut', 'action', 'lamp', 'on', '--main');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\/lamp is now a menu, and its steps are \/lamp on\./);
  const lamp = saved().lamp;
  assert.deepEqual(
    [lamp.actions.on.run, lamp.actions.on.cron, lamp.cron, lamp.since],
    [['echo lamp on'], ['0 7 * * *'], undefined, undefined],
  );
  bc('shortcut', 'schedule', 'lamp', 'on', '--off');
  assert.deepEqual(saved().lamp, { description: 'The desk lamp', actions: { on: { run: ['echo lamp on'] } } });
  assert.equal(bc('lamp', 'on').stdout.trim(), 'lamp on');
  assert.match(bc('shortcut', 'action', 'lamp', 'off', '--main').stderr, /has no steps of its own to make into an action/);
  assert.match(bc('shortcut', 'action', 'lamp', 'off', '--main', '--run', 'true').stderr, /give no --run or --send with it/);
});

test('what an action may be called and must have; replacing a shortcut keeps its actions; taking the last thing away is refused', () => {
  assert.match(bc('shortcut', 'action', 'lamp', 'Off', '--run', 'true').stderr, /An action is one word/);
  assert.match(bc('shortcut', 'action', 'lamp', 'off').stderr, /An action needs something to do/);
  assert.match(bc('shortcut', 'action', 'status', 'now', '--run', 'true').stderr, /already a blackcat command/);
  assert.match(bc('shortcut', 'action', 'lamp', 'never', '--remove').stderr, /\/lamp has no "never"\./);
  assert.match(
    bc('shortcut', 'action', 'lamp', 'on', '--remove').stderr,
    /That would leave \/lamp with nothing to do\. Remove the shortcut itself: bc shortcut remove lamp/,
  );
  // the shortcut made again with steps of its own: its actions stay
  assert.equal(bc('shortcut', 'add', 'hello', '--run', 'echo hi again', '--no-test').status, 0);
  assert.deepEqual(
    [saved().hello.description, saved().hello.run, Object.keys(saved().hello.actions)],
    ['Says hello', ['echo hi again'], ['loud']],
  );
  assert.match(bc('shortcut', 'action', 'hello', 'loud', '--remove').stdout, /^Removed \/hello loud\./);
  assert.equal(saved().hello.actions, undefined);
  assert.match(bc('shortcut', 'run', 'hello', 'loud').stderr, /takes nothing after its name/);
});

test('the agent must ask before giving a shortcut an action, and may run one freely', async () => {
  const { loadPlugins } = await import('../src/plugins/registry.js');
  await loadPlugins();
  const { decide } = await import('../src/agent/policy.js');
  const ask = decide('Bash', { command: "blackcat shortcut action waves louder --run 'sudo reboot' --json" });
  assert.deepEqual([ask.action, ask.root], ['ask', true]);
  assert.match(ask.title, /create or change a shortcut/);
  assert.equal(decide('Bash', { command: 'blackcat shortcut action waves stop --remove' }).action, 'ask');
  assert.equal(decide('Bash', { command: 'blackcat shortcut run waves pause --json' }).action, 'allow');
});

test('in the chat: /waves shows its actions as buttons, /waves pause runs it, a tap runs it, a word it has not is refused with the buttons', async () => {
  const { loadPlugins, findLoaded, makeCtx } = await import('../src/plugins/registry.js');
  await loadPlugins();
  const p = findLoaded('shortcut');
  const texts = [];
  const taps = [];
  await p.manifest.chat.install(
    { text: (fn) => texts.push(fn), action: (re, fn) => taps.push([re, fn]) },
    { ctx: makeCtx(p, { caller: 'owner', surface: 'chat' }) },
  );
  const say = async (text) => {
    const out = { replies: [], passed: false };
    await texts[0](
      {
        text,
        reply: async (t, o) => void out.replies.push([t, o?.actions ? JSON.stringify(o.actions) : null]),
        working() {},
        sendFile: async () => true,
      },
      () => {
        out.passed = true;
      },
    );
    return out;
  };
  const tap = async (id) => {
    const [re, fn] = taps.find(([r]) => r.test(id));
    const out = { replies: [], toasts: [] };
    await fn({
      match: re.exec(id),
      reply: async (t) => void out.replies.push(t),
      toast: async (t) => void out.toasts.push(t),
      gone: async (t) => void out.toasts.push(t),
      working() {},
      sendFile: async () => true,
    });
    return out;
  };
  const menu = await say('/waves');
  assert.equal(menu.replies.length, 1);
  assert.equal(menu.replies[0][0], '/waves: Rain in the bedroom\n/waves play · /waves pause · /waves stop');
  for (const a of ['play', 'pause', 'stop']) assert.match(menu.replies[0][1], new RegExp(`sc:waves:${a}`), `a button for ${a}`);
  assert.deepEqual((await say('/waves pause')).replies, [['paused', null]]);
  assert.deepEqual((await say('/waves@SomeBot   stop  ')).replies, [['stopped', null]]);
  const wrong = await say('/waves louder please');
  assert.match(wrong.replies[0][0], /^\/waves has no "louder please"\.\n\/waves: Rain in the bedroom\n/);
  assert.match(wrong.replies[0][1], /sc:waves:play/);
  assert.equal(wrong.passed, false, 'it is not handed to the agent to guess at');
  assert.deepEqual(await tap('sc:waves:pause'), { replies: ['paused'], toasts: ['/waves pause'] });
  assert.deepEqual((await tap('sc:waves:gone')).toasts, ['That is no longer there.']);
  // a shortcut with no actions is as it was: its name alone runs it, and anything after the name is a message for the agent
  assert.deepEqual((await say('/hello')).replies, [['hi again', null]]);
  assert.equal((await say('/hello what does this do?')).passed, true);
  assert.equal((await say('/nothing')).passed, true);
  // and the menu the channel shows names the actions
  assert.deepEqual(
    p.manifest.chat.commands(makeCtx(p)).find((c) => c.command === 'waves'),
    { command: 'waves', description: 'Rain in the bedroom (play, pause, stop)' },
  );
});

test('selftest looks over each action as well, and still runs nothing', () => {
  const before = fs.readFileSync(mark, 'utf8');
  const out = JSON.parse(bc('selftest', 'shortcut', '--json').stdout);
  const names = out.parts[0].results.map((r) => r.name);
  for (const n of ['/waves play', '/waves pause', '/waves stop', '/lamp on', '/hello']) assert.ok(names.includes(n), n);
  assert.ok(!names.includes('/waves'), 'a menu has no steps of its own to look over');
  assert.equal(fs.readFileSync(mark, 'utf8'), before);
});
