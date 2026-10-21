// An Android device (a phone, a tablet, a TV), reached over adb on USB or on the network. adb
// is the only program run to reach it; on the device, uiautomator2's server reads the screen
// and touches it, answering JSON-RPC through a port that adb forwards. Nothing here knows any app.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PluginError, recordActivity, sleep } from '../../src/api.js';

// uiautomator2's server (MIT, github.com/openatx/android-uiautomator-server-jar), in blackcat's
// build of it (github.com/vpuna/android-uiautomator-server-jar): it answers only on the device
// itself (blackcat reaches it through adb's forwarded port), and only a request that carries the
// key it was started with. It comes with the plugin (server/, with its licence); pinned: the file
// is checked against this before it is put on a device.
export const SERVER = {
  version: 'blackcat.1',
  file: fileURLToPath(new URL('./server/u2.jar', import.meta.url)),
  sha256: 'ac169be0099a8277c3dbd5a255e5d65b05f7fabb9eed504c43ad0db437a7cd6c',
  bytes: 3708369,
  onDevice: '/data/local/tmp/u2.jar',
  port: 9008,
};
const START = (key) =>
  `CLASSPATH=${SERVER.onDevice} nohup app_process / com.wetest.uia2.Main -p ${SERVER.port} -t ${key} >/dev/null 2>&1 &`;
// (The pattern does not match its own command line, which holds the name written otherwise:
// `pkill -f com.wetest.uia2.Main` would stop the shell it runs in, and what came after it.)
export const STOP_SERVER = "pkill -f 'com.wetest.uia2.Mai[n]' || true";
// What the server says when it has lost its link to the system (it then cannot look at anything).
const STUCK = /RuntimeException|UiAutomation not connected|IllegalStateException/;
const KEY_HEADER = 'x-blackcat-key';
// How long one that was just started is given to answer (a TV box's first takes about 9 s).
const START_WAIT_MS = 20_000;

// uiautomator2's selector for the text field that has the focus (its masks: className 0x10,
// focused 0x020000).
const FOCUSED_FIELD = {
  mask: 0x020010,
  className: 'android.widget.EditText',
  focused: true,
  childOrSibling: [],
  childOrSiblingSelector: [],
};

// A problem with a device, said as a sentence (no stack trace).
export class AndroidError extends PluginError {}

// An app is named by its package; nothing else is put into a command line on the device.
export const PACKAGE = /^[a-zA-Z][\w]*(\.[a-zA-Z_][\w]*)+$/;
const pkgOf = (pkg) => {
  if (!PACKAGE.test(pkg ?? '')) throw new AndroidError(`"${pkg}" is not an app's package name (like com.example.app)`);
  return pkg;
};

// A device on the network is reached at an address: a host name or IPv4 address, and a port.
export const ADDRESS = /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}:\d{2,5}$/;

// → [{ serial, state, model }]: state is 'device' (ready), 'unauthorized' (the device has not
// allowed this machine yet), 'offline', … One on the network is listed by its address.
export async function devices(ctx) {
  const r = await ctx.exec('adb', ['devices', '-l'], { timeoutMs: 15_000 });
  if (r.code !== 0) throw new AndroidError(r.code === 127 || /ENOENT/.test(r.stderr) ? 'adb is not installed' : r.stderr.trim());
  return r.stdout
    .split('\n')
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((w) => w.length >= 2)
    .map(([serial, state, ...rest]) => ({
      serial,
      state,
      model:
        rest
          .find((w) => w.startsWith('model:'))
          ?.slice(6)
          .replace(/_/g, ' ') ?? null,
    }));
}

export async function adbInstalled(ctx) {
  const r = await ctx.exec('adb', ['version'], { timeoutMs: 10_000 });
  return r.code === 0 ? r.stdout.split('\n')[0].trim() : null;
}

// Connect to a device on the network. adb keeps the connection until it is cut off (the
// device restarted, the network dropped), and is asked again then.
export async function connect(ctx, address) {
  if (!ADDRESS.test(address ?? '')) throw new AndroidError(`"${address}" is not an address (host:port, like 192.168.1.40:5555)`);
  const r = await ctx.exec('adb', ['connect', address], { timeoutMs: 20_000 });
  const said = `${r.stdout}${r.stderr}`.trim();
  if (r.code !== 0 || !/connected to/.test(said)) throw new AndroidError(`could not connect to ${address}: ${said || `exit ${r.code}`}`);
  return said;
}

