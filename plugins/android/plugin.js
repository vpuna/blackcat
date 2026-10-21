// Android devices (phones, tablets, TVs), on USB or the network, driven over adb: what is on a
// screen, and routines that go through an app the way a person would and stop before anything
// is booked, paid or sent, to ask the owner. Nothing here knows any app; what is particular to
// one is in its routines. Each device is paired under a name ("phone", "tv").
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as p from '@clack/prompts';
import { ago, COMMAND_MODES, commandAccess, dataPath, isoLocal, now, plural, prompts, recordActivity, sleep } from '../../src/api.js';
import { judge } from './adb.js';
import { ADDRESS, adbInstalled, connect, Device, devices, PACKAGE, pairWithCode, SERVER, serverFile, STOP_SERVER } from './device.js';
import {
  appProblems,
  commits,
  DEVICE_NAME,
  deleteDevice,
  dropServerKey,
  deleteRoutine,
  fingerprint,
  getDevice,
  lastRun,
  listApps,
  listDevices,
  listRoutines,
  loadApp,
  loadRoutine,
  NAME,
  recordRun,
  saveApp,
  saveDevice,
  saveRoutine,
  setApproved,
  setMode,
  stateOf,
  validate,
  withParams,
} from './routines.js';
import { judgeResult } from './after.js';
import { changes, planEdit, spliced } from './edit.js';
import { diagnose } from './recover.js';
import { Learner, PATTERNS, think } from './learn.js';
import { imageBlock, MAX_PICTURES, resultFromPicture, study, takePictures } from './pictures.js';
import { Runner, session, StepFailed, Stopped } from './runner.js';
import { elements, packageOf, parse, screenText, spoken, spokenAny } from './screen.js';

const MEDIA = dataPath('android-media');
const KEEP_PICTURES_S = 7 * 86400;
const kindOf = (d) => (d.tv ? 'TV' : 'phone');
const how = (d) => (d.address ? `on the network at ${d.address}` : 'on USB');

// The folder for pictures of screens, private, with those older than a week cleared away.
function media() {
  fs.mkdirSync(MEDIA, { recursive: true, mode: 0o700 });
  for (const f of fs.readdirSync(MEDIA)) {
    const file = path.join(MEDIA, f);
    if (Date.now() - fs.statSync(file).mtimeMs > KEEP_PICTURES_S * 1000) fs.rmSync(file, { force: true });
  }
  return MEDIA;
}

// The paired device a command is for: the one named, else the routine's, else the only one.
function chosen(ctx, on, routine) {
  const name = on ?? routine?.device ?? null;
  if (routine?.device && on && on !== routine.device) ctx.fail(`"${routine.name}" is for the ${routine.device}, not the ${on}.`);
  const all = listDevices(ctx);
  if (name) return getDevice(ctx, name) ?? ctx.fail(`No device is paired as "${name}". bc android devices lists them.`);
  if (!all.length) ctx.fail('No device is paired yet → bc android pair');
  if (all.length > 1) ctx.fail(`Which device? Add --on ${all.map((d) => d.name).join(' or --on ')}.`);
  return all[0];
}

// Reach a paired device, connecting to it first when it is on the network. → a Device, or a
// stop with what to do. (On the network, it is made sure the address still leads to it.)
async function reach(ctx, d) {
  const target = d.address ?? d.serial;
  let found = (await devices(ctx)).find((x) => x.serial === target);
  if (d.address && found?.state !== 'device') {
    try {
      await connect(ctx, d.address);
    } catch (e) {
      ctx.fail(
        `The ${d.name} (${d.label}) cannot be reached at ${d.address}: is it on, on this network, with its debugging on? (${e.message})`,
      );
    }
    found = (await devices(ctx)).find((x) => x.serial === target);
  }
  if (!found) ctx.fail(`The ${d.name} (${d.label}) is not connected: plug it in on USB, with USB debugging on.`);
  if (found.state === 'unauthorized')
    ctx.fail(`The ${d.name} has not allowed this machine: on it, accept "Allow USB debugging?" (tick "Always allow").`);
  if (found.state !== 'device')
    ctx.fail(`The ${d.name} is ${found.state}: ${d.address ? 'turn it off and on' : 'unplug it and plug it in again'}.`);
  const dev = new Device(ctx, target);
  if (d.address) {
    const serial = await dev.shell('getprop ro.serialno');
    if (serial && serial !== d.serial)
      ctx.fail(
        `Another device answers at ${d.address} now (its address changed?). Pair the ${d.name} again: bc android pair --name ${d.name}`,
      );
  }
  return dev;
}

// What the device shows for this machine's key ("RSA key fingerprint"), to compare when it asks.
function keyFingerprint() {
  try {
    const b64 = fs.readFileSync(path.join(os.homedir(), '.android', 'adbkey.pub'), 'utf8').split(/\s/)[0];
    return crypto.createHash('md5').update(Buffer.from(b64, 'base64')).digest('hex').match(/../g).join(':').toUpperCase();
  } catch {
    return null;
  }
}

// Wait for `test` to give something, checking every two seconds, up to `ms`.
async function until(test, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(2000)) {
    const v = await test();
    if (v) return v;
  }
  return null;
}

// ---------- pairing ----------

const stop = (msg) => {
  p.cancel(msg);
  process.exitCode = 1;
  return null;
};

// A device on USB that has been connected. → { serial } of the one chosen, or null.
async function onUsb(ctx, orExit) {
  const known = new Set(listDevices(ctx).map((d) => d.serial));
  const fresh = async () => (await devices(ctx)).filter((x) => !ADDRESS.test(x.serial));
  let list = await fresh();
  if (!list.length) {
    p.note(
      [
        'It needs Android 9 or later (11 or later is better). On the device:',
        '1. Settings → About phone (on some, then Software information): tap "Build number" seven times. Developer options are now on.',
        '2. Settings → Developer options: switch on "USB debugging".',
        '3. Connect it to this machine with a USB cable that carries data (not a charge-only cable).',
      ].join('\n'),
      'Getting it ready',
    );
    const s = p.spinner();
    s.start('Waiting for it (2 minutes)');
    list = (await until(async () => ((await fresh()).length ? fresh() : null), 120_000)) ?? [];
    s.stop(list.length ? 'It is connected.' : 'Nothing was found.');
    if (!list.length) return stop('Nothing was connected. Check the cable and that USB debugging is on, then run bc android pair again.');
  }
  if (list.length === 1) return list[0];
  const serial = orExit(
    await p.select({
      message: 'Which one?',
      options: list.map((x) => ({ value: x.serial, label: x.model ?? x.serial, hint: known.has(x.serial) ? 'paired already' : x.state })),
    }),
  );
  return list.find((x) => x.serial === serial);
}

// A device on the network (a TV, or a phone with wireless debugging). → { serial: its address }, or null.
async function onNetwork(ctx, orExit, given) {
  let address = given;
  if (!address) {
    p.note(
      [
        'On a TV: Settings → Device Preferences → About: select "Build" seven times. Then Developer options → switch on "Network debugging" or "Wireless debugging" (and "USB debugging" if it is there). Its address is shown there or under Network.',
        'On a phone with Android 11 or later: Developer options → "Wireless debugging". Its address and port are shown on that screen. (USB is steadier for a phone: the port changes when it restarts.)',
        'It must be on the same network as this machine.',
      ].join('\n'),
      'Getting it ready',
    );
    address = orExit(
      await p.text({
        message: 'Its address and port',
        placeholder: '192.168.1.40:5555',
        validate: (v) => (ADDRESS.test(v.trim()) ? undefined : 'An address and a port, like 192.168.1.40:5555'),
      }),
    ).trim();
  }
  try {
    p.log.info(await connect(ctx, address));
  } catch (e) {
    p.log.warn(e.message);
    // Android 11's wireless debugging allows a machine with a pairing code first.
    if (!orExit(await p.confirm({ message: 'Does it offer "Pair device with pairing code"?', initialValue: false })))
      return stop('Check the address, and that debugging on the network is on, then run bc android pair again.');
    const at = orExit(
      await p.text({
        message: 'The address and port shown beside the code (not the one above)',
        validate: (v) => (ADDRESS.test(v.trim()) ? undefined : 'An address and a port'),
      }),
    ).trim();
    const code = orExit(
      await p.text({ message: 'The six-digit code', validate: (v) => (/^\d{6}$/.test(v.trim()) ? undefined : 'Six digits') }),
    ).trim();
    try {
      await pairWithCode(ctx, at, code);
      p.log.success('Paired with the code.');
      p.log.info(await connect(ctx, address));
    } catch (e2) {
      return stop(e2.message);
    }
  }
  return (await devices(ctx)).find((x) => x.serial === address) ?? stop(`Nothing answers at ${address}.`);
}

