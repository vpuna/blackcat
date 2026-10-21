// The webos plugin against a stand-in TV: a WebSocket server that answers as a webOS TV does
// (pairing with a question on the screen, its services, the socket for the remote's buttons).
import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { home } from './helpers.js';

home();
const { Tv, withTv, magic } = await import('../plugins/webos/tv.js');
const manifest = (await import('../plugins/webos/plugin.js')).default;
const { buttons } = await import('../plugins/webos/plugin.js');

// ---------- a stand-in TV ----------

function fakeTv({ output = 'external_arc', power = 'Active' } = {}) {
  const tv = { key: 'K1', asked: 0, calls: [], pressed: [], volume: 12, muted: false, input: 'HDMI_1', power, output };
  const inputs = [
    { id: 'HDMI_1', label: 'Media Player', appId: 'com.webos.app.hdmi1', connected: true },
    { id: 'HDMI_2', label: 'Cable Box', appId: 'com.webos.app.hdmi2', connected: true },
    { id: 'HDMI_3', label: 'HDMI 3', appId: 'com.webos.app.hdmi3', connected: false },
  ];
  const apps = [
    { id: 'netflix', title: 'Netflix' },
    { id: 'youtube.leanback.v4', title: 'YouTube' },
  ];
  const answers = {
    'com.webos.service.tvpower/power/getPowerState': () => ({ state: tv.power, ...(tv.processing ? { processing: tv.processing } : {}) }),
    'com.webos.applicationManager/getForegroundAppInfo': () => ({ appId: inputs.find((x) => x.id === tv.input)?.appId ?? tv.input }),
    'tv/getExternalInputList': () => ({ devices: inputs }),
    'com.webos.applicationManager/listLaunchPoints': () => ({ launchPoints: apps }),
    'audio/getVolume': () => ({ volumeStatus: { volume: tv.volume, muteStatus: tv.muted, soundOutput: tv.output } }),
    'audio/volumeUp': () => (tv.volume++, {}),
    'audio/volumeDown': () => (tv.volume--, {}),
    'audio/setMute': (p) => ((tv.muted = p.mute), {}),
    'audio/setVolume': (p) => ((tv.volume = p.volume), {}),
    'tv/switchInput': (p) => ((tv.input = p.inputId), {}),
    'com.webos.applicationManager/launch': (p) => ((tv.input = p.id), {}),
    'system.notifications/createToast': (p) => ((tv.toast = p.message), {}),
    'system/turnOff': () => ((tv.power = 'Suspend'), {}),
    'system/getSystemInfo': () => ({ modelName: 'OLED55TEST' }),
    'com.webos.service.networkinput/getPointerInputSocket': () => ({ socketPath: `ws://127.0.0.1:${tv.port}/input` }),
  };
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  server.on('connection', (ws, req) => {
    if (req.url === '/input') return ws.on('message', (m) => tv.pressed.push(/name:(\w+)/.exec(String(m))[1]));
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      const answer = (x) => ws.send(JSON.stringify({ id: m.id, ...x }));
      if (m.type === 'register') {
        if (tv.dropping) return ws.terminate(); // (a TV turning off takes a connection and drops it)
        if (m.payload['client-key'] === tv.key) return answer({ type: 'registered', payload: { 'client-key': tv.key } });
        tv.asked++;
        answer({ type: 'response', payload: { pairingType: 'PROMPT', returnValue: true } });
        return setTimeout(
          () =>
            answer(
              tv.refuse ? { type: 'error', error: '403 User denied access' } : { type: 'registered', payload: { 'client-key': tv.key } },
            ),
          50,
        );
      }
      const uri = m.uri.replace('ssap://', '');
      tv.calls.push(uri);
      const f = answers[uri];
      answer(
        f
          ? { type: 'response', payload: { returnValue: true, ...f(m.payload ?? {}) } }
          : { type: 'error', error: '404 no such service or method' },
      );
    });
  });
  return new Promise((ok) =>
    server.on('listening', () => ok(Object.assign(tv, { port: server.address().port, close: () => server.close() }))),
  );
}

const secrets = new Map();
const store = new Map();
const ctx = {
  secrets: { get: (k) => secrets.get(k), set: (k, v) => secrets.set(k, v), delete: (k) => secrets.delete(k), has: (k) => secrets.has(k) },
  store: { get: (k) => store.get(k), set: (k, v) => store.set(k, v), update: (k, f) => (store.set(k, f(store.get(k))), store.get(k)) },
  config: { get: () => ({}), set: () => {} },
  fail: (m) => {
    throw new Error(m);
  },
};
const run = (cmd, input = {}) => manifest.commands[cmd].run(ctx, input);
const paired = (tv, name = 'tv', extra = {}) => {
  secrets.set(`key:${name}`, tv.key);
  store.set('devices', {
    ...(store.get('devices') ?? {}),
    [name]: { name, host: '127.0.0.1', mac: '58:96:0a:77:df:aa', model: 'OLED55TEST', ports: [['ws', tv.port]], ...extra },
  });
};

