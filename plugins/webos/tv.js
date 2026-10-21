// An LG webOS TV on the network, through its own control service: JSON requests over a
// WebSocket (encrypted on port 3001, plain on 3000 for older ones). It is paired once, with the
// owner's OK on the TV, and gives a key that is kept as a secret; the remote's buttons go
// through a second socket it hands out. Turning it on is a wake-up packet to its network card,
// which the TV listens for while it is off when "Turn on via Wi-Fi" (or "Mobile TV On") is on.
import dgram from 'node:dgram';
import WebSocket from 'ws';
import { PluginError, sleep } from '../../src/api.js';

export class TvError extends PluginError {}

const PORTS = [
  ['wss', 3001],
  ['ws', 3000],
];
const CONNECT_MS = 5000;
const ANSWER_MS = 8000;
const PAIR_MS = 60_000; // for the owner to see the question on the TV and press OK
const BUTTON_GAP_MS = 250; // between presses: one sent too soon after another can be dropped

// What it asks the TV to allow, as the TV shows it when it asks the owner. (The same list as
// Home Assistant's own LG integration, aiowebostv: what a remote control app asks for.)
const PERMISSIONS = [
  'APP_TO_APP',
  'CLOSE',
  'CONTROL_AUDIO',
  'CONTROL_DISPLAY',
  'CONTROL_INPUT_JOYSTICK',
  'CONTROL_INPUT_MEDIA_PLAYBACK',
  'CONTROL_INPUT_TV',
  'CONTROL_MOUSE_AND_KEYBOARD',
  'CONTROL_POWER',
  'CONTROL_TV_SCREEN',
  'LAUNCH',
  'LAUNCH_WEBAPP',
  'READ_APP_STATUS',
  'READ_CURRENT_CHANNEL',
  'READ_INPUT_DEVICE_LIST',
  'READ_INSTALLED_APPS',
  'READ_NETWORK_STATE',
  'READ_POWER_STATE',
  'READ_RUNNING_APPS',
  'READ_SETTINGS',
  'READ_TV_CHANNEL_LIST',
  'WRITE_NOTIFICATION_TOAST',
];

// The remote's buttons, by the names the TV takes.
export const BUTTONS = [
  'HOME',
  'BACK',
  'EXIT',
  'UP',
  'DOWN',
  'LEFT',
  'RIGHT',
  'ENTER',
  'MENU',
  'QMENU',
  'INFO',
  'GUIDE',
  'LIST',
  'INPUT_HUB',
  'MUTE',
  'VOLUMEUP',
  'VOLUMEDOWN',
  'CHANNELUP',
  'CHANNELDOWN',
  'PLAY',
  'PAUSE',
  'STOP',
  'REWIND',
  'FASTFORWARD',
  'RED',
  'GREEN',
  'YELLOW',
  'BLUE',
  'DASH',
  'ASTERISK',
  ...'0123456789',
];

// A WebSocket to the TV, open. `cert`: given the TV's certificate, when it has one.
function socket(url, cert) {
  return new Promise((resolve, reject) => {
    // (Its certificate is its own, signed by LG, not one this machine can check: it is compared
    // with the one seen at pairing instead.)
    const ws = new WebSocket(url, { rejectUnauthorized: false, handshakeTimeout: CONNECT_MS });
    ws.once('upgrade', (res) => cert?.(res.socket.getPeerCertificate?.()?.fingerprint256 ?? null));
    ws.once('open', () => {
      ws.on('error', () => {}); // (a connection that breaks later closes, and what waits is told)
      resolve(ws);
    });
    ws.once('error', reject);
  });
}

export class Tv {
  // `key`: the key it gave at pairing. `pin`: its certificate's fingerprint then. `ports`: for tests.
  constructor(host, { key = null, pin = null, ports = PORTS } = {}) {
    Object.assign(this, { host, key, pin, ports, n: 0, waiting: new Map(), cert: null, ws: null, input: null });
  }

  async open() {
    let why = null;
    for (const [scheme, port] of this.ports) {
      try {
        this.ws = await socket(`${scheme}://${this.host}:${port}`, (fp) => (this.cert = fp));
        break;
      } catch (e) {
        why = e.code ?? e.message;
      }
    }
    if (!this.ws) throw new TvError(`The TV at ${this.host} does not answer (${why}): is it on, and on this network?`);
    // (Paired over the encrypted connection, it answers on it again, with the same certificate.)
    if (this.pin && this.cert !== this.pin) {
      await this.close();
      throw new TvError(
        `Something else answers at ${this.host}: its certificate is not the one the TV had when it was paired. If the TV's software was updated, pair it again.`,
      );
    }
    this.ws.on('message', (raw) => {
      let m;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      this.waiting.get(m.id)?.(m);
    });
    this.ws.on('close', () => {
      for (const done of [...this.waiting.values()]) done({ type: 'error', error: 'the TV closed the connection' });
    });
    return this;
  }