async function pair(ctx, i) {
  const { orExit } = await prompts();
  p.intro('blackcat · pairing an Android device');
  const adb = await adbInstalled(ctx);
  if (!adb) return void stop('adb is needed, the program that talks to Android devices. Install it with: sudo apt install adb');
  p.log.info(`${adb}.`);
  if (i.name && !DEVICE_NAME.test(i.name))
    return void stop(`"${i.name}" is not a name for a device: lowercase letters, digits and dashes, like phone or tv.`);

  // 1. Connected, and allowing this machine.
  const network =
    i.address ??
    (orExit(
      await p.select({
        message: 'How is it connected?',
        options: [
          { value: 'usb', label: 'On USB', hint: 'a phone or tablet beside this machine' },
          { value: 'network', label: 'On the network', hint: 'a TV, or a phone with wireless debugging' },
        ],
      }),
    ) === 'network'
      ? ''
      : null);
  let d = network == null ? await onUsb(ctx, orExit) : await onNetwork(ctx, orExit, network || null);
  if (!d) return;
  if (d.state === 'unauthorized') {
    const fp = keyFingerprint();
    p.note(
      `On the device it asks "Allow USB debugging?" (unlock it first if it is a phone): tick "Always allow from this computer" and choose Allow.${fp ? `\nThe fingerprint it shows should be ${fp}.` : ''}`,
      'Allow this machine',
    );
    const s = p.spinner();
    s.start('Waiting for it to be allowed (2 minutes)');
    const target = d.serial;
    d = await until(async () => (await devices(ctx)).find((x) => x.serial === target && x.state === 'device'), 120_000);
    s.stop(d ? 'Allowed.' : 'It was not allowed.');
    if (!d) return void stop('If the question did not show, connect it again, then run bc android pair again.');
  }
  if (d.state !== 'device') return void stop(`It is ${d.state}. Connect it again, and run bc android pair again.`);
  const address = ADDRESS.test(d.serial) ? d.serial : null;
  const dev = new Device(ctx, d.serial);
  const about = await dev.about();
  if (about.sdk < 28) return void stop(`It has Android ${about.android}. Android 9 or later is needed.`);
  if (!about.serial && address)
    return void stop('It does not say its serial number, so it could not be told apart from another at the same address.');
  const serial = about.serial ?? d.serial;
  p.log.success(`${about.maker} ${about.model}, Android ${about.android}${about.tv ? ', a TV' : ''}.`);
  if (about.sdk < 30 && !about.tv) p.log.warn('Android 11 or later is better: older versions have more trouble with some apps.');

  // 2. Its name.
  const all = listDevices(ctx);
  const same = all.find((x) => x.serial === serial);
  const base = about.tv ? 'tv' : 'phone';
  const free = (n) => !all.some((x) => x.name === n && x.serial !== serial);
  const suggestion = same?.name ?? (free(base) ? base : [2, 3, 4, 5, 6, 7, 8, 9].map((k) => `${base}-${k}`).find(free));
  const name =
    i.name ??
    orExit(
      await p.text({
        message: 'What to call it (for --on, and in what blackcat says)',
        initialValue: suggestion,
        validate: (v) =>
          !DEVICE_NAME.test(v.trim())
            ? 'Lowercase letters, digits and dashes'
            : free(v.trim())
              ? undefined
              : 'Another device has that name',
      }),
    ).trim();
  if (!free(name))
    return void stop(`"${name}" is the name of another device. Unpair it first (bc android unpair ${name}), or choose another.`);

  // 3. What the owner should know before anything is put on it.
  const noLock = about.tv ? true : await dev.noLock();
  p.note(
    (about.tv
      ? [
          "blackcat starts apps on this TV and presses its remote's keys, as you would. It stays signed in to them.",
          'Most apps do not allow being driven like this, and could restrict an account that is. You use it at your own risk.',
          'Before anything that buys, books, pays or sends, a routine stops and asks you, with what the screen says.',
        ]
      : [
          'blackcat goes through apps on this device as you would, so it stays signed in to them and cannot have a PIN, pattern or password (a swipe is fine).',
          'Anyone who picks it up can use those apps: keep only the apps your routines need on it, and no banking or mail.',
          'Most apps do not allow being driven like this, and could restrict an account that is. You use it at your own risk.',
          'Before anything that books, pays or sends, a routine stops and asks you, with what the screen says.',
          noLock
            ? ''
            : '\nA screen lock is set on it. A swipe works; a PIN, pattern or password stops every routine (Settings → Lock screen → Screen lock type → None or Swipe).',
        ]
    )
      .filter(Boolean)
      .join('\n'),
    'Before you go on',
  );
  if (!orExit(await p.confirm({ message: `Pair it as "${name}"?` }))) return void p.cancel('Nothing was changed.');

  // 4. The server that reads and touches the screen.
  p.note(
    `To read the screen and touch it, blackcat puts uiautomator2's server on the device, at ${SERVER.onDevice}.\nIt is blackcat's build ${SERVER.version} (${(SERVER.bytes / 1e6).toFixed(1)} MB, MIT licence) of github.com/openatx/android-uiautomator-server-jar (built at github.com/vpuna/android-uiautomator-server-jar), which comes with blackcat, checked against its fingerprint before it is used. It answers only this machine, through adb, and only with a key blackcat gives it when it starts.\nIt is started when blackcat needs the screen and keeps running until the device restarts. bc android unpair ${name} removes it.`,
    'On the device',
  );
  if (!orExit(await p.confirm({ message: 'Put it on the device?' })))
    return void p.cancel('Without it nothing can be read on the device. Nothing was changed.');
  const s = p.spinner();
  s.start('Putting it on the device');
  const file = serverFile();
  await dev.putServer(file);
  s.message('Starting it');
  await dev.ensureServer({ file });
  const info = await dev.call('deviceInfo');
  s.stop(`It answers: the screen is ${info.displayWidth}×${info.displayHeight}.`);

  saveDevice(ctx, { name, serial, address, maker: about.maker, model: about.model, android: about.android, sdk: about.sdk, tv: about.tv });
  const bat = await dev.battery();
  if (bat.battery && !bat.charging)
    p.log.warn(
      `The battery is at ${bat.level}% and not charging. Keep it on a charger; turn on its battery protection (stop at 85%) if it has one.`,
    );
  p.outro(
    `Paired the ${about.maker} ${about.model} as "${name}"${same && same.name !== name ? ` (it was "${same.name}")` : ''}. Try: bc android screen${all.length > (same ? 1 : 0) ? ` --on ${name}` : ''}`,
  );
}

async function unpair(ctx, i) {
  if (!i.name && listDevices(ctx).length > 1)
    ctx.fail(
      `Which one? bc android unpair ${listDevices(ctx)
        .map((d) => d.name)
        .join(' | ')}`,
    );
  const d = chosen(ctx, i.name);
  const target = d.address ?? d.serial;
  const there = (await devices(ctx).catch(() => [])).find((x) => x.serial === target && x.state === 'device');
  if (there) {
    const dev = new Device(ctx, target);
    await dev.shell(`${STOP_SERVER}; rm -f ${SERVER.onDevice}; true`).catch(() => {});
    await dev.adb(['forward', '--remove-all']).catch(() => {});
  }
  if (d.address) await ctx.exec('adb', ['disconnect', d.address], { timeoutMs: 10_000 });
  dropServerKey(ctx, target);
  deleteDevice(ctx, d.name);
  return there
    ? `Unpaired the ${d.name} (${d.label}): the server was taken off it. It still allows this machine (Developer options → Revoke USB debugging authorisations to undo that).`
    : `Unpaired the ${d.name} (${d.label}). It was not connected, so the server is still on it (${SERVER.onDevice}).`;
}

async function listPaired(ctx) {
  const all = listDevices(ctx);
  if (!all.length) return { text: 'No device is paired yet → bc android pair', data: [] };
  const seen = await devices(ctx).catch(() => []);
  const rows = all.map((d) => {
    const x = seen.find((y) => y.serial === (d.address ?? d.serial));
    return {
      name: d.name,
      device: d.label,
      kind: kindOf(d),
      android: d.android,
      address: d.address,
      state:
        x?.state === 'device' ? 'connected' : (x?.state ?? (d.address ? 'not connected now (connected when needed)' : 'not connected')),
      mode: d.mode,
    };
  });
  return {
    text: rows
      .map(
        (r) =>
          `${r.name} · ${r.device}, a ${r.kind}, Android ${r.android} · ${r.address ? `at ${r.address}` : 'USB'} · ${r.state} · adb for the agent: ${r.mode}`,
      )
      .join('\n'),
    data: rows,
  };
}