// Android 11's wireless debugging: allow this machine once, with the six-digit code the
// device shows ("Pair device with pairing code"), at the address it shows beside the code.
export async function pairWithCode(ctx, address, code) {
  if (!ADDRESS.test(address ?? '')) throw new AndroidError(`"${address}" is not an address (host:port)`);
  if (!/^\d{6}$/.test(code ?? '')) throw new AndroidError('the pairing code is six digits');
  const r = await ctx.exec('adb', ['pair', address, code], { timeoutMs: 30_000 });
  const said = `${r.stdout}${r.stderr}`.trim();
  if (r.code !== 0 || !/Successfully paired/i.test(said))
    throw new AndroidError(`could not pair with ${address}: ${said || `exit ${r.code}`}`);
}

export class Device {
  // `target`: what adb knows it by (its serial on USB, its address on the network).
  constructor(ctx, target) {
    this.ctx = ctx;
    this.serial = target;
    this.port = null;
  }

  async adb(args, { timeoutMs = 30_000 } = {}) {
    const r = await this.ctx.exec('adb', ['-s', this.serial, ...args], { timeoutMs });
    if (r.code !== 0) {
      const why = (r.stderr || r.stdout).trim();
      if (/not found|offline|unauthorized|no devices/i.test(why)) throw new AndroidError(`the device is not connected (${why})`);
      throw new AndroidError(`adb ${args[0]} failed: ${why || `exit ${r.code}`}`);
    }
    return r.stdout;
  }

  shell(command, opts) {
    return this.adb(['shell', command], opts).then((s) => s.trim());
  }

  // ---------- what the device is ----------

  // (`serial` is the device's own, the same on USB and on the network: an address can come
  // to belong to another device, and this is how that is noticed.)
  async about() {
    const [release, sdk, model, maker, serial] = await Promise.all(
      ['ro.build.version.release', 'ro.build.version.sdk', 'ro.product.model', 'ro.product.manufacturer', 'ro.serialno'].map((p) =>
        this.shell(`getprop ${p}`),
      ),
    );
    return { android: release, sdk: Number(sdk), model, maker, serial: serial || null, tv: await this.isTv() };
  }

  // A TV (Android TV, Google TV): driven with the remote's keys, and never put to sleep after a run.
  async isTv() {
    return /true/.test(await this.shell('pm has-feature android.software.leanback').catch(() => ''));
  }

  // → { level, charging, battery }: a device with no battery (a TV) is always on mains.
  async battery() {
    const out = await this.shell('dumpsys battery');
    const val = (k) => new RegExp(`^\\s*${k}: (.*)$`, 'm').exec(out)?.[1]?.trim();
    if (val('present') === 'false' || !val('level')) return { level: null, charging: true, battery: false };
    return {
      level: Number(val('level')),
      charging: ['AC powered', 'USB powered', 'Wireless powered', 'Dock powered'].some((k) => val(k) === 'true'),
      battery: true,
    };
  }

  // 'Awake', 'Asleep' or 'Dozing' (the always-on clock).
  async wakefulness() {
    return /mWakefulness=(\w+)/.exec(await this.shell('dumpsys power'))?.[1] ?? 'unknown';
  }

  // Whether no screen lock is set at all. A swipe lock is passed by dismissing it; a PIN, a
  // pattern or a password stops every run.
  async noLock() {
    return (await this.shell('cmd lock_settings get-disabled')) === 'true';
  }

  async keyguardShowing() {
    return /isKeyguardShowing=true/.test(await this.shell('dumpsys window'));
  }

  // ---------- the server on the device ----------

  async serverOnDevice() {
    const out = await this.shell(`md5sum ${SERVER.onDevice} 2>/dev/null || true`);
    return out.split(/\s+/)[0] || null;
  }

  // Put the pinned server on the device if it is not there already. `file` is the checked copy.
  async putServer(file) {
    const md5 = crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
    if ((await this.serverOnDevice()) === md5) return false;
    await this.adb(['push', file, SERVER.onDevice], { timeoutMs: 120_000 });
    return true;
  }

