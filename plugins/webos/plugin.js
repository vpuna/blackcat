// LG webOS TVs on the network, through the TV's own control service (tv.js): on and off, the
// volume, the input, an app, the remote's buttons, a message on the screen, and what it is doing
// now. Each TV is paired under a name ("tv", "bedroom-tv"), with the owner's OK on the TV.
// Nothing here reads the screen: what the TV says it is doing is all there is to go by.
import * as p from '@clack/prompts';
import { plural, prompts, sleep } from '../../src/api.js';
import { BUTTONS, MAC, powerState, Tv, TvError, wake, withTv } from './tv.js';

export const NAME = /^[a-z][a-z0-9-]{0,20}$/;
const HOST = /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/;
const WAKE_MS = 45_000; // for a TV woken from off (or still going off) to come onto the network and answer
const STEP_GAP_MS = 200; // between volume steps
const MAX_STEPS = 50;
const MAX_PRESSES = 30;

// ---------- the paired TVs ----------

const all = (ctx) => Object.values(ctx.store.get('devices') ?? {}).sort((a, b) => a.name.localeCompare(b.name));
const one = (ctx, name) => (ctx.store.get('devices') ?? {})[name] ?? null;
const keep = (ctx, d) => ctx.store.update('devices', (x) => ({ ...(x ?? {}), [d.name]: d }));
const forget = (ctx, name) =>
  ctx.store.update('devices', (x) => {
    const { [name]: _gone, ...rest } = x ?? {};
    return rest;
  });

// The TV a command is for: the one named, else the only one.
function chosen(ctx, on) {
  const tvs = all(ctx);
  if (on) return one(ctx, on) ?? ctx.fail(`No TV is paired as "${on}". bc webos devices lists them.`);
  if (!tvs.length) ctx.fail('No TV is paired yet → bc webos pair');
  if (tvs.length > 1) ctx.fail(`Which TV? Add --on ${tvs.map((d) => d.name).join(' or --on ')}.`);
  return tvs[0];
}

const login = (ctx, d) => ({ key: ctx.secrets.get(`key:${d.name}`), pin: d.pin ?? null, ports: d.ports });
const on = (ctx, d, fn) => withTv(d.host, login(ctx, d), fn);

// ---------- what it is doing ----------

// webOS says where the sound goes in its own words.
const OUTPUTS = {
  tv_speaker: 'its own speakers',
  external_arc: 'a sound bar or receiver on HDMI ARC',
  external_optical: 'a sound bar or receiver on optical',
  bt_soundbar: 'a Bluetooth sound bar',
  headphone: 'headphones',
  lineout: 'line out',
  tv_external_speaker: 'its speakers and an external one',
};
const outputOf = (o) => (o ? (OUTPUTS[o] ?? o.replace(/_/g, ' ')) : null);
// (Through ARC or optical the TV passes steps on to the sound bar, but not a level it can set or read.)
const outside = (o) => !!o && o !== 'tv_speaker' && o !== 'tv_external_speaker';

async function volumeOf(tv) {
  const v = await tv.request('audio/getVolume').catch(() => null);
  const s = v?.volumeStatus ?? v ?? {};
  return {
    level: Number.isFinite(s.volume) ? s.volume : null,
    muted: s.muteStatus ?? s.muted ?? null,
    output: s.soundOutput ?? (await tv.request('com.webos.service.apiadapter/audio/getSoundOutput').catch(() => null))?.soundOutput ?? null,
  };
}

const inputsOf = async (tv) => (await tv.request('tv/getExternalInputList')).devices ?? [];
const appsOf = async (tv) => (await tv.request('com.webos.applicationManager/listLaunchPoints')).launchPoints ?? [];