async function screen(ctx, i) {
  const d = chosen(ctx, i.on);
  const dev = await reach(ctx, d);
  await dev.ensureServer();
  const awake = (await dev.wakefulness()) === 'Awake';
  const root = parse(await dev.dump());
  const els = elements(root);
  const app = packageOf(root);
  let picture = null;
  if (i.picture !== false && awake) picture = await dev.screenshot(path.join(media(), `${d.name}-${Date.now()}.jpg`));
  const head = awake
    ? `On the ${d.name}: ${app ?? 'nothing'} · ${plural(els.length, 'element', 'elements')}`
    : `The ${d.name}'s screen is off.`;
  return {
    text: [head, screenText(els)].filter(Boolean).join('\n'),
    data: { device: d.name, awake, app, elements: els, path: picture, caption: `The ${d.name}'s screen, ${isoLocal(now())}` },
  };
}

// One device, or (with none named) every one.
async function test(ctx, i) {
  const list = i.on ? [chosen(ctx, i.on)] : listDevices(ctx);
  if (!list.length) ctx.fail('No device is paired yet → bc android pair');
  const out = [];
  for (const d of list) {
    const problems = [];
    let line;
    try {
      const dev = await reach(ctx, d);
      const bat = await dev.battery();
      const server = (await dev.serverOnDevice()) ? ((await dev.serverAnswers()) ? 'running' : 'there, not running') : 'not on it';
      if (server === 'not on it') problems.push(`the server is not on it → bc android pair --name ${d.name}`);
      if (bat.battery && !bat.charging) problems.push(`the battery is at ${bat.level}% and not charging`);
      line = `${d.name}: ${d.label}, Android ${d.android}, ${how(d)}: connected and allowed. The server: ${server}.${bat.battery ? ` The battery: ${bat.level}%${bat.charging ? ', charging' : ''}.` : ''}`;
      out.push({ name: d.name, ok: !problems.length, server, battery: bat, problems, text: line });
    } catch (e) {
      out.push({ name: d.name, ok: false, problems: [e.message], text: `${d.name}: ${e.message}` });
    }
  }
  if (out.some((x) => !x.ok)) process.exitCode = 1;
  return {
    text: out.map((x) => [x.text, ...x.problems.filter((m) => !x.text.includes(m)).map((m) => `  ⚠️ ${m}`)].join('\n')).join('\n'),
    data: out.map(({ text, ...x }) => x),
  };
}

// ---------- adb ----------

const MAX_OUTPUT = 20_000;
const clip = (x) =>
  x.length > MAX_OUTPUT
    ? `${x.slice(0, MAX_OUTPUT / 2)}\n… (${x.length - MAX_OUTPUT} characters left out) …\n${x.slice(-MAX_OUTPUT / 2)}`
    : x;

// What the agent may run with adb on a device: decided by the command, and the device's mode.
function adbAccess(ctx, tokens) {
  const [name, ...args] = tokens;
  const d = name && getDevice(ctx, name);
  if (!d) return { level: 'never', reason: `no device is paired as "${name}". Run \`blackcat android devices\` to see them` };
  const j = judge(args);
  if (j.level) return { level: j.level, reason: j.reason };
  const where = `on the ${d.name} (${d.label})`;
  const a = commandAccess(d.mode, j.command ?? `adb ${args.join(' ')}`, { where, machine: `the ${d.name}`, kind: j.kind });
  return a.level === 'ask' ? { ...a, describe: `adb ${args.join(' ')} ${where}`, asks: `run adb ${args[0]} ${where}` } : a;
}

// A key that is itself about the screen being on: waking first would undo what it is for (the
// power key turns a sleeping device on, and an awake one off).
const POWER_KEYS = /\b(KEYCODE_)?(POWER|WAKEUP|SLEEP|SOFT_SLEEP)\b/;
const WOKEN_SETTLE_MS = 700; // for what was asleep to be ready to take a command

// Woken, if it was asleep (and a swipe lock dismissed). → whether it was asleep.
async function wokeFirst(dev) {
  if ((await dev.wakefulness()) === 'Awake' && !(await dev.keyguardShowing())) return false;
  await dev.wake();
  await sleep(WOKEN_SETTLE_MS);
  return true;
}

async function adbRun(ctx, { _: tokens }) {
  const [name, ...args] = tokens;
  if (!name || !args.length)
    ctx.fail("Usage: bc android adb <device> <adb command>, such as: bc android adb phone shell 'getprop ro.product.model'");
  const d = getDevice(ctx, name) ?? ctx.fail(`No device is paired as "${name}". bc android devices lists them.`);
  const j = judge(args);
  if (j.level === 'never') ctx.fail(`Not run: ${j.reason}.`);
  const dev = await reach(ctx, d);
  const argv = j.command != null ? ['shell', j.command] : args;
  // (A command that changes something on a device that is asleep is lost on it: an app opens
  // behind the lock screen, a link lands on its home screen. Woken first; one that only looks
  // wakes nothing, which matters for a TV box, whose waking turns the TV on.)
  const woke = j.command != null && j.kind === 'change' && !POWER_KEYS.test(j.command) ? await wokeFirst(dev) : false;
  const r = await ctx.exec('adb', ['-s', d.address ?? d.serial, ...argv], { timeoutMs: 60_000 });
  const out = clip(r.stdout);
  const err = clip(r.stderr);
  if (r.code) process.exitCode = 1;
  return {
    text: [
      out.trimEnd(),
      err.trim() ? `(stderr) ${err.trim()}` : null,
      r.timedOut ? '(stopped: it ran longer than a minute)' : r.code ? `(exit code ${r.code})` : null,
    ]
      .filter(Boolean)
      // (Nothing at all when it worked and printed nothing, as adb itself: a shortcut that
      // runs it then says it is done, not "(nothing printed)".)
      .join('\n'),
    data: { device: d.name, command: `adb ${argv.join(' ')}`, exitCode: r.code, timedOut: !!r.timedOut, stdout: out, stderr: err, woke },
  };
}

function mode(ctx, i) {
  const d = getDevice(ctx, i.name) ?? ctx.fail(`No device is paired as "${i.name}".`);
  if (!COMMAND_MODES[i.mode]) ctx.fail(`The mode is one of: ${Object.keys(COMMAND_MODES).join(', ')}`);
  setMode(ctx, d.name, i.mode);
  return `The ${d.name} is now "${i.mode}" for the agent's adb commands: ${COMMAND_MODES[i.mode]}.`;
}

// ---------- routines ----------

// One run at a time on a device: there is one screen. A run that died is not waited for.
function take(ctx, d, what) {
  const key = `running:${d.name}`;
  const mine = { pid: process.pid, what, at: now() };
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const held = ctx.store.update(key, (cur) => (cur && cur.pid !== process.pid && alive(cur.pid) && now() - cur.at < 1800 ? cur : mine));
  if (held.pid !== process.pid) ctx.fail(`The ${d.name} is busy: ${held.what}, since ${ago(held.at)}. Try again when it has finished.`);
  return () => ctx.store.update(key, (cur) => (cur?.pid === process.pid ? undefined : cur));
}

const sets = (list) =>
  Object.fromEntries(
    (list ?? []).map((kv) => {
      const at = kv.indexOf('=');
      if (at < 1) throw new Error(`--set takes name=value, not "${kv}"`);
      return [
        kv.slice(0, at).trim(),
        kv
          .slice(at + 1)
          .trim()
          .replace(/^"(.*)"$/, '$1'),
      ];
    }),
  );

function routines(ctx) {
  const rows = listRoutines(ctx).map((name) => {
    try {
      const r = loadRoutine(ctx, name);
      const last = lastRun(ctx, name);
      return {
        name,
        app: r.app,
        device: r.device ?? null,
        goal: r.goal ?? null,
        params: Object.entries(r.params ?? {}).map(([k, v]) => (v.optional ? `${k} (optional)` : k)),
        state: stateOf(ctx, name, r),
        last: last && { at: last.ts, outcome: last.outcome, step: last.step, device: last.device },
      };
    } catch (e) {
      return { name, state: 'has mistakes', problem: e.message };
    }
  });
  const apps = listApps(ctx).map(
    (a) =>
      `${a.label ?? a.package} (${a.package}): ${plural(a.popups.length, 'pop-up', 'pop-ups')} cleared, ${a.commit.length ? `asks before ${a.commit.map((c) => `"${c}"`).join(', ')}` : 'nothing it books, pays or sends'}`,
  );
  if (!rows.length) return { text: ['No routines yet. bc android add <file> adds one.', ...apps].join('\n'), data: [] };
  return {
    text: [
      ...rows.map(
        (r) =>
          `${r.name} · ${r.state}${r.app ? ` · ${r.app}` : ''}${r.device ? ` on the ${r.device}` : ''}${r.params?.length ? ` · takes ${r.params.join(', ')}` : ''}${r.last ? ` · last run ${ago(r.last.at)}: ${r.last.outcome}` : ''}${r.goal ? `\n   ${r.goal}` : ''}${r.problem ? `\n   ${r.problem}` : ''}`,
      ),
      ...(apps.length ? ['', 'Apps:', ...apps.map((x) => `  ${x}`)] : []),
    ].join('\n'),
    data: rows,
  };
}