// ---------- tests ----------

test('pairing: the TV asks the owner, and the key it gives lets this machine in after', async () => {
  const tv = await fakeTv();
  try {
    const t = await new Tv('127.0.0.1', { ports: [['ws', tv.port]] }).open();
    let prompted = 0;
    const key = await t.register({ onPrompt: () => prompted++ });
    await t.close();
    assert.equal(key, 'K1');
    assert.equal(prompted, 1, 'the owner was asked on the TV');
    const power = await withTv('127.0.0.1', { key, ports: [['ws', tv.port]] }, (x) =>
      x.request('com.webos.service.tvpower/power/getPowerState'),
    );
    assert.equal(power.state, 'Active');
    assert.equal(tv.asked, 1, 'not asked again');
    // A key the TV no longer knows is a failure, not a question left on the screen.
    await assert.rejects(
      withTv('127.0.0.1', { key: 'old', ports: [['ws', tv.port]] }, () => {}),
      /did not let this machine in.*pair it again/,
    );
    // Paired over the encrypted connection, a TV answering without its certificate is refused.
    await assert.rejects(
      withTv('127.0.0.1', { key, pin: 'AB:CD', ports: [['ws', tv.port]] }, () => {}),
      /Something else answers/,
    );
    tv.refuse = true;
    const u = await new Tv('127.0.0.1', { ports: [['ws', tv.port]] }).open();
    await assert.rejects(u.register(), /User denied access/);
    await u.close();
  } finally {
    tv.close();
  }
});