async function state(tv) {
  const power = await powerState(tv);
  const appId = (await tv.request('com.webos.applicationManager/getForegroundAppInfo').catch(() => null))?.appId ?? null;
  const input = appId ? (await inputsOf(tv).catch(() => [])).find((x) => x.appId === appId) : null;
  const app = appId && !input ? (await appsOf(tv).catch(() => [])).find((x) => x.id === appId) : null;
  return { power, appId, watching: input?.label ?? app?.title ?? appId, input: input?.label ?? null, ...(await volumeOf(tv)) };
}

const POWER = { 'screen off': 'on, with its screen off', standby: 'in standby' };
const powerOf = (p) => (p ? (POWER[p] ?? p) : 'on');
// (An older TV that does not say: on when it answers and shows something.)
const isOn = (s) => !!s && (s.power === 'on' || (s.power == null && !!s.appId));

function said(d, s) {
  const level = s.level != null && !outside(s.output) ? `volume ${s.level}` : null;
  return [
    `The ${d.name} (${d.model}) is ${powerOf(s.power)}`,
    s.watching ? `showing ${s.watching}` : null,
    [level, s.muted ? 'muted' : null, s.output ? `sound to ${outputOf(s.output)}` : null].filter(Boolean).join(', ') || null,
  ]
    .filter(Boolean)
    .join(' · ');
}

async function status1(ctx, i) {
  if (!all(ctx).length) return { text: 'No TV is paired yet → bc webos pair', data: { tvs: 0 } };
  const d = chosen(ctx, i.on);
  try {
    const s = await on(ctx, d, state);
    return { text: `${said(d, s)}.`, data: { device: d.name, on: true, ...s } };
  } catch (e) {
    if (!(e instanceof TvError) || !/does not answer/.test(e.message)) throw e;
    return { text: `The ${d.name} does not answer: it is off, or not on the network.`, data: { device: d.name, on: false } };
  }
}

// ---------- choosing an input or an app by its name ----------