// One routine, or what is kept for an app (by its package), whole: --json gives what `add`
// takes back after it is edited.
function show(ctx, i) {
  if (/\./.test(i.name)) {
    const a = loadApp(ctx, i.name);
    return { text: JSON.stringify(a, null, 2), data: a };
  }
  const r = loadRoutine(ctx, i.name);
  return { text: `${r.name} · ${stateOf(ctx, r.name, r)}\n${JSON.stringify(r, null, 2)}`, data: r };
}

// A routine, or an app's pop-ups and buttons, from a file: checked, then saved. A routine
// saved is a draft, until it is tried and approved again.
function add(ctx, i) {
  let x;
  try {
    x = JSON.parse(fs.readFileSync(i.file, 'utf8'));
  } catch (e) {
    ctx.fail(`${i.file} cannot be read as JSON: ${e.message}`);
  }
  if (x && x.package && !x.steps) {
    const problems = appProblems(x);
    if (problems.length) ctx.fail(`Not saved. It has mistakes:\n- ${problems.join('\n- ')}`);
    saveApp(ctx, x);
    return `Saved what is kept for ${x.package}. Routines for it use it from their next run.`;
  }
  const problems = validate(x, loadApp(ctx, x?.app));
  if (problems.length) ctx.fail(`Not added. The routine has mistakes:\n- ${problems.join('\n- ')}`);
  const replaced = saveRoutine(ctx, x);
  const unknown = x.device && !getDevice(ctx, x.device) ? `\nNo device is paired as "${x.device}" yet.` : '';
  // (A change only to what is looked at after the press keeps it approved.)
  if (replaced && stateOf(ctx, x.name, x) === 'approved')
    return `Replaced "${x.name}". The change only looks, so it stays approved.${unknown}`;
  return `${replaced ? 'Replaced' : 'Added'} "${x.name}", as a draft. Try it: bc android run ${x.name} --dry, then bc android approve ${x.name}.${unknown}`;
}

function remove(ctx, i) {
  if (!deleteRoutine(ctx, i.name)) ctx.fail(`There is no routine called "${i.name}".`);
  return `Removed "${i.name}". Its past runs are kept in the activity record.`;
}

function approve(ctx, i) {
  const r = loadRoutine(ctx, i.name);
  const last = lastRun(ctx, i.name);
  // (One with no confirmation books nothing: a dry run of it goes to its end.)
  const confirms = r.steps.some((s) => s.do === 'confirm');
  const tried = confirms ? ['cancelled', 'expired', 'declined', 'unasked'] : ['finished'];
  if (!last || last.fingerprint !== fingerprint(r) || !tried.includes(last.outcome))
    ctx.fail(`Run it ${confirms ? 'to its confirmation screen' : 'to its end'} first, as it is now: bc android run ${i.name} --dry`);
  setApproved(ctx, i.name, r);
  const button = r.steps.at(-1).do === 'confirm' ? r.steps.at(-1).button : null;
  return `"${i.name}" is approved. The agent may run it${button ? `; it still asks you before it presses ${spoken(button)}` : ''}.`;
}

// Run a routine to its end, or to its confirmation screen and the owner's answer there.
async function run(ctx, i) {
  const base = loadRoutine(ctx, i.name);
  const r = withParams(base, sets(i.set));
  const app = loadApp(ctx, r.app);
  const d = chosen(ctx, i.on, r);
  const dry = !!i.dry;
  const dev = await reach(ctx, d);
  const free = take(ctx, d, `the routine "${r.name}"`);
  media();
  const log = (m) => {
    if (process.stderr.isTTY && !i.json) console.error(`  ${m}`);
  };
  const confirm = r.steps.at(-1);
  let unasked = null;
  // At the confirmation screen: the owner is asked, with what was read and a picture, and only
  // their answer presses the button. (Where they are: this terminal, or the channel in use.)
  const answer = async ({ values, shot, seconds }) => {
    if (dry) return 'declined';
    const facts = Object.entries(values).map(([k, v]) => `${k}: ${v ?? '(not found)'}`);
    const a = await ctx.askOwner({
      text: [
        `"${r.name}" is at its confirmation screen on the ${d.name}, ${seconds}s after it started.`,
        ...facts,
        `Press ${spoken(confirm.button)}?`,
      ].join('\n'),
      picture: shot,
      choices: ['✅ Press it', '✖ Cancel'],
      expiresIn: confirm.expires ?? 120,
    });
    if (a.how === 'unasked') unasked = a.why;
    return a.answer === '✅ Press it' ? 'confirm' : a.how === 'expired' ? 'timeout' : 'cancel';
  };
  let result;
  // The owner, when not at this terminal, follows it in one message, step by step, in each
  // step's own words (its `why`).
  const follow = atTerminal() ? null : await following(ctx, r, d, dry);
  // (A step that fails is looked at by a model, which may get past what is in the way: recover.js.)
  const runner = new Runner(dev, r, app, {
    answer: async (x) => {
      await follow?.at(dry ? 'at the confirmation screen' : 'at the confirmation screen: asking you');
      return answer(x);
    },
    log,
    media: MEDIA,
    recover: async (x) => (follow?.note(`step ${x.n} had trouble: looking at the screen`), diagnose(ctx, x)),
    onStep: (x) => follow?.start(x),
    onDone: (x) => follow?.end(x),
    // (A routine that does not yet say which screen comes last after the press: a model looks.)
    judge: confirm?.result?.shows ? null : (x) => judgeResult(ctx, { routine: r, button: spoken(confirm.button), imageBlock, ...x }),
    onWait: (secs) => follow?.waiting(`pressed: waiting for ${app.label ?? 'the app'} to finish${secs ? ` (${secs}s)` : ''}`),
  });
  try {
    result = await session(dev, r, () => runner.run(), { log, tv: d.tv });
  } catch (e) {
    if (e instanceof Stopped) result = { outcome: 'stopped', error: e.message, step: e.step, steps: runner.steps };
    else if (!(e instanceof StepFailed)) throw e;
    else result = { outcome: 'failed', error: e.message, step: e.step, shot: e.shot, steps: runner.steps };
  } finally {
    free();
  }
  if (result.outcome === 'cancelled' && dry) result.outcome = 'declined';
  if (result.outcome === 'cancelled' && unasked) result.outcome = 'unasked';
  await follow?.finish(
    {
      declined: '✓ Reached the confirmation screen (a dry run: nothing pressed)',
      confirmed: '✓ Pressed, on your word',
      cancelled: '✖ Cancelled: nothing pressed',
      expired: '⌛ No answer: nothing pressed',
      unasked: '✖ You could not be asked: nothing pressed',
      finished: '✓ Done',
      stopped: `■ Stopped: ${result.error}`,
      failed: `✖ Stopped at step ${result.step}`,
    }[result.outcome] ?? result.outcome,
  );
  // (`picture: false`: no picture of the screen after the press either.)
  const after = result.after ? { ...result.after, ...(base.picture === false ? { shot: null } : {}) } : null;
  if (after) await follow?.waited(`✓ ${app.label ?? 'The app'} after the press: ${after.seconds}s`);
  const afterLines = after ? await tellAfter(ctx, { base, d, confirm, after, send: !atTerminal() }) : [];
  const trouble = runner.recoveries;
  recordRun(ctx, base, { ...result, dry, device: d.name, recoveries: trouble });
  recordActivity({
    kind: 'event',
    category: 'android',
    summary: `routine ${r.name} on the ${d.name}: ${result.outcome}${result.step ? ` at step ${result.step}` : ''}`,
    ok: result.outcome !== 'failed',
  });
  const said = {
    declined: `Reached the confirmation screen in ${result.seconds}s and declined, as asked (--dry). Nothing was pressed.`,
    cancelled: 'Cancelled at the confirmation screen. Nothing was pressed.',
    unasked: `At the confirmation screen, but you could not be asked (${unasked}). Nothing was pressed.`,
    expired: 'No answer in time at the confirmation screen. Nothing was pressed.',
    confirmed: `Pressed, on your word, ${result.seconds}s after the start.`,
    finished: `Done in ${result.seconds}s.${result.shot ? `\nThe screen at the end: ${result.shot}` : ''}`,
    failed: `${result.error}\nThe screen when it stopped: ${result.shot ?? '(no picture)'}`,
    stopped: `Stopped at step ${result.step}, as the routine says: ${result.error}. Nothing was pressed.`,
  }[result.outcome];
  if (result.outcome === 'failed') process.exitCode = 1;
  const values = result.values ? Object.entries(result.values).map(([k, v]) => `${k}: ${v ?? '(not found)'}`) : [];
  const got = trouble.map(
    (t) =>
      `${t.did ? `Got past something at step ${t.n}` : `At step ${t.n}`}: ${t.summary}${t.did ? ` (${t.did})` : t.refused && t.refused !== 'nothing to do' ? ` (${t.refused})` : ''}`,
  );
  // (Run as a step of a shortcut that shows its own steps: the picture is handed to it, to go
  // after its last step rather than before.)
  const handOn = process.env.BLACKCAT_PROGRESS === 'off';
  if (result.outcome === 'finished' && result.shot && !atTerminal() && !handOn)
    await ctx.notify(`${runTitle() ?? `${r.name} on the ${d.name}`} · ${whenTaken()}`, { picture: result.shot });
  await tellAndKeep(ctx, { r, base, app, d, result, trouble, said });
  return {
    text: [
      said,
      ...got,
      ...values,
      ...afterLines,
      ...(handOn && result.outcome === 'finished' && result.shot ? [`[[send: ${result.shot}]]`] : []),
    ].join('\n'),
    data: {
      routine: r.name,
      device: d.name,
      outcome: result.outcome,
      values: result.values ?? null,
      seconds: result.seconds ?? null,
      step: result.step ?? null,
      path: result.shot ?? null,
      steps: result.steps,
      recoveries: trouble.map(({ shot, ...t }) => ({ ...t, path: shot })),
      after: after && { values: after.values, words: after.words, seconds: after.seconds, shown: after.shown, path: after.shot },
    },
  };
}