  async forward() {
    if (this.port) return this.port;
    const list = await this.adb(['forward', '--list']);
    const have = list.split('\n').find((l) => l.startsWith(`${this.serial} `) && l.endsWith(` tcp:${SERVER.port}`));
    this.port = have
      ? Number(have.split(' ')[1].replace('tcp:', ''))
      : Number((await this.adb(['forward', 'tcp:0', `tcp:${SERVER.port}`])).trim());
    return this.port;
  }

  // The key the server on this device was started with: a new one at each start, kept in the
  // plugin's database (routines.js) so that every blackcat process (the agent, a command, a
  // shortcut) has it; held here once read.
  async serverKeyOf({ fresh = false } = {}) {
    if (fresh || this.serverKey === undefined) this.serverKey = (await import('./routines.js')).serverKey(this.ctx, this.serial);
    return this.serverKey;
  }

  // `restart: false`: one that does not take the key is not started again (for ensureServer's own look).
  async call(method, params = [], { timeoutMs = 15_000, restart = true } = {}) {
    const port = await this.forward();
    const ask = async (key) => {
      try {
        return await fetch(`http://127.0.0.1:${port}/jsonrpc/0`, {
          method: 'POST',
          // (No compression: the server's leaks connections with it.)
          headers: { 'content-type': 'application/json', 'accept-encoding': '', [KEY_HEADER]: key ?? '' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        throw new AndroidError(`the server on the device did not answer (${e.cause?.code ?? e.name})`);
      }
    };
    const held = await this.serverKeyOf();
    let res = await ask(held);
    // Turned away: it may have been started again by another blackcat process, with a key this one has not read.
    if (res.status === 401) {
      const now = await this.serverKeyOf({ fresh: true });
      if (now !== held) res = await ask(now);
    }
    // Still turned away: no blackcat process has its key (it was started some other way). It is
    // started again with a new one, here, so that whatever asked goes on as if nothing happened.
    if (res.status === 401 && restart) {
      await this.ensureServer();
      res = await ask(await this.serverKeyOf());
    }
    if (res.status === 401) throw new AndroidError('the server on the device did not take the key');
    let j = await res.json().catch(() => null);
    if (!j) throw new AndroidError(`the server on the device gave no answer to ${method}`);
    // Answering but unable to look at the screen (its link to the system was lost, as when a TV
    // box's HDMI link resets as the TV comes on): started again, and asked once more.
    if (j.error && restart && STUCK.test(j.error.message ?? '')) {
      await this.ensureServer({ stuck: true });
      j = await (await ask(await this.serverKeyOf())).json().catch(() => null);
      if (!j) throw new AndroidError(`the server on the device gave no answer to ${method}`);
    }
    if (j.error) throw new AndroidError(`the server on the device could not ${method}: ${j.error.message}`);
    return j.result;
  }

  // How the server answers a ping carrying `key` (or none): 200, 401, or null for no answer. A
  // ping answers at once, however busy the device's screen is (a TV box playing a video can take
  // seconds over anything that looks at the screen).
  async pinged(key) {
    const port = await this.forward();
    const res = await fetch(`http://127.0.0.1:${port}/ping`, {
      headers: key ? { [KEY_HEADER]: key } : {},
      signal: AbortSignal.timeout(3000),
    }).catch(() => null);
    return res?.status ?? null;
  }

  // Running, blackcat's build, and started with the key that is kept. (An earlier build answers
  // without a key, to anyone on the device's network: it is not taken for this one.)
  async serverAnswers() {
    const key = await this.serverKeyOf({ fresh: true });
    return !!key && (await this.pinged(key)) === 200 && (await this.pinged(null)) === 401;
  }

  // Start the server if it is not running. It keeps running on the device after this process
  // ends, so each command does not pay for starting it; it can be reached only from this machine,
  // through adb, and only with its key. The pinned one is put on the device first if another is
  // there. `file`: the checked copy, when the caller has it already.
  // `stuck`: it answers, but cannot look at the screen: started again all the same.
  async ensureServer({ file, stuck = false } = {}) {
    this.file = file ?? this.file; // (the checked copy, kept for a start again)
    if (!stuck && (await this.serverAnswers())) return;
    // Why it is started, for the record (never its key).
    const key = await this.serverKeyOf();
    const [withKey, without] = [key ? await this.pinged(key) : null, await this.pinged(null)];
    const why = stuck
      ? 'it answered but could not look at the screen'
      : without === 200
        ? 'an earlier build was running, which answered anyone on the network: replaced'
        : withKey === 401 || (without === 401 && !key)
          ? 'the one running did not take the key: started again with a new one'
          : 'it was not running';
    const name =
      (await import('./routines.js')).listDevices(this.ctx).find((d) => (d.address ?? d.serial) === this.serial)?.name ?? this.serial;
    const note = (ok, summary) => recordActivity({ kind: 'event', category: 'android', ok, summary });
    this.file ??= serverFile();
    const put = await this.putServer(this.file);
    // One that is stuck (registered with the system but not answering), or an earlier one, is
    // stopped first, and once more should it not come up.
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.shell(STOP_SERVER);
      const key = crypto.randomBytes(32).toString('hex');
      (await import('./routines.js')).setServerKey(this.ctx, this.serial, key);
      this.serverKey = key;
      await this.shell(START(key));
      let up = false;
      for (let waited = 0; waited < START_WAIT_MS && !up; waited += 250) {
        await sleep(250);
        up = (await this.pinged(key)) === 200;
      }
      if (!up) continue;
      // Up; and able to look at the screen (what can be stuck), which the first time takes a while.
      try {
        await this.call('deviceInfo', [], { timeoutMs: 30_000, restart: false });
        note(true, `screen server started on the ${name} with a new key: ${why}${put ? ' (the pinned build was put on it)' : ''}`);
        return;
      } catch {}
    }
    note(false, `screen server did not start on the ${name} (${why})`);
    throw new AndroidError('the server on the device did not start');
  }

  // ---------- reading and touching ----------

  // The screen as uiautomator's XML. The server drops a call now and then, mostly while the
  // screen is changing, so it is tried three times.
  async dump() {
    for (let i = 0; ; i++) {
      try {
        return await this.call('dumpWindowHierarchy', [false, 50]);
      } catch (e) {
        if (i === 2) throw e;
        await sleep(500);
      }
    }
  }

  // A screenshot saved to `file` (JPEG). The server's own fails on some screens (maps), where
  // adb's screencap works (PNG, slower). `longEdge`: made no longer than this on its long side,
  // whatever the device's own resolution (a phone's 2,280, a 4K TV's 3,840).
  async screenshot(file, { longEdge = null } = {}) {
    let out = null;
    try {
      const b64 = await this.call('takeScreenshot', [1, 80]);
      if (b64) {
        fs.writeFileSync(file, Buffer.from(b64, 'base64'), { mode: 0o600 });
        out = file;
      }
    } catch {
      // fall through to adb
    }
    if (!out) {
      out = file.replace(/\.\w+$/, '.png');
      const tmp = `/data/local/tmp/blackcat-shot-${process.pid}.png`;
      await this.shell(`screencap -p ${tmp}`);
      await this.adb(['pull', tmp, out]);
      fs.chmodSync(out, 0o600);
      await this.shell(`rm -f ${tmp}`);
    }
    if (longEdge) await fit(out, longEdge);
    return out;
  }

  tap(x, y) {
    return this.call('click', [Math.round(x), Math.round(y)]);
  }

  // Into the field that has the focus, replacing what is there (through the clipboard, which
  // takes any language).
  // Into the field that has the focus, replacing what is there. Set as the field's text
  // directly, which goes round the keyboard (its corrections and its suggestions) and is what
  // a search field looks again at. Where that does not take, by the clipboard, which takes any
  // language: what was there taken out with keys too, and the last letter typed as a key.
  async type(text, { had = 40 } = {}) {
    const t = String(text);
    const set = await this.call('setText', [FOCUSED_FIELD, t]).catch(() => false);
    if (set && (await this.focusedText()) === t) return;
    await this.call('clearInputText');
    await this.shell(`input keyevent MOVE_END ${'DEL '.repeat(Math.min(200, had + 2))}`.trim());
    const last = /[A-Za-z0-9]$/.test(t) ? t.at(-1) : null;
    await this.call('setClipboard', ['blackcat', last ? t.slice(0, -1) : t]);
    if (!last || t.length > 1) await this.call('pasteClipboard');
    if (last) await this.shell(`input text ${last}`);
  }

  // Whether the on-screen keyboard is up.
  async keyboardShown() {
    return /mInputShown=true/.test(await this.shell('dumpsys input_method').catch(() => ''));
  }

  // Close the on-screen keyboard if it is up (Back, which then closes only the keyboard). → whether it was.
  async hideKeyboard() {
    if (!(await this.keyboardShown())) return false;
    await this.key('BACK');
    await sleep(300);
    return true;
  }

  // What the field that has the focus holds now.
  async focusedText() {
    const xml = await this.dump().catch(() => '');
    const m = /<node\b[^>]*class="android\.widget\.EditText"[^>]*>/g;
    for (const [tag] of xml.matchAll(m))
      if (/focused="true"/.test(tag))
        return (
          /text="([^"]*)"/
            .exec(tag)?.[1]
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>') ?? ''
        );
    return null;
  }