  // One message, and its answer. `onPrompt`: the TV is asking the owner (pairing).
  send(type, uri, payload, { ms = ANSWER_MS, onPrompt } = {}) {
    const id = `${type}_${++this.n}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new TvError(`The TV did not answer ${uri ?? type} in time.`));
      }, ms);
      this.waiting.set(id, (m) => {
        if (type === 'register' && m.type === 'response' && m.payload?.pairingType) {
          try {
            onPrompt?.();
            return;
          } catch (e) {
            m = { type: 'error', error: e.message };
          }
        }
        clearTimeout(timer);
        this.waiting.delete(id);
        if (m.type === 'error') reject(new TvError(said(m.error, uri)));
        else resolve(m);
      });
      this.ws.send(JSON.stringify({ id, type, ...(uri ? { uri: `ssap://${uri}` } : {}), payload }));
    });
  }

  // Signed in with the key it gave at pairing; or, with none, paired: the TV asks the owner,
  // and `onPrompt` is told. → the key. `ask: false`: a TV that asks (it does not know the key)
  // is a failure, not a wait for someone to press OK.
  async register({ onPrompt, ask = true } = {}) {
    const m = await this.send(
      'register',
      null,
      {
        forcePairing: false,
        pairingType: 'PROMPT',
        manifest: { manifestVersion: 1, appVersion: '1.1', permissions: PERMISSIONS },
        ...(this.key ? { 'client-key': this.key } : {}),
      },
      {
        ms: ask ? PAIR_MS : ANSWER_MS,
        onPrompt: ask
          ? onPrompt
          : () => {
              throw new Error('it no longer knows this machine');
            },
      },
    );
    const key = m.payload?.['client-key'];
    if (m.type !== 'registered' || !key) throw new TvError('The TV did not pair.');
    this.key = key;
    return key;
  }

  // A request to one of its services. → what it answered.
  async request(uri, payload = {}) {
    const m = await this.send('request', uri, payload);
    const p = m.payload ?? {};
    if (p.returnValue === false) throw new TvError(said(p.errorText ?? p.errorCode ?? 'it said no', uri));
    return p;
  }

  // The remote's buttons, one after another.
  async press(names) {
    if (!this.input) {
      const { socketPath } = await this.request('com.webos.service.networkinput/getPointerInputSocket');
      this.input = await socket(socketPath);
    }
    for (const [k, name] of names.entries()) {
      if (k) await sleep(BUTTON_GAP_MS);
      this.input.send(`type:button\nname:${name}\n\n`);
    }
    await sleep(BUTTON_GAP_MS); // (sent before the socket is closed)
  }

  // Said goodbye to, so that the TV lets go of the session (one cut off is kept open on the TV
  // for a while, and after a few of those it closes new connections at once); cut off when it
  // does not answer that in a second.
  async close() {
    const open = [this.input, this.ws].filter((ws) => ws && ws.readyState !== WebSocket.CLOSED);
    this.input = this.ws = null;
    await Promise.all(
      open.map(
        (ws) =>
          new Promise((done) => {
            const cut = setTimeout(() => (ws.terminate(), done()), 1000);
            ws.once('close', () => (clearTimeout(cut), done()));
            ws.close();
          }),
      ),
    );
  }
}

const said = (error, uri) =>
  /^404\b/.test(String(error)) ? `This TV does not have ${uri}.` : `The TV said: ${String(error).replace(/^\d{3}\s+/, '')}.`;

// Signed in to a paired TV, for `fn(tv)`, and closed after, whatever happens.
export async function withTv(host, { key, pin, ports }, fn) {
  const tv = await new Tv(host, { key, pin, ports }).open();
  try {
    try {
      await tv.register({ ask: false });
    } catch (e) {
      // (One turning off, or just turned on, takes a connection and then drops it, or never
      // answers on it: that is a TV not answering yet, not one that no longer knows this machine.)
      if (/closed the connection|did not answer/.test(e.message))
        throw new TvError(`The TV at ${host} does not answer yet: it is turning off or on.`);
      throw new TvError(`The TV at ${host} did not let this machine in (${e.message.replace(/\.$/, '')}): pair it again.`);
    }
    return await fn(tv);
  } finally {
    await tv.close();
  }
}

// Whether it is on, as it says: 'on', 'screen off', 'turning off' (it still says Active while it
// shows its logo going off), 'standby', or null when it does not say (an older TV).
export async function powerState(tv) {
  const p = await tv.request('com.webos.service.tvpower/power/getPowerState').catch(() => null);
  if (!p?.state) return null;
  if (/power off/i.test(p.processing ?? '')) return 'turning off';
  return { Active: 'on', 'Screen Off': 'screen off', 'Active Standby': 'standby', Suspend: 'standby' }[p.state] ?? p.state.toLowerCase();
}

export const MAC = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;

// The wake-up packet for a network card: six 0xFF bytes, then its address sixteen times, sent to
// everyone on the network (and to the TV's own address, for a network that drops broadcasts).
export function magic(mac) {
  if (!MAC.test(mac)) throw new TvError(`"${mac}" is not a network card's address (like 58:96:0a:77:df:aa).`);
  const card = Buffer.from(mac.split(/[:-]/).map((b) => parseInt(b, 16)));
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(card)]);
}

export async function wake(mac, host) {
  const packet = magic(mac);
  const s = dgram.createSocket('udp4');
  try {
    await new Promise((ok, no) => {
      s.once('error', no);
      s.bind(ok);
    });
    s.setBroadcast(true);
    for (const to of ['255.255.255.255', host]) await new Promise((ok) => s.send(packet, 9, to, () => ok()));
  } finally {
    s.close();
  }
}