const squash = (t) =>
  String(t ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
// The one whose name (or id) the words name: the same, else the only one that starts with them,
// else the only one that has them. → it, or a stop that lists them.
function pick(ctx, list, words, kind) {
  const want = squash(words);
  const names = (x) => [x.label ?? x.title, x.id].map(squash);
  const found =
    [(n) => n === want, (n) => n.startsWith(want), (n) => n.includes(want)]
      .map((test) => list.filter((x) => names(x).some(test)))
      .find((hits) => hits.length) ?? [];
  if (found.length === 1) return found[0];
  const shown = (found.length ? found : list).map((x) => `"${x.label ?? x.title}"`).join(', ');
  return ctx.fail(
    found.length ? `"${words}" could be any of ${shown}. Say which.` : `No ${kind} is called "${words}". There are: ${shown}.`,
  );
}

// ---------- commands ----------

async function pair(ctx, i) {
  const { orExit } = await prompts();
  p.intro('blackcat · pairing an LG webOS TV');
  if (i.name && !NAME.test(i.name)) return void stop(`"${i.name}" is not a name for a TV: lowercase letters, digits and dashes, like tv.`);
  const host =
    i.address ??
    orExit(
      await p.text({
        message: "The TV's address on the network (its IP address: Settings → General → Network, or your router's list)",
        validate: (v) => (HOST.test(v.trim()) ? undefined : 'An IP address like 192.168.1.40, or a name'),
      }),
    ).trim();
  if (!HOST.test(host)) return void stop(`"${host}" is not an address.`);

  const tv = new Tv(host);
  const s = p.spinner();
  s.start(`Reaching the TV at ${host}`);
  try {
    await tv.open();
    s.message('Asking it to let blackcat in');
    const key = await tv.register({
      onPrompt: () => s.message('On the TV, choose Allow (or Yes) with the remote: it waits a minute'),
    });
    s.stop('It let blackcat in.');
    const sys = await tv.request('system/getSystemInfo').catch(() => ({}));
    const sw = await tv.request('com.webos.service.update/getCurrentSWInformation').catch(() => ({}));
    const net = await tv.request('com.webos.service.connectionmanager/getinfo').catch(() => ({}));
    const card = [net.wiredInfo, net.wifiInfo].find((n) => n?.state === 'connected')?.macAddress ?? net.wiredInfo?.macAddress;
    const mac = i.mac ?? card ?? null;
    if (mac && !MAC.test(mac)) return void stop(`"${mac}" is not a network card's address (like 58:96:0a:77:df:aa).`);
    const model = sys.modelName ?? 'LG TV';
    p.log.success(`${model}${sw.product_name ? `, ${sw.product_name}` : ''}${mac ? `, network card ${mac}` : ''}.`);

    const tvs = all(ctx);
    const same = tvs.find((x) => x.host === host);
    const free = (n) => !tvs.some((x) => x.name === n && x.host !== host);
    const suggestion = same?.name ?? ['tv', ...[2, 3, 4, 5, 6, 7, 8, 9].map((k) => `tv-${k}`)].find(free);
    const name =
      i.name ??
      orExit(
        await p.text({
          message: 'What to call it (for --on, and in what blackcat says)',
          initialValue: suggestion,
          validate: (v) =>
            !NAME.test(v.trim()) ? 'Lowercase letters, digits and dashes' : free(v.trim()) ? undefined : 'Another TV has that name',
        }),
      ).trim();
    if (!free(name)) return void stop(`"${name}" is the name of another TV. Unpair it first (bc webos unpair ${name}), or choose another.`);

    ctx.secrets.set(`key:${name}`, key);
    if (same && same.name !== name) {
      forget(ctx, same.name);
      ctx.secrets.delete(`key:${same.name}`);
    }
    keep(ctx, { name, host, mac, model, pin: tv.cert ?? null, pairedAt: Math.floor(Date.now() / 1000) });
    await tv.request('system.notifications/createToast', { message: `blackcat can now control this TV as "${name}".` }).catch(() => {});
    p.note(
      [
        mac
          ? 'To be turned on by blackcat, the TV must listen for it while it is off: on the TV, Settings → General → Devices (or External Devices, or TV Management) → "Turn on via Wi-Fi" (or "Mobile TV On"): On. It works on a cable too.'
          : 'It did not say its network card, so blackcat cannot turn it on. Pair it again with --mac <address> (your router lists it).',
        'Volume steps go to a sound bar on HDMI ARC as the remote does; a level to set or read is only for its own speakers.',
      ].join('\n'),
      'Good to know',
    );
    p.outro(
      `Paired the ${model} as "${name}"${same && same.name !== name ? ` (it was "${same.name}")` : ''}. Try: bc webos status${tvs.length > (same ? 1 : 0) ? ` --on ${name}` : ''}`,
    );
  } catch (e) {
    s.stop('It did not pair.');
    return void stop(e instanceof TvError ? e.message : `It did not pair: ${e.message}`);
  } finally {
    await tv.close();
  }
}

const stop = (msg) => {
  p.cancel(msg);
  process.exitCode = 1;
  return null;
};

function unpair(ctx, i) {
  const d = i.name ? one(ctx, i.name) : chosen(ctx);
  if (!d) ctx.fail(`No TV is paired as "${i.name}".`);
  forget(ctx, d.name);
  ctx.secrets.delete(`key:${d.name}`);
  return `Forgot the ${d.name} (${d.model}). To take blackcat off the TV's own list too: on the TV, Settings → General → Devices → External Devices (or "Mobile device connections") → delete it.`;
}

function devices(ctx) {
  const tvs = all(ctx);
  return {
    text: tvs.length
      ? tvs.map((d) => `${d.name} · ${d.model} · at ${d.host}${d.mac ? '' : ' · cannot be turned on (no network card known)'}`).join('\n')
      : 'No TV is paired yet → bc webos pair',
    data: tvs.map(({ name, host, mac, model }) => ({ name, host, mac, model })),
  };
}

async function powerOn(ctx, i) {
  const d = chosen(ctx, i.on);
  const offline = (e) => (e instanceof TvError && /does not answer/.test(e.message) ? null : Promise.reject(e));
  // On already (or with its screen off), it answers.
  const now = await on(ctx, d, state).catch(offline);
  if (isOn(now)) return { text: `The ${d.name} is on already.`, data: { device: d.name, on: true, was: 'on' } };
  if (now?.power === 'screen off') {
    await on(ctx, d, (tv) => tv.request('com.webos.service.tvpower/power/turnOnScreen', { standbyMode: 'active' }));
    return {
      text: `The ${d.name} was on with its screen off: its screen is on now.`,
      data: { device: d.name, on: true, was: 'screen off' },
    };
  }
  if (!d.mac) ctx.fail(`blackcat does not know the ${d.name}'s network card, so it cannot turn it on. Pair it again with --mac <address>.`);
  // Off, in standby, or still going off: woken over the network until it says it is on.
  const t0 = Date.now();
  while (Date.now() - t0 < WAKE_MS) {
    await wake(d.mac, d.host); // (again each time: one packet can be lost, and one sent while it goes off is not heard)
    if (isOn(await on(ctx, d, state).catch(() => null)))
      return {
        text: `The ${d.name} is on (${Math.round((Date.now() - t0) / 1000)}s).`,
        data: { device: d.name, on: true, was: now?.power ?? 'off' },
      };
    await sleep(1000);
  }
  return ctx.fail(
    `The ${d.name} was sent the wake-up but did not come on in ${WAKE_MS / 1000}s. On the TV: Settings → General → Devices → "Turn on via Wi-Fi" (or "Mobile TV On") must be On.`,
  );
}

async function powerOff(ctx, i) {
  const d = chosen(ctx, i.on);
  await on(ctx, d, (tv) => tv.request('system/turnOff'));
  return { text: `The ${d.name} is turned off.`, data: { device: d.name, on: false } };
}

async function volume(ctx, i) {
  const d = chosen(ctx, i.on);
  const how = String(i.how).toLowerCase();
  const steps = i.steps == null ? 1 : Number(i.steps);
  if (!Number.isInteger(steps) || steps < 1 || steps > MAX_STEPS) ctx.fail(`Steps are a whole number from 1 to ${MAX_STEPS}.`);
  return on(ctx, d, async (tv) => {
    let did;
    if (how === 'up' || how === 'down') {
      for (let k = 0; k < steps; k++) {
        if (k) await sleep(STEP_GAP_MS);
        await tv.request(how === 'up' ? 'audio/volumeUp' : 'audio/volumeDown');
      }
      did = `Volume ${how} ${plural(steps, 'step', 'steps')}`;
    } else if (how === 'mute' || how === 'unmute') {
      await tv.request('audio/setMute', { mute: how === 'mute' });
      did = how === 'mute' ? 'Muted' : 'Unmuted';
    } else if (/^\d{1,3}$/.test(how) && Number(how) <= 100) {
      const before = await volumeOf(tv);
      if (outside(before.output))
        ctx.fail(
          `The ${d.name}'s sound goes to ${outputOf(before.output)}, whose level the TV cannot set or read. Use steps instead: bc webos volume up 5`,
        );
      await tv.request('audio/setVolume', { volume: Number(how) });
      did = `Volume set to ${how}`;
    } else ctx.fail('Say up, down, mute, unmute or a level from 0 to 100: bc webos volume up 5');
    await sleep(300); // (what it reads back has caught up)
    const v = await volumeOf(tv);
    const now =
      v.level != null && !outside(v.output)
        ? `: it is at ${v.level}${v.muted ? ', muted' : ''}`
        : outside(v.output)
          ? ` (to ${outputOf(v.output)})`
          : '';
    return { text: `${did} on the ${d.name}${now}.`, data: { device: d.name, did: how, steps, ...v } };
  });
}

async function input(ctx, i) {
  const d = chosen(ctx, i.on);
  return on(ctx, d, async (tv) => {
    const list = await inputsOf(tv);
    if (!i.name?.length)
      return {
        text: list
          .map((x) => `${x.label}${x.label !== x.id ? ` (${x.id.replace('_', ' ')})` : ''}${x.connected ? '' : ' · nothing connected'}`)
          .join('\n'),
        data: list.map(({ id, label, connected }) => ({ id, label, connected: !!connected })),
      };
    const x = pick(ctx, list, i.name.join(' '), 'input');
    await tv.request('tv/switchInput', { inputId: x.id });
    return { text: `The ${d.name} is on ${x.label}.`, data: { device: d.name, input: x.id, label: x.label } };
  });
}

async function launch(ctx, i) {
  const d = chosen(ctx, i.on);
  return on(ctx, d, async (tv) => {
    const list = await appsOf(tv);
    if (!i.app?.length) return { text: list.map((x) => x.title).join(', '), data: list.map(({ id, title }) => ({ id, title })) };
    const x = pick(ctx, list, i.app.join(' '), 'app');
    await tv.request('com.webos.applicationManager/launch', { id: x.id });
    return { text: `Opened ${x.title} on the ${d.name}.`, data: { device: d.name, app: x.id, title: x.title } };
  });
}

// The buttons named: as the TV calls them, any case; a number is its digits, one by one (a channel).
export function buttons(words) {
  const out = [];
  for (const w of words.flatMap((x) => String(x).split(/[\s,]+/)).filter(Boolean))
    if (/^\d+$/.test(w)) out.push(...w);
    else {
      const b = w.toUpperCase().replace(/-/g, '_');
      if (!BUTTONS.includes(b))
        throw new TvError(`"${w}" is not a button. There are: ${BUTTONS.filter((x) => !/^\d$/.test(x)).join(', ')}, and the digits.`);
      out.push(b);
    }
  if (!out.length) throw new TvError('Name a button: bc webos button HOME');
  if (out.length > MAX_PRESSES) throw new TvError(`At most ${MAX_PRESSES} presses at a time.`);
  return out;
}

async function button(ctx, i) {
  const d = chosen(ctx, i.on);
  const names = buttons(i.names ?? []);
  await on(ctx, d, (tv) => tv.press(names));
  return { text: `Pressed ${names.join(' ')} on the ${d.name}.`, data: { device: d.name, pressed: names } };
}

async function notify(ctx, i) {
  const d = chosen(ctx, i.on);
  const message = (i.text ?? []).join(' ').trim();
  if (!message) ctx.fail('What should it say? bc webos notify "Dinner is ready"');
  if (message.length > 200) ctx.fail('At most 200 characters.');
  await on(ctx, d, (tv) => tv.request('system.notifications/createToast', { message }));
  return { text: `Shown on the ${d.name}: ${message}`, data: { device: d.name, message } };
}

// For a shortcut or a check: succeed only once the TV is as said (on or off, on an input,
// showing an app), looking again each second for up to `--wait` seconds.
const MAX_WAIT_S = 120;
async function check(ctx, i) {
  const d = chosen(ctx, i.on);
  const power = i.power == null ? null : String(i.power).toLowerCase();
  if (power != null && power !== 'on' && power !== 'off') ctx.fail('--power is on or off.');
  if (power == null && !i.input && !i.app) ctx.fail('Say what to check: --power on|off, --input <name>, --app <name>.');
  if (power === 'off' && (i.input || i.app)) ctx.fail('A TV that is off shows no input or app: check --power off alone.');
  const wait = i.wait == null ? 0 : Number(i.wait);
  if (!Number.isInteger(wait) || wait < 0 || wait > MAX_WAIT_S) ctx.fail(`--wait is a whole number of seconds, 0 to ${MAX_WAIT_S}.`);
  const t0 = Date.now();
  let wanted = null; // (the input and app named, found once)
  for (;;) {
    let now;
    try {
      now = await on(ctx, d, async (tv) => {
        wanted ??= {
          input: i.input ? pick(ctx, await inputsOf(tv), i.input, 'input') : null,
          app: i.app ? pick(ctx, await appsOf(tv), i.app, 'app') : null,
        };
        return state(tv);
      });
    } catch (e) {
      if (!(e instanceof TvError) || !/does not answer/.test(e.message)) throw e;
      now = null; // (off, or not on the network)
    }
    const up = isOn(now);
    const wrong = [];
    if (power === 'on' && !up) wrong.push(now ? powerOf(now.power) : 'off');
    if (power === 'off' && up) wrong.push('on');
    if (wanted?.input && now?.appId !== wanted.input.appId) wrong.push(`on ${now?.watching ?? 'nothing'}, not ${wanted.input.label}`);
    if (wanted?.app && now?.appId !== wanted.app.id) wrong.push(`showing ${now?.watching ?? 'nothing'}, not ${wanted.app.title}`);
    if ((i.input || i.app) && !now) wrong.push('off');
    const took = Math.round((Date.now() - t0) / 1000);
    if (!wrong.length)
      return {
        text: `The ${d.name} is ${up ? 'on' : 'off'}${up && now?.watching ? `, showing ${now.watching}` : ''}${took ? ` (after ${took}s)` : ''}.`,
        data: { device: d.name, ok: true, on: up, watching: now?.watching ?? null, seconds: took },
      };
    if (Date.now() - t0 >= wait * 1000)
      return ctx.fail(`The ${d.name} is ${[...new Set(wrong)].join(', ')}${wait ? `, after ${took}s` : ''}.`);
    await sleep(1000);
  }
}

async function test(ctx, i) {
  const tvs = i.on ? [chosen(ctx, i.on)] : all(ctx);
  if (!tvs.length) return 'No TV is paired yet → bc webos pair';
  const out = [];
  for (const d of tvs)
    out.push(
      await on(ctx, d, state)
        .then((s) => ({ name: d.name, ok: true, text: `${d.name}: answers and lets blackcat in · ${powerOf(s.power)}` }))
        .catch((e) => ({ name: d.name, ok: false, text: `${d.name}: ${e.message}` })),
    );
  if (out.some((x) => !x.ok)) process.exitCode = 1;
  return { text: out.map((x) => x.text).join('\n'), data: out.map(({ name, ok, text }) => ({ name, ok, said: text })) };
}

// ---------- the manifest ----------

const ON = ['--on <tv>', 'the paired TV, by its name (when there are several)'];
const named = (tokens) => {
  const k = tokens.indexOf('--on');
  return k >= 0 ? tokens[k + 1] : null;
};
const where = (ctx, tokens) => {
  const n = named(tokens) ?? (all(ctx).length === 1 ? all(ctx)[0].name : null);
  return n ? `the ${n}` : 'the TV';
};
const words = (tokens) => tokens.filter((t, k) => !t.startsWith('--') && tokens[k - 1] !== '--on');
// Changing something on a TV: asked, and the owner may allow it for good.
const changing = (what) => (ctx, tokens) => ({ level: 'ask', describe: `${what(words(tokens))} on ${where(ctx, tokens)}` });

export default {
  api: 1,
  name: 'webos',
  title: 'LG TV',
  description: 'LG webOS TVs on the network: on and off, the volume, the input, apps, the remote, and what each is doing',
  commands: {
    pair: {
      summary: 'connect an LG TV on the network and name it: the TV asks you to allow it',
      access: 'owner',
      interactive: true,
      options: [
        ['--name <name>', 'what to call it: tv, bedroom-tv, …'],
        ['--address <ip>', "the TV's address on the network"],
        ['--mac <address>', 'its network card, to turn it on (when it does not say it itself)'],
      ],
      run: pair,
    },
    unpair: { summary: 'forget a TV', access: 'owner', usage: '[name]', run: unpair },
    devices: { summary: 'the paired TVs', access: 'allow', untrusted: false, run: devices },
    status: {
      summary: 'what a TV is doing: on or off, the app or input, the volume and where the sound goes',
      access: 'allow',
      options: [ON],
      run: status1,
    },
    test: { summary: 'whether each TV answers and lets blackcat in', access: 'allow', options: [ON], run: test },
    check: {
      summary: 'succeed only if a TV is on or off, on an input, or showing an app; --wait gives it time (made for checks)',
      access: 'allow',
      options: [
        ON,
        ['--power <on|off>', 'on (its screen on) or off'],
        ['--input <name>', 'on this input (a few words of its name)'],
        ['--app <name>', 'showing this app'],
        ['--wait <seconds>', `look again each second for up to this long (up to ${MAX_WAIT_S})`],
      ],
      run: check,
    },
    on: { summary: 'turn a TV on (or its screen, when only that is off)', access: changing(() => 'turn on'), options: [ON], run: powerOn },
    off: { summary: 'turn a TV off', access: changing(() => 'turn off'), options: [ON], run: powerOff },
    volume: {
      summary: 'the volume: up or down a few steps, mute, unmute, or a level (for its own speakers)',
      usage: '<how> [steps]',
      access: changing((w) => `volume ${w.join(' ')}`),
      options: [ON],
      run: volume,
    },
    input: {
      summary: 'switch to an input by its name (HDMI 1, or what the TV calls it); with none, the inputs',
      usage: '[name...]',
      access: (ctx, tokens) => (words(tokens).length ? changing((w) => `switch to ${w.join(' ')}`)(ctx, tokens) : { level: 'allow' }),
      options: [ON],
      run: input,
    },
    launch: {
      summary: 'open an app by its name; with none, the apps',
      usage: '[app...]',
      access: (ctx, tokens) => (words(tokens).length ? changing((w) => `open ${w.join(' ')}`)(ctx, tokens) : { level: 'allow' }),
      options: [ON],
      run: launch,
    },
    button: {
      summary: "press the remote's buttons: HOME, BACK, UP, ENTER, a number (its digits one by one), …",
      usage: '<names...>',
      access: changing((w) => `press ${w.join(' ')}`),
      options: [ON],
      run: button,
    },
    notify: {
      summary: 'show a short message on the TV',
      usage: '<text...>',
      access: changing((w) => `show "${w.join(' ')}"`),
      options: [ON],
      run: notify,
    },
  },
  status: (ctx) => {
    const tvs = all(ctx);
    return tvs.length
      ? `${plural(tvs.length, 'TV', 'TVs')} paired: ${tvs.map((d) => d.name).join(', ')}`
      : 'nothing paired → bc webos pair';
  },
  settings: (ctx) => ({
    tvs:
      all(ctx)
        .map((d) => `${d.name}: ${d.model} at ${d.host}${d.mac ? `, network card ${d.mac}` : ''}`)
        .join('; ') || 'none',
  }),
  selftest: (ctx) =>
    all(ctx).map((d) => ({
      name: `${d.name} (${d.model})`,
      run: async () => {
        try {
          return `answers · ${powerOf((await on(ctx, d, state)).power)}`;
        } catch (e) {
          // (A TV that is off is not answering, and that is not a fault.)
          if (e instanceof TvError && /does not answer/.test(e.message)) return { skip: 'off, or not on the network' };
          throw e;
        }
      },
    })),
  agent: {
    fill: (ctx) => {
      const tvs = all(ctx);
      return {
        ready: tvs.length > 0,
        tvs: tvs.map((d) => `"${d.name}" (${d.model}${d.mac ? '' : ', cannot be turned on by blackcat'})`).join(', '),
        several: tvs.length > 1,
      };
    },
  },
};
