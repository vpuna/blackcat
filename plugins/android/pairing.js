// Pairing a device, the paired ones, their screens, and the adb commands the agent may run
// on them by their mode. (Split out of plugin.js.)
import path from 'node:path';
import { COMMAND_MODES, commandAccess, isoLocal, now, plural, prompts, sleep } from '../../src/api.js';
import { judge } from './adb.js';
import { ADDRESS, adbInstalled, connect, Device, devices, pairWithCode, SERVER, serverFile, STOP_SERVER } from './device.js';
import { DEVICE_NAME, deleteDevice, dropServerKey, getDevice, listDevices, saveDevice, setMode } from './routines.js';

import { elements, packageOf, parse, screenText } from './screen.js';
import { media, chosen, reach, keyFingerprint, until, kindOf, how } from './shared.js';

let p; // the terminal questions, loaded by pair() (only pairing asks them)

// ---------- pairing ----------

export const stop = (msg) => {
  p.cancel(msg);
  process.exitCode = 1;
  return null;
};

// A device on USB that has been connected. → { serial } of the one chosen, or null.
export async function onUsb(ctx, orExit) {
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
export async function onNetwork(ctx, orExit, given) {
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

export async function pair(ctx, i) {
  const { orExit } = await prompts();
  p = await import('@clack/prompts');
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

export async function unpair(ctx, i) {
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

export async function listPaired(ctx) {
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

export async function screen(ctx, i) {
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
export async function test(ctx, i) {
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

export const MAX_OUTPUT = 20_000;
export const clip = (x) =>
  x.length > MAX_OUTPUT
    ? `${x.slice(0, MAX_OUTPUT / 2)}\n… (${x.length - MAX_OUTPUT} characters left out) …\n${x.slice(-MAX_OUTPUT / 2)}`
    : x;

// What the agent may run with adb on a device: decided by the command, and the device's mode.
export function adbAccess(ctx, tokens) {
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
export const POWER_KEYS = /\b(KEYCODE_)?(POWER|WAKEUP|SLEEP|SOFT_SLEEP)\b/;
export const WOKEN_SETTLE_MS = 700; // for what was asleep to be ready to take a command

// Woken, if it was asleep (and a swipe lock dismissed). → whether it was asleep.
export async function wokeFirst(dev) {
  if ((await dev.wakefulness()) === 'Awake' && !(await dev.keyguardShowing())) return false;
  await dev.wake();
  await sleep(WOKEN_SETTLE_MS);
  return true;
}

export async function adbRun(ctx, { _: tokens }) {
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

export function mode(ctx, i) {
  const d = getDevice(ctx, i.name) ?? ctx.fail(`No device is paired as "${i.name}".`);
  if (!COMMAND_MODES[i.mode]) ctx.fail(`The mode is one of: ${Object.keys(COMMAND_MODES).join(', ')}`);
  setMode(ctx, d.name, i.mode);
  return `The ${d.name} is now "${i.mode}" for the agent's adb commands: ${COMMAND_MODES[i.mode]}.`;
}