// After the press: the owner is sent the app's last screen and what was read on it (`send`;
// at this terminal it is printed). When a model found which screen that is, for a routine that
// did not say, they are asked whether to keep it. → the lines for the command's own answer.
async function tellAfter(ctx, { base, d, confirm, after, send }) {
  const button = spoken(confirm.button);
  // (A value only some of its screens have, such as when the driver arrives, is left out when not there.)
  const facts = Object.entries(after.values).flatMap(([k, v]) => (v == null ? [] : [`${k}: ${v}`]));
  const lines = [
    !after.changed ? `The screen did not change after the press: ${button} may not have worked. Look at the app.` : null,
    after.shown === false ? `${spokenAny(confirm.result.shows)} did not show in ${after.seconds}s; this is the screen then.` : null,
    after.judged?.summary ?? null,
    ...(facts.length ? facts : after.words),
  ].filter(Boolean);
  if (send)
    await ctx.notify([`🤖 ${base.name} on the ${d.name}, ${after.seconds}s after ${button}:`, ...lines].join('\n'), {
      picture: after.shot ?? undefined,
    });
  const keep = after.judged?.final ? after.judged.result : null;
  if (keep) {
    const what = [`wait for ${spokenAny(keep.shows)}`, keep.read ? `read ${Object.keys(keep.read).join(', ')}` : null]
      .filter(Boolean)
      .join(', and ');
    const a = await ctx.askOwner({
      text: `Keep this as the screen after ${button} in "${base.name}", for next time: ${what}? It only looks, so the routine stays approved.`,
      picture: after.shot ?? undefined,
      choices: ['✅ Keep it', '✖ No'],
      expiresIn: 180,
    });
    if (a.answer === '✅ Keep it') saveRoutine(ctx, withResult(base, keep));
  }
  return [`After the press (${after.seconds}s):`, ...lines.map((l) => `  ${l}`), ...(after.shot ? [`  The screen: ${after.shot}`] : [])];
}

// The routine with its confirmation step's `result` (the screen after the press) as given.
function withResult(routine, result) {
  const copy = structuredClone(routine);
  const last = copy.steps.at(-1);
  if (last?.do !== 'confirm') return copy;
  // (How long to wait, and a screen named as one it shows while still working, stay unless given again.)
  const kept = Object.fromEntries(['wait', 'waiting'].filter((k) => last.result?.[k]).map((k) => [k, last.result[k]]));
  last.result = { ...kept, ...result };
  return copy;
}

// The owner at this terminal sees it all as the run prints it; anywhere else they are sent the
// picture and what was found when a run had trouble, so they need not ask what happened.
// What a shortcut that started this run is for (its description), if one did.
const runTitle = () => process.env.BLACKCAT_TITLE?.trim() || null;
const whenTaken = () => new Date().toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const atTerminal = () => !!process.stdout.isTTY && process.env.BLACKCAT_CALLER !== 'agent' && !process.env.BLACKCAT_CHAT_ID;

// The message the owner follows a run in: what it is for, then each step in its own words,
// ticked as it is done. Long routines show their last steps.
async function following(ctx, r, d, dry) {
  // (Started by a shortcut: by what the shortcut is for, in the owner's words. Else by its name
  // and the values given.)
  const title = runTitle();
  const head = [
    `🤖 ${title ?? `${r.name} on the ${d.name}`}${dry ? ' (a dry run)' : ''}`,
    title
      ? ''
      : Object.entries(r.values ?? {})
          .filter(([, v]) => v != null && v !== '')
          .map(([k, v]) => `${k}: ${v}`)
          .join(' · '),
  ].filter(Boolean);
  const p = await ctx.progress([...head, '⏳ starting the app'].join('\n'));
  if (!p) return null;
  let wait = null;
  const lines = [];
  const say = (s) =>
    s.why ?? `${s.do.replace('_', ' ')}${s.target ? ` ${spoken(s.target)}` : s.text ? ` "${s.text}"` : s.number ? ` ${s.number}` : ''}`;
  const show = () => [...head, ...lines.slice(-10)].join('\n');
  const set = (n, text) => {
    const at = lines.findIndex((l) => l.startsWith(`${n}·`) || l.includes(` ${n}. `));
    const line = `${text}`;
    if (at >= 0) lines[at] = line;
    else lines.push(line);
  };
  return {
    start: ({ n, step }) => {
      if (step.do === 'confirm') return;
      set(n, `⏳ ${n}. ${say(step)}`);
      p.update(show());
    },
    end: ({ n, step, text }) => {
      if (step.do === 'confirm') return;
      const skipped = /did not show: skipped|is there already: not needed/.test(text);
      set(n, `${skipped ? '–' : '✓'} ${n}. ${say(step)}${skipped ? ' (not needed)' : ''}`);
      p.update(show());
    },
    note: (text) => {
      lines.push(`⚠️ ${text}`);
      p.update(show());
    },
    at: async (text) => {
      lines.push(`⏳ ${text}`);
      await p.done(show());
    },
    // (A message of its own: the one above was finished when the owner was asked.)
    waiting: async (text) => {
      wait ??= await ctx.progress(`⏳ ${text}`);
      wait?.update(`⏳ ${text}`);
    },
    waited: async (text) => wait?.done(text),
    finish: async (text) => {
      if (lines.at(-1)?.startsWith('⏳ at the confirmation screen')) lines.pop();
      lines.push(text);
      await p.done(show());
    },
  };
}

// After a run that had trouble: the owner is told, with the picture, and asked whether to keep
// each fix the model found for next time. A pop-up goes into the app's file (the routine stays
// approved); a step that names something else now makes the routine a draft again.
export async function tellAndKeep(ctx, { r, base, app, d, result, trouble, said }) {
  const failed = result.outcome === 'failed';
  // Each piece of trouble is on the activity record, whatever is sent: asked later what went
  // wrong on a run, the agent finds it there.
  for (const t of trouble)
    recordActivity({
      kind: 'event',
      category: 'android',
      ok: !!t.did,
      summary: `routine ${r.name} on the ${d.name}, step ${t.n}: ${t.summary}${t.did ? ` It ${t.did} and went on.` : t.refused ? ` Nothing done (${t.refused}).` : ''}`,
    });
  // Sent only when it matters to the owner: the run failed, or there is a fix to keep or not.
  // Trouble that was got past with nothing to decide is in the record, and in the steps' list.
  if (!atTerminal() && (failed || trouble.some((t) => t.fix))) {
    const last = trouble.at(-1);
    const what = [
      `🤖 "${r.name}" on the ${d.name}: ${failed ? `stopped at step ${result.step}.` : 'had trouble on the way, and got past it.'}`,
      ...trouble.map((t) => `Step ${t.n}: ${t.summary}${t.did ? ` I ${t.did} and went on.` : ''}`),
      failed && !trouble.length ? result.error : null,
      failed ? '' : null,
      failed ? said.split('\n')[0] : null,
    ]
      .filter((x) => x != null)
      .join('\n');
    await ctx.notify(what, { picture: result.shot ?? last?.shot });
  }
  for (const t of trouble) {
    if (!t.fix) continue;
    const question =
      t.fix.kind === 'popup'
        ? `Keep this for ${app.label ?? app.package}, for next time: ${t.fix.said}?`
        : `Change step ${t.n} of "${r.name}": ${t.fix.said}? It becomes a draft again, to be tried (--dry) and approved.`;
    const a = await ctx.askOwner({ text: question, picture: t.shot ?? undefined, choices: ['✅ Keep it', '✖ No'], expiresIn: 180 });
    if (a.answer !== '✅ Keep it') continue;
    if (t.fix.kind === 'popup') {
      const now = loadApp(ctx, app.package);
      saveApp(ctx, { ...now, popups: [...now.popups, t.fix.popup] });
    } else {
      const edited = withTarget(base, t.n, t.fix.target);
      if (edited) saveRoutine(ctx, edited);
    }
  }
}