test('what a TV is doing, and the volume: steps go to a sound bar on ARC, a level only to its own speakers', async () => {
  const tv = await fakeTv();
  try {
    paired(tv);
    const s = await run('status');
    assert.match(s.text, /The tv \(OLED55TEST\) is on · showing Media Player · sound to a sound bar or receiver on HDMI ARC/);
    assert.doesNotMatch(s.text, /volume 12/, 'no level is said for a sound bar');
    const up = await run('volume', { how: 'up', steps: '3' });
    assert.equal(tv.calls.filter((c) => c === 'audio/volumeUp').length, 3);
    assert.match(up.text, /Volume up 3 steps on the tv \(to a sound bar/);
    await assert.rejects(run('volume', { how: '20' }), /cannot set or read.*steps instead/);
    await run('volume', { how: 'mute' });
    assert.equal(tv.muted, true);
    await assert.rejects(run('volume', { how: 'up', steps: '500' }), /1 to 50/);
    tv.output = 'tv_speaker';
    const set = await run('volume', { how: '20' });
    assert.equal(tv.volume, 20);
    assert.match(set.text, /set to 20 on the tv: it is at 20, muted/);
  } finally {
    tv.close();
  }
});

test('inputs and apps are chosen by a few words of their names; the remote by its buttons, a number by its digits', async () => {
  const tv = await fakeTv();
  try {
    paired(tv);
    assert.equal((await run('input', { name: [] })).data.length, 3, 'with no name, the inputs');
    const r = await run('input', { name: ['cable', 'box'] });
    assert.equal(tv.input, 'HDMI_2');
    assert.match(r.text, /on Cable Box/);
    await run('input', { name: ['hdmi', '3'] });
    assert.equal(tv.input, 'HDMI_3');
    await assert.rejects(run('input', { name: ['hdmi'] }), /could be any of/);
    await assert.rejects(run('input', { name: ['xbox'] }), /No input is called "xbox"/);
    await run('launch', { app: ['netflix'] });
    assert.equal(tv.input, 'netflix');
    await run('button', { names: ['105', 'enter'] });
    assert.deepEqual(tv.pressed, ['1', '0', '5', 'ENTER']);
    await run('notify', { text: ['Dinner', 'is', 'ready'] });
    assert.equal(tv.toast, 'Dinner is ready');
    await run('off');
    assert.equal(tv.power, 'Suspend');
  } finally {
    tv.close();
  }
});

test('several TVs: each by its name, and one that is off is said to be off', async () => {
  const a = await fakeTv();
  try {
    store.clear();
    paired(a, 'tv');
    store.set('devices', { ...store.get('devices'), bedroom: { name: 'bedroom', host: '127.0.0.1', model: 'LG', ports: [['ws', 1]] } });
    secrets.set('key:bedroom', 'K1');
    await assert.rejects(run('status'), /Which TV\? Add --on bedroom or --on tv/);
    assert.match((await run('status', { on: 'tv' })).text, /is on/);
    const off = await run('status', { on: 'bedroom' });
    assert.equal(off.data.on, false);
    assert.match(off.text, /does not answer: it is off/);
    await assert.rejects(run('on', { on: 'bedroom' }), /cannot turn it on/, 'no network card known');
    assert.match((await run('on', { on: 'tv' })).text, /on already/);
  } finally {
    a.close();
    store.clear();
  }
});

test('what the agent may do: look freely, change only when asked', () => {
  store.set('devices', { tv: { name: 'tv', host: '127.0.0.1', model: 'LG' } });
  const access = (cmd, words) => {
    const a = manifest.commands[cmd].access;
    return typeof a === 'function' ? a(ctx, words) : { level: a };
  };
  assert.equal(access('status', []).level, 'allow');
  assert.equal(access('input', []).level, 'allow', 'listing the inputs');
  assert.deepEqual(access('input', ['shield']), { level: 'ask', describe: 'switch to shield on the tv' });
  assert.equal(access('volume', ['up', '5', '--on', 'tv']).describe, 'volume up 5 on the tv');
  assert.equal(access('pair', []).level, 'owner');
  store.clear();
});

test('the buttons named, and the wake-up packet', () => {
  assert.deepEqual(buttons(['home', '12', 'channelup', 'input-hub']), ['HOME', '1', '2', 'CHANNELUP', 'INPUT_HUB']);
  assert.throws(() => buttons(['explode']), /is not a button/);
  assert.throws(() => buttons([]), /Name a button/);
  const m = magic('58:96:0a:77:df:aa');
  assert.equal(m.length, 102);
  assert.ok(m.subarray(0, 6).every((b) => b === 0xff));
  assert.deepEqual([...m.subarray(6, 12)], [0x58, 0x96, 0x0a, 0x77, 0xdf, 0xaa]);
  assert.throws(() => magic('not-a-mac'), /not a network card/);
});

test('the wake-up packet is sent, not refused for want of an answer', async () => {
  const { wake } = await import('../plugins/webos/tv.js');
  await wake('58:96:0a:77:df:aa', '127.0.0.1');
  await assert.rejects(wake('nope', '127.0.0.1'), /not a network card/);
});

test('a check passes only once the TV is as said, waiting for it when told to', async () => {
  const tv = await fakeTv();
  try {
    store.clear();
    paired(tv);
    assert.match((await run('check', { power: 'on', input: 'media' })).text, /is on, showing Media Player/);
    await assert.rejects(run('check', { input: 'cable' }), /is on Media Player, not Cable Box/);
    setTimeout(() => (tv.input = 'HDMI_2'), 1200);
    const later = await run('check', { input: 'cable', wait: '5' });
    assert.ok(later.data.seconds >= 1, 'it waited for the input to change');
    await assert.rejects(run('check', { app: 'netflix' }), /showing Cable Box, not Netflix/);
    await assert.rejects(run('check', { power: 'off' }), /is on/);
    await assert.rejects(run('check', {}), /Say what to check/);
    await assert.rejects(run('check', { power: 'off', input: 'media' }), /check --power off alone/);
    // A TV that does not answer is off.
    store.set('devices', { tv: { ...store.get('devices').tv, ports: [['ws', 1]] } });
    assert.match((await run('check', { power: 'off' })).text, /is off/);
    await assert.rejects(run('check', { power: 'on', wait: '1' }), /is off, after 1s/);
  } finally {
    tv.close();
    store.clear();
  }
});

test('a TV turning off is not taken for one that is on, nor one that drops the connection for one to pair again', async () => {
  const tv = await fakeTv();
  try {
    store.clear();
    paired(tv);
    tv.processing = 'Request Power Off Logo'; // (it still says Active while its logo goes off)
    assert.match((await run('status')).text, /is turning off/);
    await assert.rejects(run('check', { power: 'on' }), /is turning off/);
    tv.processing = null;
    tv.dropping = true;
    const s = await run('status');
    assert.equal(s.data.on, false);
    await assert.rejects(run('check', { power: 'on' }), /is off/);
    tv.dropping = false;
    assert.match((await run('on')).text, /on already/);
  } finally {
    tv.close();
    store.clear();
  }
});