  key(name) {
    return this.shell(`input keyevent ${name}`);
  }

  async wake() {
    if ((await this.wakefulness()) !== 'Awake') await this.key('WAKEUP');
    if (await this.keyguardShowing()) {
      await this.shell('wm dismiss-keyguard');
      await sleep(500);
      if (await this.keyguardShowing())
        throw new AndroidError('the device is locked with a PIN, pattern or password: set Screen lock to None or Swipe');
    }
  }

  sleep() {
    return this.key('SLEEP');
  }

  // The app whose screen has the focus.
  async foreground() {
    return /mFocusedApp=ActivityRecord\{\S+ \S+ ([\w.]+)\//.exec(await this.shell('dumpsys window'))?.[1] ?? null;
  }

  async setting(ns, key, value) {
    if (!['system', 'global', 'secure'].includes(ns) || !/^[\w.]+$/.test(key) || (value != null && !/^[\w.-]+$/.test(String(value))))
      throw new AndroidError(`not a setting: ${key}`);
    return value == null ? this.shell(`settings get ${ns} ${key}`) : this.shell(`settings put ${ns} ${key} ${value}`);
  }

  async unset(ns, key) {
    if (!['system', 'global', 'secure'].includes(ns) || !/^[\w.]+$/.test(key)) throw new AndroidError(`not a setting: ${key}`);
    await this.shell(`settings delete ${ns} ${key}`);
  }

  async swipe(x1, y1, x2, y2, ms = 300) {
    await this.shell(`input swipe ${[x1, y1, x2, y2, ms].map((n) => Math.round(n)).join(' ')}`);
  }

  // An app's first screen. A TV app may only have the TV's kind of first screen.
  async startApp(pkg) {
    const out = await this.shell(`monkey -p ${pkgOf(pkg)} -c android.intent.category.LAUNCHER 1 2>&1 || true`);
    if (!/No activities found/.test(out)) return;
    const tv = await this.shell(`monkey -p ${pkg} -c android.intent.category.LEANBACK_LAUNCHER 1 2>&1 || true`);
    if (/No activities found/.test(tv)) throw new AndroidError(`${pkg} has no first screen to start`);
  }

  stopApp(pkg) {
    return this.shell(`am force-stop ${pkgOf(pkg)}`);
  }

  async installed(pkg) {
    return (await this.shell(`pm list packages ${pkgOf(pkg)}`)).split('\n').some((l) => l.trim() === `package:${pkg}`);
  }

  async appVersion(pkg) {
    return /versionName=(\S+)/.exec(await this.shell(`dumpsys package ${pkgOf(pkg)} | grep -m1 versionName`))?.[1] ?? null;
  }
}

// The server that comes with the plugin, once it is checked to be the pinned one.
export function serverFile() {
  const ok = fs.existsSync(SERVER.file) && crypto.createHash('sha256').update(fs.readFileSync(SERVER.file)).digest('hex') === SERVER.sha256;
  if (!ok)
    throw new AndroidError(
      `the server that comes with the plugin (${SERVER.file}) is not the expected file: nothing was put on the device`,
    );
  return SERVER.file;
}

// Make a picture no longer than `longEdge` on its long side, in place (smaller ones are left).
export async function fit(file, longEdge) {
  try {
    const { default: sharp } = await import('sharp');
    const img = sharp(file, { failOn: 'none' });
    const { width, height } = await img.metadata();
    if (Math.max(width, height) <= longEdge) return;
    const smaller = img.resize({ width: longEdge, height: longEdge, fit: 'inside' });
    const buf = await (file.endsWith('.png') ? smaller.png() : smaller.jpeg({ quality: 80 })).toBuffer();
    fs.writeFileSync(file, buf, { mode: 0o600 });
  } catch {
    // (left as it is: a larger picture still works)
  }
}