// The routine with step `n` ("3", "6.1") looking for `target` instead. → null for a step it cannot reach.
function withTarget(routine, n, target) {
  const copy = structuredClone(routine);
  let steps = copy.steps;
  const path = String(n).split('.').map(Number);
  for (const [k, i] of path.entries()) {
    const s = steps?.[i - 1];
    if (!s) return null;
    if (k === path.length - 1) {
      if (!('target' in s)) return null;
      s.target = target;
      return copy;
    }
    steps = s.then;
  }
  return null;
}

// For a shortcut or a check: succeed only once the device is as said (an app in front, the
// screen on or off), looking again each second for up to `--wait` seconds.
const MAX_WAIT_S = 120;
async function check(ctx, i) {
  const d = chosen(ctx, i.on);
  const screen = i.screen == null ? null : String(i.screen).toLowerCase();
  if (screen != null && screen !== 'on' && screen !== 'off') ctx.fail('--screen is on or off.');
  if (!i.app && screen == null) ctx.fail('Say what to check: --app <app> (a word of its package), --screen on|off.');
  const wait = i.wait == null ? 0 : Number(i.wait);
  if (!Number.isInteger(wait) || wait < 0 || wait > MAX_WAIT_S) ctx.fail(`--wait is a whole number of seconds, 0 to ${MAX_WAIT_S}.`);
  const dev = await reach(ctx, d);
  const pkg = i.app ? await appPackage(ctx, dev, i.app) : null;
  const t0 = Date.now();
  for (;;) {
    const awake = (await dev.wakefulness()) === 'Awake';
    const front = pkg ? await dev.foreground() : null;
    const wrong = [
      screen && (screen === 'on') !== awake ? `its screen is ${awake ? 'on' : 'off'}` : null,
      pkg && front !== pkg ? `${front ?? 'nothing'} is in front, not ${pkg}` : null,
    ].filter(Boolean);
    const took = Math.round((Date.now() - t0) / 1000);
    if (!wrong.length)
      return {
        text: `The ${d.name}: ${[screen ? `its screen is ${screen}` : null, pkg ? `${pkg} is in front` : null].filter(Boolean).join(', ')}${took ? ` (after ${took}s)` : ''}.`,
        data: { device: d.name, ok: true, awake, front, seconds: took },
      };
    if (Date.now() - t0 >= wait * 1000) return ctx.fail(`The ${d.name}: ${wrong.join(', ')}${wait ? `, after ${took}s` : ''}.`);
    await sleep(1000);
  }
}

// ---------- learning ----------

// The app a word names: its package, or the one installed package that has the word in it.
async function appPackage(ctx, dev, word) {
  if (!word) ctx.fail('Say which app: --app and a word of its name, or its package (com.example.app).');
  if (PACKAGE.test(word) && (await dev.installed(word))) return word;
  const all = (await dev.shell('pm list packages')).split('\n').map((l) => l.replace(/^package:/, '').trim());
  const found = all.filter((p) => p.toLowerCase().includes(String(word).toLowerCase()));
  if (found.length === 1) return found[0];
  if (!found.length)
    ctx.fail(`No app on the device has "${word}" in its name. Its package names: bc android adb <device> shell 'pm list packages -3'`);
  return ctx.fail(`Several apps have "${word}" in their names: ${found.slice(0, 8).join(', ')}. Give its package with --app.`);
}

// The owner's pictures of the app (--picture), looked at once by a model. → what they show
// ({ notes, after_confirm }), or null when none were given.
async function looked(ctx, files, { goal, app, routine = null, log }) {
  if (!files?.length) return null;
  let pictures;
  try {
    pictures = await takePictures(files, MEDIA);
  } catch (e) {
    ctx.fail(e.message);
  }
  const seen = await study(ctx, { pictures, goal, app, routine });
  if (seen) log(`the pictures: ${seen.notes}`);
  return seen;
}

// Learn a routine from words, try it again by itself, and ask the owner to approve it.
async function learnCmd(ctx, i) {
  if (!NAME.test(i.name ?? '')) ctx.fail('A routine is named in lowercase letters, digits and dashes: bc android learn amazon-buy …');
  if (!i.goal?.trim()) ctx.fail('Say what to do, and where to stop, in words: --goal "…"');
  const values = sets(i.set);
  for (const k of Object.keys(values))
    if (!/^[a-z][a-zA-Z0-9]*$/.test(k)) ctx.fail(`"${k}": a value's name is one word, like item or deliveryDay`);
  const d = chosen(ctx, i.on);
  const dev = await reach(ctx, d);
  const pkg = await appPackage(ctx, dev, i.app);
  const app = loadApp(ctx, pkg);
  // The button the owner said to stop at: never tapped while learning, and the only one the
  // confirmation screen may be found by.
  const stopAt = i.stopAt?.trim() || null;
  if (stopAt && !commits(app, { text: stopAt })) app.commit = [...app.commit, stopAt];
  media();
  const log = (m) => !i.json && console.error(`  ${m}`);
  const seen = await looked(ctx, i.picture, { goal: i.goal, app, log });
  // Watched step by step: each step is shown, with the screen, and done only on the owner's word.
  const confirmEach = i.step
    ? async (what, shot) =>
        (
          await ctx.askOwner({
            text: `Learning "${i.name}". Next: ${what}`,
            picture: shot ?? undefined,
            choices: ['▶ Go on', '✋ Stop'],
            expiresIn: 300,
          })
        ).answer === '▶ Go on'
    : null;
  const learner = new Learner(dev, {
    app,
    goal: i.goal,
    values,
    stopAt,
    think: (x) => think(ctx, x),
    confirmEach,
    log,
    media: MEDIA,
    told: seen?.notes,
  });
  const free = take(ctx, d, `learning "${i.name}"`);
  let got;
  try {
    got = await session(dev, { app: pkg, name: i.name, after: d.tv ? 'stay' : 'sleep' }, () => learner.run(), { log, tv: d.tv });
  } finally {
    free();
  }
  recordActivity({
    kind: 'event',
    category: 'android',
    summary: `learning ${i.name}: ${got.ended} after ${learner.actions} actions`,
    ok: ['confirm', 'done'].includes(got.ended),
  });
  const so = learner.steps.map((x, k) => `  ${k + 1}. ${x.do} ${JSON.stringify(x.target ?? x.text ?? x.key ?? x.until)}`);
  if (!['confirm', 'done'].includes(got.ended)) {
    const why = {
      'no-model': 'no model could be asked (bc engine status)',
      stuck: `it could not see a way: ${got.why}`,
      stopped: 'you stopped it',
      budget: `it had not got there after ${learner.actions} steps`,
    }[got.ended];
    process.exitCode = 1;
    if (!atTerminal()) await ctx.notify(`🤖 Learning "${i.name}" stopped: ${why}. Nothing was saved.`, { picture: got.shot ?? undefined });
    return {
      text: [`Not learned: ${why}. Nothing was saved.`, ...(so.length ? ['The steps that had worked:', ...so] : [])].join('\n'),
      data: { ended: got.ended, steps: learner.steps },
    };
  }
  // The button that commits: the owner says whether the model has it right, and it joins the app's.
  const now = loadApp(ctx, pkg);
  if (stopAt && !commits(now, { text: stopAt })) now.commit = [...now.commit, stopAt];
  if (got.ended === 'confirm' && !commits(now, { text: got.label })) {
    const a = await ctx.askOwner({
      text: `Learning "${i.name}": it stopped at the screen in the picture, before "${got.label}". Is "${got.label}" the button that books, buys, pays or sends? It is never pressed without your word.`,
      picture: got.shot ?? undefined,
      choices: ['✅ Yes, that is it', '✖ No'],
      expiresIn: 300,
    });
    if (a.answer !== '✅ Yes, that is it')
      return {
        text: `Not saved: ${a.answer ? 'that was not the screen that commits' : 'no answer about the button'}. Try again with a clearer --goal.`,
        data: { ended: 'not-confirmed', steps: learner.steps },
      };
    now.commit = [...now.commit, got.label];
  }
  saveApp(ctx, {
    ...now,
    popups: [...now.popups, ...learner.popups.filter((p) => !now.popups.some((q) => JSON.stringify(q.when) === JSON.stringify(p.when)))],
  });
  // (The screen after the press, from the owner's pictures: learning never gets there.)
  const after = seen?.after_confirm ? resultFromPicture(seen.after_confirm, PATTERNS) : null;
  const steps = got.ended === 'confirm' ? [...learner.steps, { ...got.confirm, ...(after ? { result: after } : {}) }] : learner.steps;
  const used = Object.keys(values).filter((k) => JSON.stringify(steps).includes(`{{${k}}}`));
  const routine = {
    name: i.name,
    app: pkg,
    goal: i.goal,
    ...(used.length ? { params: Object.fromEntries(used.map((k) => [k, { summary: `${k}, such as "${values[k]}"` }])) } : {}),
    ...(i.on ? { device: d.name } : {}),
    steps,
  };
  const problems = validate(routine, loadApp(ctx, pkg));
  if (problems.length)
    return {
      text: `Learned, but not saved: it has mistakes:\n- ${problems.join('\n- ')}\n${JSON.stringify(routine, null, 2)}`,
      data: { ended: 'mistakes', routine },
    };
  saveRoutine(ctx, routine);
  // Gone through again by itself, with no model, to the confirmation screen.
  const offered = await tryAndOffer(ctx, {
    routine,
    on: d.name,
    values,
    what: `Learned "${i.name}" in ${steps.length} steps.`,
    label: got.label ? `"${got.label}"` : null,
  });
  return {
    text: [
      `Learned "${i.name}" (${pkg}) in ${steps.length} steps, from ${learner.actions} tries${used.length ? `; it takes ${used.join(', ')}` : ''}.`,
      ...steps.map((x, k) => `  ${k + 1}. ${x.do} ${JSON.stringify(x.target ?? x.button ?? x.text ?? x.key ?? x.until)}`),
      learner.popups.length ? `Pop-ups kept for the app: ${learner.popups.map((p) => JSON.stringify(p.when)).join(', ')}` : null,
      after ? `After "${got.label}" it waits for ${spokenAny(after.shows)} (from your pictures), and sends you that screen.` : null,
      offered.text,
    ]
      .filter(Boolean)
      .join('\n'),
    data: { ended: got.ended, routine, tried: offered.tried, approved: offered.approved },
  };
}

// A routine changed in words (and pictures): made in its steps, or learned in the app from
// where the change goes, or (the screen after the press) from a picture; then tried again by
// itself and offered to the owner to approve. When the try fails, it is put back as it was.
async function editCmd(ctx, i) {
  if (!i.change?.trim()) ctx.fail('Say what to change, in words: --change "…"');
  const r = loadRoutine(ctx, i.name);
  const app = loadApp(ctx, r.app);
  media();
  const log = (m) => !i.json && console.error(`  ${m}`);
  const seen = await looked(ctx, i.picture, { goal: i.change, app, routine: r, log });
  const plan = await planEdit(ctx, { routine: r, app, change: i.change, told: seen?.notes, picture: !!seen?.after_confirm });
  if (!plan) ctx.fail('No model could be asked how to make the change (bc engine status).');
  log(`the change: ${plan.how}: ${plan.summary}`);
  if (plan.how === 'unclear')
    return { text: `Not changed. ${plan.question ?? plan.summary}`, data: { how: 'unclear', question: plan.question } };
  const confirm = r.steps.at(-1)?.do === 'confirm' ? r.steps.at(-1) : null;
  // (The screen after the press, when a picture is of it: kept whatever else the change is.)
  const after = confirm && seen?.after_confirm ? resultFromPicture(seen.after_confirm, PATTERNS) : null;
  const afterSaid = after
    ? `After ${spoken(confirm.button)} it ${[`waits for ${spokenAny(after.shows)}${after.waiting ? ` (past ${spokenAny(after.waiting)})` : ''}`, after.read ? `reads ${Object.keys(after.read).join(', ')}` : null].filter(Boolean).join(' and ')}, and sends you that screen.`
    : null;
  if (plan.how === 'after_confirm') {
    if (!confirm || !after)
      ctx.fail(
        confirm
          ? 'Send a picture of the screen after the press (--picture), or confirm one for real: it then asks whether to keep that screen.'
          : `"${r.name}" presses nothing for you to confirm, so there is no screen after a press.`,
      );
    saveRoutine(ctx, withResult(r, after));
    return {
      text: `Changed "${r.name}". ${afterSaid} It only looks, so the routine stays ${stateOf(ctx, r.name, r)}. (It is first seen on the device the next time you confirm one.)`,
      data: { how: plan.how, result: after },
    };
  }
  const values = sets(i.set);
  let steps;
  let params = r.params;
  let popups = [];
  if (plan.how === 'steps') {
    try {
      steps = JSON.parse(plan.steps ?? '');
      if (plan.params) params = JSON.parse(plan.params);
    } catch {
      ctx.fail(`The change could not be made: ${plan.summary}`);
    }
  } else {
    // In the app: gone through up to where the new steps go, and they are learned from there.
    const last = confirm ? r.steps.length - 1 : r.steps.length;
    const at = Math.min(plan.at ?? last, last);
    const replace = Math.min(plan.replace ?? 0, last - at);
    const d = chosen(ctx, i.on, r);
    // (A value that is new with the change is typed while learning, and becomes one of the routine's.)
    const filled = withParams(r, Object.fromEntries(Object.entries(values).filter(([k]) => r.params?.[k])));
    const dev = await reach(ctx, d);
    const runner = new Runner(dev, { ...filled, steps: filled.steps.slice(0, at) }, app, {
      answer: async () => 'cancel',
      log,
      media: MEDIA,
      recover: (x) => diagnose(ctx, x),
    });
    const learner = new Learner(dev, {
      app,
      goal: plan.goal ?? i.change,
      values: Object.fromEntries(Object.entries({ ...filled.values, ...values }).filter(([, v]) => v)),
      think: (x) => think(ctx, x),
      log,
      media: MEDIA,
      told: seen?.notes,
      goingOn: { before: r.steps.slice(0, at), next: r.steps[at + replace] ?? null },
    });
    const free = take(ctx, d, `changing "${r.name}"`);
    let got;
    try {
      got = await session(
        dev,
        { app: r.app, name: r.name, after: d.tv ? 'stay' : 'sleep' },
        async () => (await runner.run(), learner.run()),
        {
          log,
          tv: d.tv,
        },
      );
    } catch (e) {
      if (!(e instanceof StepFailed)) throw e;
      ctx.fail(`Not changed: going through "${r.name}" up to the change, ${e.message}`);
    } finally {
      free();
    }
    if (got.ended !== 'done')
      return {
        text: `Not changed: the new steps were not learned (${got.ended}${got.why ? `: ${got.why}` : ''}). "${r.name}" is as it was.`,
        data: { how: plan.how, ended: got.ended, steps: learner.steps },
      };
    steps = spliced(r.steps, at, replace, learner.steps);
    popups = learner.popups;
    const added = Object.keys(values).filter((k) => !params?.[k] && JSON.stringify(steps).includes(`{{${k}}}`));
    if (added.length) params = { ...params, ...Object.fromEntries(added.map((k) => [k, { summary: `${k}, such as "${values[k]}"` }])) };
  }
  const edited = { ...r, ...(params ? { params } : {}), steps };
  const changed = after ? withResult(edited, after) : edited;
  const problems = validate(changed, app);
  if (problems.length)
    ctx.fail(`Not changed: the routine would have mistakes:
- ${problems.join('\n- ')}`);
  try {
    withParams(changed, values); // (it is tried again with these)
  } catch (e) {
    ctx.fail(`Not changed: to try it again after the change, ${e.message}`);
  }
  const lines = changes(r.steps, steps).concat(afterSaid ? [`+ ${afterSaid}`] : []);
  if (!lines.length && JSON.stringify(params) === JSON.stringify(r.params)) return `Nothing to change in "${r.name}": ${plan.summary}`;
  if (popups.length)
    saveApp(ctx, {
      ...app,
      popups: [...app.popups, ...popups.filter((p) => !app.popups.some((q) => JSON.stringify(q.when) === JSON.stringify(p.when)))],
    });
  saveRoutine(ctx, changed);
  const offered = await tryAndOffer(ctx, {
    routine: changed,
    on: i.on,
    values,
    what: `Changed "${r.name}": ${plan.summary}\n${lines.join('\n')}`,
    back: r,
  });
  return {
    text: [`${plan.summary}`, ...lines.map((l) => `  ${l}`), offered.text].join('\n'),
    data: { how: plan.how, routine: offered.kept ? changed : r, tried: offered.tried, approved: offered.approved, kept: offered.kept },
  };
}

// A routine saved as a draft is gone through again by itself (--dry) and offered to the owner
// to approve. `back`: the routine as it was before a change, put back when the try fails or the
// owner says so. → { text, tried, approved, kept }
async function tryAndOffer(ctx, { routine, on, values, what, back = null, label = null }) {
  const used = Object.keys(routine.params ?? {}).filter((k) => values[k] != null && values[k] !== '');
  const tried = await run(ctx, { name: routine.name, set: used.map((k) => `${k}=${values[k]}`), dry: true, on, json: true }).catch((e) => ({
    text: e.message,
    data: { outcome: 'failed' },
  }));
  const ok = ['declined', 'finished'].includes(tried.data.outcome);
  const putBack = () => back && (saveRoutine(ctx, back), true);
  if (!ok) {
    const restored = putBack();
    return {
      text: `Tried again by itself, it did not get there: ${tried.text.split('\n')[0]}${restored ? `\n"${routine.name}" is put back as it was.` : `\nIt needs fixing before it can be approved: bc android show ${routine.name} --json`}`,
      tried: tried.data.outcome,
      approved: false,
      kept: !restored,
    };
  }
  const press = label ?? (routine.steps.at(-1).do === 'confirm' ? spoken(routine.steps.at(-1).button) : null);
  const a = await ctx.askOwner({
    text: `${what}\nTried again by itself: ${tried.text.split('\n')[0]}${used.length ? ` It takes: ${used.join(', ')}.` : ''}\nDid it do what you meant? Approving it lets the agent run it${press ? `; it still asks you before ${press}` : ''}.`,
    picture: tried.data.path ?? undefined,
    choices: back ? ['✅ Approve it', '📝 Keep as a draft', '↩ Put it back'] : ['✅ Approve it', '✖ Not yet'],
    expiresIn: 300,
  });
  if (a.answer === '✅ Approve it') {
    setApproved(ctx, routine.name, loadRoutine(ctx, routine.name));
    return {
      text: `Tried again by itself: ${tried.text.split('\n')[0]}\nApproved: the agent may run it.`,
      tried: tried.data.outcome,
      approved: true,
      kept: true,
    };
  }
  if (a.answer === '↩ Put it back' && putBack())
    return { text: `"${routine.name}" is put back as it was.`, tried: tried.data.outcome, approved: false, kept: false };
  return {
    text: `Tried again by itself: ${tried.text.split('\n')[0]}\nNot approved yet: bc android approve ${routine.name}`,
    tried: tried.data.outcome,
    approved: false,
    kept: true,
  };
}

const ON = ['--on <device>', 'the paired device, by its name (when there are several)'];
const PICTURE = [
  '--picture <file>',
  `a picture of the app, such as its screen after the booking is made (up to ${MAX_PICTURES}): it says what to expect; taps are found on the device`,
  undefined,
  { many: true },
];

export default {
  api: 1,
  name: 'android',
  title: 'Android',
  description:
    'apps on Android phones and TVs, on USB or the network, gone through by routines that ask before anything is booked, paid or sent',
  commands: {
    pair: {
      summary: 'connect an Android device on USB or the network, name it, and put the screen reader on it',
      access: 'owner',
      interactive: true,
      options: [
        ['--name <name>', 'what to call it: phone, tv, …'],
        ['--address <host:port>', 'a device on the network, at this address'],
      ],
      run: pair,
    },
    unpair: { summary: 'forget a device, and take the screen reader off it', access: 'owner', usage: '[name]', run: unpair },
    devices: { summary: 'the paired devices, and whether each is connected', access: 'allow', untrusted: false, run: listPaired },
    screen: {
      summary: 'what a device shows now: its elements, and a picture',
      access: 'allow',
      options: [ON, ['--no-picture', 'only the list of elements']],
      sends: true,
      run: screen,
    },
    adb: {
      summary: "run an adb command on a device: bc android adb <device> shell '<command>'",
      raw: true,
      access: adbAccess,
      run: adbRun,
    },
    mode: {
      summary: 'what the agent may run with adb on a device: read, ask or full',
      access: 'owner',
      usage: '<name> <mode>',
      run: mode,
    },
    check: {
      summary: 'succeed only if an app is in front on a device, or its screen is on or off; --wait gives it time (made for checks)',
      access: 'allow',
      options: [
        ON,
        ['--app <app>', 'this app in front: a word of its package, or the package'],
        ['--screen <on|off>', 'its screen on or off'],
        ['--wait <seconds>', `look again each second for up to this long (up to ${MAX_WAIT_S})`],
      ],
      run: check,
    },
    test: {
      summary: 'whether each device is connected, allowed and charging',
      access: 'allow',
      untrusted: false,
      options: [ON],
      run: test,
    },
    list: { summary: 'the routines, whether each is approved, and how its last run went', access: 'allow', run: routines },
    show: {
      summary: 'one routine whole, or what is kept for an app (by its package); --json gives what add takes back',
      access: 'allow',
      usage: '<name>',
      run: show,
    },
    add: {
      summary: 'add or replace a routine, or what is kept for an app, from a file: a routine starts as a draft',
      access: 'owner',
      usage: '<file>',
      run: add,
    },
    learn: {
      summary:
        'make a routine from words: a model goes through the app step by step, stops before what books, pays or sends, then it is tried again and you approve it',
      access: 'owner',
      usage: '<name>',
      options: [
        ['--app <app>', 'the app: a word of its name, or its package'],
        [
          '--stop-at <button>',
          'the label of the button that books, buys, pays or sends: it stops at its screen, and it is pressed only on your word',
        ],
        ['--goal <words>', 'what to do, and where to stop, in plain words'],
        [
          '--set <name=value>',
          'a value it may type or choose, such as --set item="AA batteries"; each becomes a value of the routine',
          undefined,
          { many: true },
        ],
        PICTURE,
        ON,
        ['--step', 'ask before each step, with a picture of the screen, so you can watch it'],
      ],
      long: true,
      run: learnCmd,
    },
    edit: {
      summary:
        'change a routine in words (and pictures): in its steps, or by learning new steps in the app from where they go; then it is tried again and you approve it',
      // (The agent may, with the owner's word: what it changes is a draft until they approve it.)
      access: (ctx, tokens) => ({
        level: 'ask',
        once: true,
        describe: `change the routine "${tokens.find((t) => !t.startsWith('-')) ?? '?'}" on the device, and try it again`,
      }),
      usage: '<name>',
      options: [
        ['--change <words>', 'what to change, in plain words'],
        ['--set <name=value>', 'the values to go through it with, as for run', undefined, { many: true }],
        PICTURE,
        ON,
      ],
      long: true,
      run: editCmd,
    },
    remove: { summary: 'delete a routine', access: 'owner', usage: '<name>', run: remove },
    approve: {
      summary: 'let the agent run a routine that was run to its confirmation screen as it is now',
      access: 'owner',
      usage: '<name>',
      run: approve,
    },
    run: {
      summary: 'go through a routine on a device; it stops at its confirmation screen and asks you',
      usage: '<name>',
      options: [
        ON,
        ['--set <name=value>', 'a value the routine asks for, such as --set to="the airport"', undefined, { many: true }],
        ['--dry', 'stop at the confirmation screen and decline, by itself (to test a routine)'],
      ],
      long: true,
      changes: true,
      sends: true,
      access: (ctx, tokens) => {
        const name = tokens.find((t, k) => !t.startsWith('-') && !['--on', '--set'].includes(tokens[k - 1]));
        let r = null;
        try {
          r = loadRoutine(ctx, name);
        } catch {
          return { level: 'never', reason: `there is no usable routine called "${name}"` };
        }
        if (tokens.includes('--dry')) return { level: 'allow' };
        if (stateOf(ctx, name, r) !== 'approved')
          return { level: 'never', reason: `"${name}" is not approved: the owner approves it after trying it` };
        // Nothing is booked, paid or sent until the owner presses it on the facts read at that
        // moment; a routine without that step changes things on the device, so it asks.
        return r.steps.at(-1).do === 'confirm'
          ? { level: 'allow' }
          : { level: 'ask', once: true, describe: `go through "${name}" on ${r.device ? `the ${r.device}` : 'the device'}` };
      },
      run,
    },
  },
  status: async (ctx) => {
    const all = listDevices(ctx);
    if (!all.length) return 'nothing paired → bc android pair';
    const seen = await devices(ctx).catch(() => []);
    return all
      .map(
        (d) =>
          `${d.name} (${d.label}) ${seen.find((x) => x.serial === (d.address ?? d.serial))?.state === 'device' ? 'connected' : 'not connected'}`,
      )
      .join(' · ');
  },
  settings: (ctx) => ({
    devices:
      listDevices(ctx)
        .map((d) => `${d.name}: ${d.label}, ${how(d)}`)
        .join('; ') || 'none',
  }),
  selftest: (ctx) =>
    listDevices(ctx).map((d) => ({
      name: `${d.name} (${d.label})`,
      run: async () => {
        const dev = await reach(ctx, d);
        const bat = await dev.battery();
        const server = (await dev.serverAnswers()) ? 'its screen reader answers' : 'its screen reader starts with the next command';
        return `connected · ${server}${bat.battery ? ` · battery ${bat.level}%${bat.charging ? ', charging' : ', not charging'}` : ''}`;
      },
    })),
  agent: {
    fill: (ctx) => {
      const all = listDevices(ctx);
      return {
        ready: all.length > 0,
        devices: all.map((d) => `"${d.name}" (${d.label}, a ${kindOf(d)}, ${how(d)}; adb: ${d.mode})`).join(', '),
        several: all.length > 1,
      };
    },
    readDirs: () => [MEDIA],
  },
};
