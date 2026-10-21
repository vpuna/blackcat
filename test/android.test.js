// The android plugin without a device: screens made up as uiautomator's XML, and a stand-in
// device that moves between them when something is tapped or a remote's key is pressed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { home } from './helpers.js';

const dir = home();
const { parse, find, elements, labelOf } = await import('../plugins/android/screen.js');
const { validate, withParams, saveApp, saveRoutine, recordRun, loadRoutine, saveDevice, listDevices, getDevice } =
  await import('../plugins/android/routines.js');
const { Runner, StepFailed, session } = await import('../plugins/android/runner.js');
const manifest = (await import('../plugins/android/plugin.js')).default;

// ---------- made-up screens ----------

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const node = (e, i) => {
  const [x1, y1] = e.at ?? [40, 100 + i * 150];
  const [w, h] = e.size ?? [600, 120];
  const attrs = {
    index: i,
    text: e.text ?? '',
    'resource-id': e.id ? `com.example.rides:id/${e.id}` : '',
    class: e.field ? 'android.widget.EditText' : 'android.widget.TextView',
    package: e.pkg ?? 'com.example.rides',
    'content-desc': e.desc ?? '',
    clickable: e.tap === false ? 'false' : 'true',
    selected: e.selected ? 'true' : 'false',
    focused: e.focused ? 'true' : 'false',
    bounds: `[${x1},${y1}][${x1 + w},${y1 + h}]`,
  };
  const inner = (e.children ?? []).map((c, k) => node(c, i * 10 + k)).join('');
  return `<node ${Object.entries(attrs)
    .map(([k, v]) => `${k}="${esc(v)}"`)
    .join(' ')}${inner ? `>${inner}</node>` : ' />'}`;
};
const xml = (els) =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">${els.map(node).join('')}</hierarchy>`;

// A ride app: home → search → choose a car → the confirmation screen.
const SCREENS = {
  home: { els: [{ text: 'Rides' }, { text: 'Food' }], go: { Rides: 'search' } },
  search: {
    els: [
      { id: 'field_search', text: 'Pickup Home', field: true },
      { text: 'Central Station', children: [{ text: 'Main St, Old Town', tap: false }] },
    ],
    go: { 'Central Station': 'cars' },
  },
  cars: {
    els: [
      { desc: 'Comfort', size: [240, 260], at: [40, 100] },
      { desc: 'Large', size: [140, 140], at: [320, 100] },
      { text: 'Comfort', tap: false, at: [40, 400], size: [200, 60] },
      { text: '⃎ 61 - 78', tap: false, at: [300, 400], size: [200, 60] },
      { text: 'Central Station', tap: false, at: [40, 600] },
      { text: 'Book now', at: [40, 800] },
    ],
    go: { 'Book now': 'booked' },
  },
  booked: { els: [{ text: 'Your driver is on the way', tap: false }] },
  rating: { els: [{ text: 'How was your trip?', tap: false }, { text: 'Skip' }], go: { Skip: 'home' } },
};

class FakeDevice {
  constructor(start = 'home', screens = SCREENS) {
    Object.assign(this, { at: start, screens, taps: [], typed: [], keys: [], stopped: 0 });
  }
  async dump() {
    return xml(this.screens[this.at].els);
  }
  async tap(x, y) {
    const root = parse(await this.dump());
    const hit = elements(root).find((e) => x >= e.bounds[0] && x <= e.bounds[2] && y >= e.bounds[1] && y <= e.bounds[3]);
    const label = hit ? (hit.text ?? hit.description ?? hit.label) : null;
    this.taps.push(label);
    if (this.lose > 0) return void this.lose--; // (an app still starting: the tap does nothing)
    const to = this.screens[this.at].go?.[label];
    if (to) this.at = to;
  }
  async type(t) {
    this.typed.push(t);
  }
  async key(k) {
    this.keys.push(k);
    const to = this.screens[this.at].keys?.[k];
    if (to) this.at = to;
  }
  async screenshot(file) {
    fs.writeFileSync(file, 'picture');
    return file;
  }
  async stopApp() {
    this.stopped++;
  }
  async swipe() {}
  async shell(cmd) {
    (this.shells ??= []).push(cmd);
    return '';
  }
}

const APP = {
  package: 'com.example.rides',
  popups: [{ when: { text: 'How was your trip?' }, tap: { text: 'Skip' } }],
  commit: ['Book now'],
};
const ROUTINE = {
  name: 'ride',
  app: 'com.example.rides',
  params: { to: { summary: 'where to' } },
  steps: [
    { do: 'tap', target: { text: 'Rides' } },
    { do: 'check', target: { resourceId: 'field_search' }, text_contains: 'Home' },
    { do: 'type', text: '{{to}}' },
    { do: 'tap', target: { textContains: '{{to}}' } },
    {
      do: 'choose',
      option: { description: 'Comfort' },
      options: [{ description: 'Comfort' }, { description: 'Large' }],
      chosen_by: 'larger',
    },
    {
      do: 'confirm',
      button: { text: 'Book now' },
      must_show: [{ text: 'Comfort' }, { text: '{{to}}' }],
      read: { Price: { row_of: { text: 'Comfort' }, pattern: '⃎\\s*[\\d.]+(\\s*-\\s*[\\d.]+)?' } },
    },
  ],
};
const media = path.join(dir, 'media');
fs.mkdirSync(media);
const runWith = (ph, answer, routine = withParams(ROUTINE, { to: 'Central Station' })) =>
  new Runner(ph, routine, APP, { answer: async (a) => (typeof answer === 'function' ? answer(a) : answer), media }).run();

// ---------- reading a screen ----------

test('a screen is read as elements with their words, ids and places, entities decoded', () => {
  const root = parse(xml([{ text: 'Fish & chips', id: 'title' }, { children: [{ text: 'Open', tap: false }] }]));
  assert.equal(find(root, { text: 'Fish & chips' }).length, 1);
  assert.equal(find(root, { resourceId: 'title' }).length, 1, 'an id matches without its package');
  assert.equal(find(root, { textContains: 'chips' }).length, 1);
  const els = elements(root);
  assert.equal(els.find((e) => e.label)?.label, 'Open', 'a button with no words of its own is named by its child');
  assert.equal(labelOf(find(root, { textContains: 'Fish' })[0]), 'Fish & chips');
});

test('instance picks the n-th of several matches, in screen order', () => {
  const root = parse(xml([{ text: 'Go' }, { text: 'Go' }]));
  assert.equal(find(root, { text: 'Go', instance: 1 })[0].bounds[1], 250);
});

// ---------- routines ----------

test('a routine may not press a button that books, pays or sends anywhere but its confirmation step', () => {
  const bad = { ...ROUTINE, steps: [{ do: 'tap', target: { text: 'book now' } }, ...ROUTINE.steps] };
  assert.match(validate(bad, APP).join('\n'), /taps "book now", which books, pays or sends/);
  assert.deepEqual(validate(ROUTINE, APP), []);
  // A tile whose label only contains the word is not the button.
  const tile = { ...ROUTINE, steps: [{ do: 'tap', target: { text: 'Book now for later' } }, ...ROUTINE.steps] };
  assert.deepEqual(validate(tile, APP), []);
});

test('an app that takes money needs a confirmation step, last, and only one', () => {
  const none = { ...ROUTINE, params: undefined, steps: [{ do: 'tap', target: { text: 'Rides' } }] };
  assert.match(validate(none, APP).join('\n'), /ends with a confirmation step/);
  assert.deepEqual(validate(none, { ...APP, commit: [] }), [], 'an app with nothing to pay is fine without one');
  const after = { ...ROUTINE, steps: [...ROUTINE.steps, { do: 'back' }] };
  assert.match(validate(after, APP).join('\n'), /nothing may come after the confirmation step/);
});

test('every {{value}} is declared and every declared value is used', () => {
  assert.match(validate({ ...ROUTINE, params: {} }, APP).join('\n'), /\{\{to\}\} is used but not in "params"/);
  assert.match(validate({ ...ROUTINE, params: { to: {}, from: {} } }, APP).join('\n'), /from is never used/);
});

test('values are filled in, must be given, must be known, and are one line', () => {
  const r = withParams(ROUTINE, { to: 'Central Station' });
  assert.equal(r.steps[2].text, 'Central Station');
  assert.deepEqual(r.steps[5].must_show[1], { text: 'Central Station' });
  assert.throws(() => withParams(ROUTINE, {}), /needs to/);
  assert.throws(() => withParams(ROUTINE, { to: 'x', speed: 'fast' }), /has no speed/);
  assert.throws(() => withParams(ROUTINE, { to: 'a\nb' }), /one line/);
});

// ---------- running one ----------

test('the button is pressed only on Confirm, after the facts are read off the screen', async () => {
  const ph = new FakeDevice();
  let seen;
  const r = await runWith(ph, (a) => ((seen = a), 'confirm'));
  assert.equal(r.outcome, 'confirmed');
  assert.equal(seen.values.Price, 'AED 61 - 78', 'the new dirham sign is written as letters');
  assert.ok(fs.existsSync(seen.shot), 'a picture of the confirmation screen is taken');
  assert.deepEqual(ph.taps, ['Rides', 'Central Station', 'Book now']);
  assert.equal(ph.at, 'booked');
  assert.deepEqual(ph.typed, ['Central Station']);
});

test('Cancel, no answer, or a dry run never press it, and the app is closed', async () => {
  for (const answer of ['cancel', 'timeout', 'declined']) {
    const ph = new FakeDevice();
    const r = await runWith(ph, answer);
    assert.equal(r.outcome, answer === 'timeout' ? 'expired' : 'cancelled');
    assert.ok(!ph.taps.includes('Book now'), `${answer}: not pressed`);
    assert.equal(ph.stopped, 1, `${answer}: the app is closed`);
  }
});

test('a screen that is not the confirmation screen stops the run, with a picture', async () => {
  const ph = new FakeDevice();
  const r = withParams(ROUTINE, { to: 'Central Station' });
  r.steps[5] = { ...r.steps[5], must_show: [{ text: 'Somewhere else' }] };
  await assert.rejects(runWith(ph, 'confirm', r), (e) => e instanceof StepFailed && /missing "Somewhere else"/.test(e.message) && !!e.shot);
  assert.ok(!ph.taps.includes('Book now'));
});

test('a step whose element never shows fails with what it looked for', async () => {
  const ph = new FakeDevice();
  const r = { ...withParams(ROUTINE, { to: 'Central Station' }) };
  r.steps = [{ do: 'tap', target: { text: 'Groceries' }, wait: 0.2, why: 'the shop' }, ...r.steps];
  await assert.rejects(runWith(ph, 'confirm', r), /Step 1 failed: "Groceries" did not show \(the shop\)/);
});

test('a known pop-up in the way is cleared while a step waits', async () => {
  const ph = new FakeDevice('rating');
  assert.equal((await runWith(ph, 'cancel')).outcome, 'cancelled');
  assert.equal(ph.taps[0], 'Skip');
});

test('a tap that lands on a button that books, pays or sends is refused at run time too', async () => {
  const screens = { ...SCREENS, home: { els: [{ id: 'go', text: 'Book now' }], go: { 'Book now': 'booked' } } };
  const ph = new FakeDevice('home', screens);
  const r = {
    name: 'sneaky',
    app: APP.package,
    steps: [
      { do: 'tap', target: { resourceId: 'go' } },
      { do: 'confirm', button: { text: 'x' } },
    ],
  };
  await assert.rejects(runWith(ph, 'confirm', r), /"Book now" books, pays or sends/);
  assert.deepEqual(ph.taps, []);
});

test('an option already chosen is left alone; another is tapped', async () => {
  const ph = new FakeDevice('cars');
  const r = {
    name: 'pick',
    app: APP.package,
    steps: [
      {
        do: 'choose',
        option: { description: 'Large' },
        options: [{ description: 'Comfort' }, { description: 'Large' }],
        chosen_by: 'larger',
      },
    ],
  };
  await runWith(ph, 'cancel', r);
  assert.deepEqual(ph.taps, ['Large']);
  const ph2 = new FakeDevice('cars');
  await runWith(ph2, 'cancel', { ...r, steps: [{ ...r.steps[0], option: { description: 'Comfort' } }] });
  assert.deepEqual(ph2.taps, [], 'the larger one is the chosen one');
});

// ---------- what the agent may do ----------

const store = new Map();
const ctx = {
  dataDir: path.join(dir, 'data/plugins/android'),
  config: { get: () => ({}), set: () => {} },
  store: {
    get: (k) => store.get(k),
    set: (k, v) => store.set(k, v),
    delete: (k) => store.delete(k),
    update: (k, f) => (store.set(k, f(store.get(k))), store.get(k)),
  },
  fail: (m) => {
    throw new Error(m);
  },
};
const access = (words) => manifest.commands.run.access(ctx, words);

test('the agent runs only an approved routine, without asking first, since its confirmation step asks', async () => {
  fs.mkdirSync(ctx.dataDir, { recursive: true });
  saveApp(ctx, APP);
  saveRoutine(ctx, ROUTINE);
  assert.equal(access(['ride']).level, 'never', 'a draft');
  assert.equal(access(['nothing']).level, 'never');
  assert.equal(access(['ride', '--dry']).level, 'allow', 'trying one to its confirmation screen');
  assert.equal(access(['--on', 'phone', 'ride', '--dry']).level, 'allow', 'the device named is not taken for the routine');
  assert.throws(() => manifest.commands.approve.run(ctx, { name: 'ride' }), /Run it to its confirmation screen first/);
  recordRun(ctx, ROUTINE, { outcome: 'failed', step: '3', dry: true });
  assert.throws(
    () => manifest.commands.approve.run(ctx, { name: 'ride' }),
    /Run it to its confirmation screen first/,
    'a run that failed is not enough',
  );
  recordRun(ctx, ROUTINE, { outcome: 'declined', seconds: 18, dry: true, values: { Price: 'AED 61' } });
  manifest.commands.approve.run(ctx, { name: 'ride' });
  assert.equal(access(['ride', '--set', 'to=Central Station']).level, 'allow');
  // Replaced from a file with a change only to what is looked at after the press: still approved, and said so.
  const looked = path.join(dir, 'looked.json');
  const confirm = ROUTINE.steps.at(-1);
  fs.writeFileSync(
    looked,
    JSON.stringify({
      ...ROUTINE,
      steps: [...ROUTINE.steps.slice(0, -1), { ...confirm, result: { waiting: { textContains: 'Finding' } } }],
    }),
  );
  assert.match(await manifest.commands.add.run(ctx, { file: looked }), /stays approved/);
  assert.equal(access(['ride']).level, 'allow');
  saveRoutine(ctx, ROUTINE);
  // Edited after it was approved: a draft again.
  saveRoutine(ctx, { ...ROUTINE, goal: 'changed' });
  assert.equal(access(['ride']).level, 'never');
  assert.equal(manifest.commands.list.run(ctx).data[0].state, 'edited since it was approved');
});

test('a routine with nothing to confirm is asked about each time', () => {
  const plain = { name: 'wifi', app: 'com.example.rides', steps: [{ do: 'tap', target: { text: 'Rides' } }] };
  saveApp(ctx, { ...APP, commit: [] });
  saveRoutine(ctx, plain);
  // (With nothing to confirm, a dry run goes to its end: that is what approving needs.)
  assert.throws(() => manifest.commands.approve.run(ctx, { name: 'wifi' }), /Run it to its end first/);
  recordRun(ctx, plain, { outcome: 'finished', dry: true });
  manifest.commands.approve.run(ctx, { name: 'wifi' });
  assert.deepEqual(access(['wifi']), { level: 'ask', once: true, describe: 'go through "wifi" on the device' });
});

test("routines are kept in the plugin's own database, and what is saved is checked first", () => {
  assert.ok(fs.existsSync(path.join(ctx.dataDir, 'android.db')));
  assert.equal(loadRoutine(ctx, 'wifi').steps.length, 1);
  const file = path.join(dir, 'bad.json');
  fs.writeFileSync(file, JSON.stringify({ ...ROUTINE, name: 'bad', steps: [{ do: 'fly' }] }));
  assert.throws(() => manifest.commands.add.run(ctx, { file }), /Not added[\s\S]*"do" is one of/);
  fs.writeFileSync(file, JSON.stringify({ package: 'com.example.rides', popups: [{ when: { text: 'x' } }] }));
  assert.throws(() => manifest.commands.add.run(ctx, { file }), /"popups"/);
});

// ---------- devices, and a TV ----------

test('a device asleep is woken before an adb command that changes something, and not for one that only looks or is about power', async () => {
  saveDevice(ctx, { name: 'sleepy', serial: 'S9', maker: 'Maker', model: 'Box', android: '11', sdk: 30, tv: true });
  let awake = false;
  const ran = [];
  const sh = (args) => args.slice(args.indexOf('shell') + 1).join(' ');
  const answer = (args) => {
    if (args[0] === 'devices') return 'List of devices attached\nS9 device usb:1 model:Box\n';
    const c = sh(args);
    if (c === 'dumpsys power') return `mWakefulness=${awake ? 'Awake' : 'Asleep'}`;
    if (c === 'dumpsys window') return 'isKeyguardShowing=false';
    if (c === 'input keyevent WAKEUP') awake = true;
    return '';
  };
  const withExec = {
    ...ctx,
    exec: async (cmd, args) => {
      if (args[0] !== 'devices' && !/^dumpsys (power|window)$/.test(sh(args))) ran.push(sh(args));
      return { code: 0, stdout: answer(args), stderr: '' };
    },
  };
  const adb = (...words) => manifest.commands.adb.run(withExec, { _: ['sleepy', 'shell', ...words] });
  assert.equal((await adb('getprop ro.product.model')).data.woke, false, 'a look wakes nothing');
  assert.deepEqual(ran, ['getprop ro.product.model']);
  assert.equal((await adb('input keyevent POWER')).data.woke, false, 'a key about power is left to do what it does');
  ran.length = 0;
  const r = await adb("am start -a android.intent.action.VIEW -d 'https://example.com'");
  assert.equal(r.data.woke, true);
  assert.deepEqual(
    ran,
    ['input keyevent WAKEUP', "am start -a android.intent.action.VIEW -d 'https://example.com'"],
    'woken, then the command',
  );
  ran.length = 0;
  assert.equal((await adb('input keyevent KEYCODE_2')).data.woke, false, 'awake now: not woken again');
  assert.deepEqual(ran, ['input keyevent KEYCODE_2']);
  (await import('../plugins/android/routines.js')).deleteDevice(ctx, 'sleepy');
});

test('devices are kept by name; pairing one again under a new name renames it', () => {
  saveDevice(ctx, { name: 'phone', serial: 'R1', maker: 'Maker', model: 'One', android: '12', sdk: 31, tv: false });
  saveDevice(ctx, {
    name: 'tv',
    serial: 'T1',
    address: '192.168.1.40:5555',
    maker: 'Maker',
    model: 'Screen',
    android: '11',
    sdk: 30,
    tv: true,
  });
  assert.deepEqual(
    listDevices(ctx).map((d) => [d.name, d.tv, d.address, d.label]),
    [
      ['phone', false, null, 'Maker One'],
      ['tv', true, '192.168.1.40:5555', 'Maker Screen'],
    ],
  );
  saveDevice(ctx, { name: 'lounge', serial: 'T1', address: '192.168.1.41:5555', tv: true });
  assert.equal(getDevice(ctx, 'tv'), undefined);
  assert.equal(getDevice(ctx, 'lounge').address, '192.168.1.41:5555');
  assert.throws(() => saveDevice(ctx, { name: 'Living Room', serial: 'X' }), /not a name for a device/);
  assert.throws(() => saveDevice(ctx, { name: 'x', serial: 'X', address: 'nowhere' }), /not an address/);
});

// A TV's menu: the remote's down arrow moves the focus from one row to the next.
const TV = {
  home: { els: [{ text: 'Search', focused: true }, { text: 'Films' }, { text: 'Series' }], keys: { DPAD_DOWN: 'films' } },
  films: { els: [{ text: 'Search' }, { text: 'Films', focused: true }, { text: 'Series' }], keys: { DPAD_DOWN: 'series' } },
  series: { els: [{ text: 'Search' }, { text: 'Films' }, { text: 'Series', focused: true }], keys: { DPAD_CENTER: 'playing' } },
  playing: { els: [{ text: 'Now playing', tap: false }] },
};

test("a TV's remote: the arrow is pressed until the element has the focus, and keys can be pressed several times", async () => {
  const tv = new FakeDevice('home', TV);
  const r = {
    name: 'series',
    app: 'com.example.rides',
    steps: [
      { do: 'focus', target: { text: 'Series' } },
      { do: 'key', key: 'DPAD_CENTER' },
      { do: 'wait', target: { text: 'Now playing' } },
      { do: 'key', key: 'VOLUME_DOWN', times: 3 },
    ],
  };
  assert.deepEqual(validate(r, { ...APP, commit: [] }), []);
  const out = await runWith(tv, 'cancel', r);
  assert.equal(out.outcome, 'finished');
  assert.deepEqual(tv.keys, ['DPAD_DOWN', 'DPAD_DOWN', 'DPAD_CENTER', 'VOLUME_DOWN', 'VOLUME_DOWN', 'VOLUME_DOWN']);
  const lost = { ...r, steps: [{ do: 'focus', target: { text: 'Settings' }, max: 2 }] };
  await assert.rejects(runWith(new FakeDevice('home', TV), 'cancel', lost), /never had the focus after 2 presses of DPAD_DOWN/);
  assert.match(validate({ ...r, steps: [{ do: 'key', key: 'DPAD_UP', times: 50 }] }, APP).join('\n'), /"times"/);
  assert.match(validate({ ...r, steps: [{ do: 'focus', target: { text: 'x' }, key: 'HOME' }] }, APP).join('\n'), /the arrow/);
  assert.match(validate({ ...r, after: 'off' }, APP).join('\n'), /"after"/);
});

test('a number on a TV is pressed digit by digit, from a value; anything but digits is refused; the screen at the end only when asked', async () => {
  const r = {
    name: 'channel',
    app: 'com.example.rides',
    params: { channel: { summary: 'the channel' } },
    steps: [{ do: 'digits', number: '{{channel}}' }],
  };
  assert.deepEqual(validate(r, { ...APP, commit: [] }), []);
  const tv = new FakeDevice('home', TV);
  const out = await runWith(tv, 'cancel', withParams(r, { channel: '20' }));
  assert.equal(out.outcome, 'finished');
  assert.deepEqual(tv.shells, ['input keyevent KEYCODE_2 KEYCODE_0'], 'the digit keys, and nothing else');
  assert.equal(out.shot, undefined, 'no picture unless the routine asks for one');
  await assert.rejects(runWith(new FakeDevice('home', TV), 'cancel', withParams(r, { channel: '20; reboot' })), /not a number/);
  assert.match(validate({ ...r, steps: [{ do: 'digits', number: '1234567' }] }, APP).join('\n'), /"number"/);
  assert.match(validate({ ...r, steps: [{ do: 'digits', number: 'DPAD_UP' }] }, APP).join('\n'), /"number"/);
  const pictured = await runWith(new FakeDevice('home', TV), 'cancel', withParams({ ...r, picture: true }, { channel: '7' }));
  assert.match(pictured.shot, /channel-end-\d+\.jpg$/, 'the screen as the routine left it');
  assert.match(validate({ ...r, picture: 'yes' }, APP).join('\n'), /"picture"/);
});

test('the keyboard a field brought up is closed once the text is in, unless the step keeps it', async () => {
  const typing = (keyboard) => ({
    name: 'search',
    app: 'com.example.rides',
    steps: [{ do: 'type', text: 'Central Station', ...(keyboard ? { keyboard } : {}) }],
  });
  const dev = new FakeDevice();
  let closed = 0;
  dev.hideKeyboard = async () => (closed++, true);
  const out = await runWith(dev, 'cancel', typing());
  assert.equal(closed, 1);
  assert.match(out.steps.at(-1).text, /typed "Central Station", and closed the keyboard/);
  await runWith(dev, 'cancel', typing('keep'));
  assert.equal(closed, 1, '"keyboard": "keep" leaves it open');
  assert.deepEqual(validate(typing('keep'), { ...APP, commit: [] }), []);
  assert.match(validate(typing('close'), APP).join('\n'), /"keyboard"/);
});

test('trouble that was got past is on the activity record, and sent only when the run failed or there is a fix to keep', async () => {
  const { tellAndKeep } = await import('../plugins/android/plugin.js');
  const sent = [];
  const tell = { ...ctx, notify: async (text) => sent.push(text), askOwner: async () => ({ answer: '✖ No' }) };
  process.env.BLACKCAT_CHAT_ID = 'me'; // (not at this terminal)
  const t = { n: '6.1', summary: 'The keyboard covers the list.', did: 'pressed Back', fix: null };
  const args = { r: ROUTINE, base: ROUTINE, app: APP, d: { name: 'phone' }, trouble: [t], said: 'Pressed.' };
  await tellAndKeep(tell, { ...args, result: { outcome: 'confirmed' } });
  assert.deepEqual(sent, [], 'got past, nothing to decide: no message');
  await new Promise((r) => setTimeout(r, 100));
  const { recent } = await import('../src/activity/log.js');
  assert.ok(
    recent({ category: 'android' }).some(
      (e) => e.summary === 'routine ride on the phone, step 6.1: The keyboard covers the list. It pressed Back and went on.',
    ),
    'on the record, to be asked about',
  );
  await tellAndKeep(tell, { ...args, result: { outcome: 'failed', step: '6.1', error: 'not there' } });
  assert.equal(sent.length, 1, 'a run that failed is said');
  delete process.env.BLACKCAT_CHAT_ID;
});

test('after a run a phone is put to sleep on its home screen, a TV is left as it is, unless the routine says otherwise', async () => {
  const fake = () => {
    const d = new FakeDevice();
    Object.assign(d, {
      setting: async () => '0',
      unset: async () => {},
      ensureServer: async () => {},
      wake: async () => {},
      installed: async () => true,
      startApp: async () => {},
      sleep: async () => d.keys.push('SLEEP'),
    });
    return d;
  };
  const r = { name: 'x', app: 'com.example.rides', steps: [] };
  for (const [tv, after, keys] of [
    [false, undefined, ['HOME', 'SLEEP']],
    [true, undefined, []],
    [true, 'home', ['HOME']],
    [false, 'stay', []],
  ]) {
    const d = fake();
    await session(d, { ...r, after }, async () => 'done', { tv });
    assert.deepEqual(d.keys, keys, `${tv ? 'a TV' : 'a phone'}, after: ${after ?? 'by default'}`);
  }
});

test('a routine that goes on from what is showing wakes, closes and opens nothing, and stops when the app is not there', async () => {
  const fake = (front, awake = 'Awake') => {
    const d = new FakeDevice();
    const did = [];
    Object.assign(d, {
      did,
      setting: async () => '0',
      unset: async () => {},
      ensureServer: async () => {},
      wake: async () => did.push('wake'),
      installed: async () => true,
      stopApp: async () => did.push('stop'),
      startApp: async () => did.push('start'),
      wakefulness: async () => awake,
      foreground: async () => front,
    });
    return d;
  };
  const r = { name: 'x', app: 'com.example.tv', start: 'running', steps: [] };
  const whole = { ...r, name: 'channel', steps: [{ do: 'key', key: 'BACK' }] };
  assert.deepEqual(validate(whole, { ...APP, commit: [] }), []);
  assert.match(validate({ ...whole, start: 'cold' }, APP).join('\n'), /"start"/);
  const on = fake('com.example.tv');
  assert.equal(await session(on, r, async () => 'done', { tv: true }), 'done');
  assert.deepEqual(on.did, [], 'as it is');
  const fresh = fake('com.example.tv');
  await session(fresh, { ...r, start: undefined }, async () => 'done', { tv: true });
  assert.deepEqual(fresh.did, ['wake', 'stop', 'start'], 'by default, from the first screen');
  await assert.rejects(
    session(fake('com.other'), r, async () => 'done'),
    /com.example.tv is not in front \(com.other is\)/,
  );
  await assert.rejects(
    session(fake('com.example.tv', 'Asleep'), r, async () => 'done'),
    /asleep/,
  );
});

test("the device's own screen setting is put back, also after a run that was cut off left it on", async () => {
  const device = (settings) => {
    const d = new FakeDevice();
    Object.assign(d, {
      settings,
      setting: async (ns, k, v) => (v == null ? (settings[k] ?? 'null') : void (settings[k] = String(v))),
      unset: async (ns, k) => void delete settings[k],
      ensureServer: async () => {},
      wake: async () => {},
      installed: async () => true,
      startApp: async () => {},
      sleep: async () => {},
    });
    return d;
  };
  const r = { name: 'x', app: 'com.example.rides', steps: [] };
  const clean = device({ stay_on_while_plugged_in: '0' });
  let during;
  await session(clean, r, async () => (during = clean.settings.stay_on_while_plugged_in));
  assert.equal(during, '7', 'kept on while it works');
  assert.deepEqual(clean.settings, { stay_on_while_plugged_in: '0' });
  // A run before was cut off: "stay on" was left, with the device's own value beside it.
  const left = device({ stay_on_while_plugged_in: '7', blackcat_stay_on_while_plugged_in: '0' });
  await session(left, r, async () => {});
  assert.deepEqual(left.settings, { stay_on_while_plugged_in: '0' });
});

test('a tap that did nothing, on an app still starting, is made again; one marked not to be is not', async () => {
  const r = {
    name: 'r',
    app: APP.package,
    steps: [
      { do: 'tap', target: { text: 'Rides' } },
      { do: 'wait', target: { resourceId: 'field_search' }, wait: 5 },
    ],
  };
  const dev = Object.assign(new FakeDevice(), { lose: 1 });
  assert.equal((await runWith(dev, 'cancel', r)).outcome, 'finished');
  assert.deepEqual(dev.taps, ['Rides', 'Rides']);
  // A home screen that keeps changing as it loads (a balance, offers): still made once more.
  const busy = Object.assign(new FakeDevice(), { lose: 1, n: 0 });
  const dump = busy.dump.bind(busy);
  busy.dump = async () => (await dump()).replace('</hierarchy>', `<node text="offer ${busy.n++}" bounds="[0,900][100,950]" /></hierarchy>`);
  assert.equal((await runWith(busy, 'cancel', r)).outcome, 'finished');
  assert.deepEqual(busy.taps, ['Rides', 'Rides']);
  // The home screen still loading: an offer comes in above, and "Rides" moves down. Still the same screen.
  const loading = Object.assign(new FakeDevice('home', structuredClone(SCREENS)), { lose: 1 });
  const tap = loading.tap.bind(loading);
  loading.tap = async (x, y) => {
    await tap(x, y);
    if (loading.taps.length === 1) loading.screens.home.els.unshift({ text: 'Offer of the day', tap: false });
  };
  assert.equal((await runWith(loading, 'cancel', r)).outcome, 'finished');
  assert.deepEqual(loading.taps, ['Rides', 'Rides'], 'tapped again where it is now');
  // An app that ignores taps for longer (just started, busy after a ride): up to three more.
  const slow = Object.assign(new FakeDevice(), { lose: 3 });
  const out = await runWith(slow, 'cancel', { ...r, steps: [r.steps[0], { ...r.steps[1], wait: 15 }] });
  assert.equal(out.outcome, 'finished');
  assert.deepEqual(slow.taps, ['Rides', 'Rides', 'Rides', 'Rides']);
  assert.match(out.steps[0].text, /\(tapped 4 times: the first did nothing\)$/);
  // The first tap worked, slowly, and the next screen has a "Rides" in the same place: that is
  // another screen, and nothing is tapped on it.
  const moved = new FakeDevice('home', {
    home: { els: [{ text: 'Rides' }, { text: 'Food' }, { text: 'Shops' }, { text: 'Pay' }, { text: 'Balance' }], go: { Rides: 'promo' } },
    promo: { els: [{ text: 'Rides' }, { text: 'Offers for you' }, { text: 'Today only' }, { text: 'Book a trip' }, { text: 'Later' }] },
  });
  await assert.rejects(runWith(moved, 'cancel', r), /never showed\. "Rides" was not tapped again: the screen changed \(4 of 5/);
  assert.deepEqual(moved.taps, ['Rides'], 'not tapped again on a screen it was not tapped on');
  const once = Object.assign(new FakeDevice(), { lose: 1 });
  r.steps[0].retry = false;
  await assert.rejects(runWith(once, 'cancel', r), /never showed/);
  assert.deepEqual(once.taps, ['Rides']);
});

// ---------- adb commands ----------

test("adb on a device: what only looks runs, the rest follows the device's mode, and files to and from here are the owner's", async () => {
  const { judge, judgeShell } = await import('../plugins/android/adb.js');
  for (const cmd of [
    'getprop ro.product.model',
    'dumpsys battery',
    'dumpsys package com.example.rides',
    'pm list packages',
    'settings get global stay_on_while_plugged_in',
    'wm size',
    'ls /sdcard',
    'ps -A | grep example',
    'cmd package list packages -3',
  ])
    assert.equal(judgeShell(cmd), 'read', cmd);
  for (const cmd of ['dumpsys notification', 'logcat -d', 'content query --uri content://contacts/people'])
    assert.equal(judgeShell(cmd), 'sensitive', cmd);
  for (const cmd of [
    'input tap 10 10',
    'am start -n x/y',
    'settings put global x 1',
    'dumpsys battery set level 5',
    'pm uninstall com.example.rides',
    'setprop x 1',
    'reboot',
    'getprop ro.x; reboot',
    'logcat',
    'rm -rf /sdcard/x',
  ])
    assert.equal(judgeShell(cmd), 'change', cmd);
  assert.deepEqual(judge(['shell', 'getprop', 'ro.product.model']), { kind: 'read', command: 'getprop ro.product.model' });
  assert.deepEqual(judge(['get-state']), { kind: 'read' });
  assert.deepEqual(judge(['reboot']), { kind: 'change' });
  assert.equal(judge(['pull', '/sdcard/x', '/tmp/x']).level, 'owner');
  assert.equal(judge(['push', '/home/x/data/plugins/x/secrets.json', '/sdcard/']).level, 'owner');
  assert.equal(judge(['connect', '10.0.0.1:5555']).level, 'never');
  assert.equal(judge(['-s', 'other', 'shell', 'ls']).level, 'never');
  assert.equal(judge(['shell']).level, 'never');
  assert.equal(judge(['logcat']).level, 'never');

  const adb = (words) => manifest.commands.adb.access(ctx, words);
  assert.equal(getDevice(ctx, 'phone').mode, 'ask', 'a device starts as "ask"');
  assert.equal(adb(['phone', 'shell', 'getprop ro.product.model']).level, 'allow');
  assert.equal(adb(['phone', 'reboot']).level, 'ask');
  assert.match(adb(['phone', 'shell', 'input tap 1 1']).describe, /adb shell input tap 1 1 on the phone/);
  assert.equal(adb(['nowhere', 'shell', 'ls']).level, 'never');
  manifest.commands.mode.run(ctx, { name: 'phone', mode: 'read' });
  assert.equal(adb(['phone', 'reboot']).level, 'never');
  assert.equal(adb(['phone', 'shell', 'logcat -d']).level, 'never', 'what is personal is not a free look either');
  manifest.commands.mode.run(ctx, { name: 'phone', mode: 'full' });
  assert.equal(adb(['phone', 'reboot']).level, 'allow');
  assert.equal(adb(['phone', 'pull', '/sdcard/x', '/tmp/x']).level, 'owner', 'whatever the mode');
  // Paired again under another name, it keeps its mode.
  saveDevice(ctx, { name: 'mobile', serial: 'R1', tv: false });
  assert.equal(getDevice(ctx, 'mobile').mode, 'full');
});

test('a routine can stop by itself where it says so: a ride already under way is not booked again', async () => {
  const { Stopped } = await import('../plugins/android/runner.js');
  const screens = { ...SCREENS, riding: { els: [{ text: 'Your driver is on the way', tap: false }, { text: 'Rides' }] } };
  const raw = {
    ...ROUTINE,
    steps: [
      { do: 'if_shown', target: { textContains: 'Your driver' }, wait: 1, then: [{ do: 'stop', say: 'a ride is already under way' }] },
      ...ROUTINE.steps,
    ],
  };
  const r = withParams(raw, { to: 'Central Station' });
  assert.deepEqual(validate(raw, APP), []);
  assert.match(validate({ ...raw, steps: [{ do: 'stop' }, ...raw.steps] }, APP).join('\n'), /"say" is why/);
  const riding = new FakeDevice('riding', screens);
  await assert.rejects(runWith(riding, 'confirm', r), (e) => e instanceof Stopped && e.message === 'a ride is already under way');
  assert.deepEqual(riding.taps, [], 'nothing was tapped');
  // With no ride under way, the same routine goes on as before.
  assert.equal((await runWith(new FakeDevice('home', screens), 'cancel', r)).outcome, 'cancelled');
});

// ---------- not waiting longer than needed ----------

// An app whose taps land a few looks at the screen later, as on a slow phone.
class LateApp extends FakeDevice {
  async dump() {
    if (this.tapping) return xml(this.screens[this.at].els); // (where the tap is, not a look)
    if (this.pending && --this.pending.looks <= 0) [this.at, this.pending] = [this.pending.to, null];
    const s = this.screens[this.at];
    this.seen = (this.seen ?? 0) + 1;
    if (s.then && this.seen >= s.then[1]) [this.at, this.seen] = [s.then[0], 0];
    return xml(this.screens[this.at].els);
  }
  async tap(x, y) {
    const before = this.at;
    this.tapping = true;
    await super.tap(x, y);
    this.tapping = false;
    this.seen = 0;
    if (this.at !== before) this.pending = null; // (a tap on the old screen goes where that one leads)
    // (`late`: the next tap lands that many looks later.)
    if (this.late && this.at !== before) [this.pending, this.at, this.late] = [{ to: this.at, looks: this.late }, before, 0];
  }
}
const going = (dev, steps) => new Runner(dev, { name: 'r', app: APP.package, steps }, APP, { answer: async () => 'cancel', media }).run();

const ROUTE_STEPS = [
  { do: 'tap', target: { text: 'Go' } },
  { do: 'if_shown', target: { text: 'Offer' }, wait: 10, then: [{ do: 'tap', target: { text: 'Close' } }] },
  { do: 'tap', target: { text: 'Next' } },
];
test('a screen that may not come is not waited for once what a later step waits for is there', async () => {
  const screens = { home: { els: [{ text: 'Go' }], go: { Go: 'next' } }, next: { els: [{ text: 'Next' }] } };
  const ph = new LateApp('home', screens);
  const t0 = Date.now();
  const r = await going(ph, ROUTE_STEPS);
  assert.ok(Date.now() - t0 < 5000, 'not the ten seconds the step allows');
  assert.match(r.steps[1].text, /"Offer" did not show \("Next", of a later step, did\): skipped/);
  assert.deepEqual(ph.taps, ['Go', 'Next']);
});

test('what a later step waits for, there before the tap too, does not end the wait for a screen that comes late', async () => {
  const screens = {
    home: { els: [{ text: 'Go' }, { text: 'Next' }], go: { Go: 'next' } },
    next: { els: [{ text: 'Back' }, { text: 'Next' }], then: ['offer', 12] },
    offer: { els: [{ text: 'Offer', tap: false }, { text: 'Close' }], go: { Close: 'done' } },
    done: { els: [{ text: 'Next' }] },
  };
  const ph = new LateApp('home', screens);
  const r = await going(ph, [
    { do: 'tap', target: { text: 'Go' } },
    { do: 'if_shown', target: { text: 'Offer' }, wait: 10, then: [{ do: 'tap', target: { text: 'Close' } }] },
    { do: 'tap', target: { text: 'Next' } },
  ]);
  assert.match(r.steps[1].text, /"Offer" showed/);
  assert.deepEqual(ph.taps, ['Go', 'Close', 'Next']);
});

test('after a tap, the old screen is not taken for the new one while the tap is still landing', async () => {
  const screens = {
    home: { els: [{ text: 'Go' }, { text: 'Next' }], go: { Go: 'second', Next: 'wrong' } },
    second: { els: [{ text: 'Back' }, { text: 'Next' }], go: { Next: 'right' } },
    wrong: { els: [{ text: 'Wrong' }] },
    right: { els: [{ text: 'Right' }] },
  };
  const ph = new LateApp('home', screens);
  ph.late = 3;
  await going(ph, [
    { do: 'tap', target: { text: 'Go' } },
    { do: 'tap', target: { text: 'Next' } },
  ]);
  assert.equal(ph.at, 'right', 'Next was tapped on the second screen, not on the first');
});

test('a check waits for the text it expects: a field is often drawn before it is filled in', async () => {
  const d = new FakeDevice('search');
  let n = 0;
  const dump = d.dump.bind(d);
  d.dump = async () => (n++ < 3 ? (await dump()).replace('Pickup Home', '') : await dump());
  const r = { name: 'c', app: APP.package, steps: [{ do: 'check', target: { resourceId: 'field_search' }, text_contains: 'Home' }] };
  assert.equal((await runWith(d, 'cancel', r)).outcome, 'finished');
});

// ---------- getting past what is in the way ----------

test('a step that fails is looked at: a notice in the way is closed, the step tried again, and a fix offered for next time', async () => {
  const { checkedAction, proposedFix, refuseTap } = await import('../plugins/android/recover.js');
  const screens = {
    ...SCREENS,
    promo: {
      els: [{ text: 'Flash sale: 50% off for Ana', tap: false }, { text: 'Not now' }, { text: 'Shop now' }],
      go: { 'Not now': 'home' },
    },
  };
  const seen = [];
  // A stand-in for the model: it names elements by their number in the list it was shown.
  const recover = async ({ els, n, error }) => {
    seen.push({ n, error });
    const at = (w) => els.findIndex((e) => e.text?.startsWith(w));
    return {
      kind: 'popup',
      summary: 'An offer covers the screen.',
      recoverable: true,
      action: { do: 'tap', element: at('Not now') },
      fix: { kind: 'popup', when: at('Flash sale'), contains: 'Flash sale', tap: at('Not now') },
    };
  };
  const dev = new FakeDevice('promo', screens);
  const r = { name: 'r', app: APP.package, steps: [{ do: 'tap', target: { text: 'Rides' }, wait: 0.3 }] };
  const runner = new Runner(dev, r, APP, { answer: async () => 'cancel', media, recover });
  assert.equal((await runner.run()).outcome, 'finished');
  assert.deepEqual(dev.taps, ['Not now', 'Rides']);
  assert.equal(seen.length, 1);
  assert.deepEqual(runner.recoveries[0].fix.popup, { when: { textContains: 'Flash sale' }, tap: { text: 'Not now' } });
  assert.equal(runner.recoveries[0].did, 'tapped "Not now"');

  // The guard, whatever the model says: never what books, pays or accepts.
  const els = elements(parse(xml(screens.cars.els.concat([{ text: 'Pay now' }, { text: 'Skip' }]))));
  const ix = (w) => els.findIndex((e) => (e.text ?? e.description) === w);
  for (const w of ['Book now', 'Pay now']) assert.ok(refuseTap(els[ix(w)], APP), w);
  assert.equal(refuseTap(els[ix('Skip')], APP), null);
  assert.match(
    checkedAction({ recoverable: true, action: { do: 'tap', element: ix('Book now') } }, els, APP).refused,
    /books, pays or sends/,
  );
  assert.equal(checkedAction({ recoverable: false, action: { do: 'back' } }, els, APP).refused, 'nothing to do');
  // A fix keeps only words that are on the screen.
  assert.equal(proposedFix({ fix: { kind: 'popup', when: ix('Skip'), contains: 'not there', tap: ix('Skip') } }, els, APP, {}), null);
});

test('what the model suggests that is not safe is not done, and a run has at most two recoveries', async () => {
  let asked = 0;
  const pushy = async ({ els }) => (
    asked++,
    {
      kind: 'popup',
      summary: 'x',
      recoverable: true,
      action: { do: 'tap', element: els.findIndex((e) => e.text === 'Book now') },
      fix: null,
    }
  );
  const cars = new FakeDevice('cars');
  const r = { name: 'r', app: APP.package, steps: [{ do: 'tap', target: { text: 'Nowhere' }, wait: 0.3 }] };
  const runner = new Runner(cars, r, APP, { answer: async () => 'cancel', media, recover: pushy });
  await assert.rejects(runner.run(), StepFailed);
  assert.deepEqual(cars.taps, [], 'the booking button was not pressed');
  assert.match(runner.recoveries[0].refused, /books, pays or sends/);
  asked = 0;
  const waiting = async () => (
    asked++,
    { kind: 'loading', summary: 'loading', recoverable: true, action: { do: 'wait', seconds: 1 }, fix: null }
  );
  await assert.rejects(
    new Runner(new FakeDevice('home'), r, APP, { answer: async () => 'cancel', media, recover: waiting }).run(),
    StepFailed,
  );
  assert.equal(asked, 2);
});

// ---------- learning a routine from words ----------

test("a routine is learned one action at a time: the owner's values become {{values}}, dead ends are dropped, the booking button is never tapped", async () => {
  const { Learner, targetFor, refuseLearnTap } = await import('../plugins/android/learn.js');
  const dev = new FakeDevice('home');
  Object.assign(dev, { startApp: async () => {}, swipe: async () => {} });
  const idx = (els, w) => els.findIndex((e) => (e.text ?? e.description) === w);
  const script = [
    ({ els }) => ({ thought: 'the home screen', do: 'tap', element: idx(els, 'Food') }), // a wrong turn …
    () => ({ thought: 'wrong place', do: 'back' }), // … taken back (the fake stays put)
    ({ els }) => ({ thought: 'rides', do: 'tap', element: idx(els, 'Rides'), why: 'open rides' }),
    () => ({ thought: 'type it', do: 'type', value: 'nowhere', element: 0 }), // not one of the values
    ({ els }) => ({ thought: 'type it', do: 'type', value: 'to', element: els.findIndex((e) => e.field) }),
    ({ els }) => ({ thought: 'the result', do: 'tap', element: idx(els, 'Central Station') }),
    ({ els }) => ({ thought: 'book it', do: 'tap', element: idx(els, 'Book now') }), // refused
    ({ els }) => ({
      thought: 'this is the confirmation screen',
      do: 'confirm_screen',
      button: idx(els, 'Book now'),
      must_show: [els.findIndex((e) => e.text === 'Central Station')],
      read: [{ name: 'Price', anchor: idx(els, 'Comfort'), how: 'row', kind: 'money' }],
    }),
  ];
  let k = 0;
  const notes = [];
  const think = async (x) => (notes.push([...x.notes]), script[k++](x));
  const learner = new Learner(dev, {
    app: APP,
    goal: 'a ride to {{to}}, stop before booking',
    values: { to: 'Central Station' },
    think,
    media,
  });
  const got = await learner.run();
  assert.equal(got.ended, 'confirm');
  assert.equal(got.label, 'Book now');
  assert.ok(!dev.taps.includes('Book now'), 'never tapped');
  assert.deepEqual(dev.typed, ['Central Station']);
  assert.deepEqual(
    learner.steps.map((x) => [x.do, x.do === 'type' ? x.text : x.target]),
    [
      ['tap', { text: 'Rides' }],
      ['type', '{{to}}'],
      ['tap', { textContains: '{{to}}' }],
    ],
  );
  assert.deepEqual(got.confirm.must_show, [{ textContains: '{{to}}' }]);
  assert.ok(got.confirm.read.Price.row_of && got.confirm.read.Price.pattern);
  assert.match(notes.flat().join(' '), /only the owner's values may be typed/);
  assert.match(notes.flat().join(' '), /"Book now" books, pays or sends/);
  // What learning may not tap, and how what it taps is found again.
  assert.match(refuseLearnTap({ text: 'Place order', tap: true }, { commit: [] }), /could book, buy, pay/);
  assert.equal(refuseLearnTap({ text: 'Rides', tap: true }, APP), null);
  assert.deepEqual(targetFor({ text: 'Central Station' }, { to: 'Central Station' }), { textContains: '{{to}}' });
  // The routine it makes passes the same checks as one written by hand.
  const routine = { name: 'learned', app: APP.package, params: { to: { summary: 'to' } }, steps: [...learner.steps, got.confirm] };
  assert.deepEqual(validate(routine, APP), []);
});

test('learning stops by itself when stuck, and when the owner watching says stop', async () => {
  const { Learner } = await import('../plugins/android/learn.js');
  const stuck = new Learner(new FakeDevice('home'), {
    app: APP,
    goal: 'x',
    think: async () => ({ thought: 'no way on', do: 'stuck' }),
    media,
  });
  assert.equal((await stuck.run()).ended, 'stuck');
  const watched = new Learner(new FakeDevice('home'), {
    app: APP,
    goal: 'x',
    think: async ({ els }) => ({ thought: 'rides', do: 'tap', element: els.findIndex((e) => e.text === 'Rides') }),
    confirmEach: async () => false,
    media,
  });
  assert.equal((await watched.run()).ended, 'stopped');
  const going = new Learner(new FakeDevice('home'), {
    app: APP,
    goal: 'x',
    think: async () => ({ thought: 'still covered', do: 'wait' }),
    media,
  });
  const nowhere = await going.run();
  assert.equal(nowhere.ended, 'stuck', 'the same screen after three tries: stopped, not 40 calls');
  assert.equal(going.actions, 3);
  const budget = new Learner(new FakeDevice('home'), {
    app: APP,
    goal: 'x',
    think: async () => ({ thought: 'wait', do: 'wait' }),
    media,
    max: 2,
  });
  assert.equal((await budget.run()).ended, 'budget');
});

test("a tile whose words are its children's is found by them, in a step and as the confirmation button", async () => {
  const { targetOf } = await import('../plugins/android/recover.js');
  const { targetFor } = await import('../plugins/android/learn.js');
  const root = parse(
    xml([
      {
        children: [
          { text: 'Rides', tap: false },
          { text: 'Get there', tap: false },
        ],
      },
    ]),
  );
  const tile = elements(root).find((e) => e.label);
  assert.deepEqual(targetOf(tile), { textContains: 'Rides' });
  assert.equal(find(root, targetOf(tile)).length, 1);
  assert.deepEqual(targetFor({ label: 'City Mall · Downtown', tap: true }, { to: 'City Mall' }), { textContains: '{{to}}' });
});

test('learning keeps a choice by its place in a list, a screen that only shows some times under if_shown, and only the last typing into a field', async () => {
  const { Learner } = await import('../plugins/android/learn.js');
  const screens = {
    points: {
      els: [
        { text: 'Select pick-up point inside the mall', tap: false },
        { id: 'point', text: 'North gate' },
        { id: 'point', text: 'South gate' },
        { id: 'field', text: '', field: true },
        { desc: 'clear', id: 'clear' },
      ],
    },
  };
  const dev = Object.assign(new FakeDevice('points', screens), { startApp: async () => {} });
  // (Each action changes something on the screen, as typing does on a real one.)
  let n = 0;
  const dump = dev.dump.bind(dev);
  dev.dump = async () => (await dump()).replace('</hierarchy>', `<node text="${n++}" bounds="[0,1900][50,1950]" /></hierarchy>`);
  const at = (els, w) => els.findIndex((e) => (e.text ?? e.description) === w);
  const script = [
    ({ els }) => ({ thought: 'type', do: 'type', value: 'to', element: els.findIndex((e) => e.field) }),
    ({ els }) => ({ thought: 'clear it', do: 'tap', element: at(els, 'clear') }),
    ({ els }) => ({ thought: 'type again', do: 'type', value: 'to', element: els.findIndex((e) => e.field) }),
    ({ els }) => ({ thought: 'first point', do: 'tap', element: at(els, 'North gate'), by_position: true, only_if: 0 }),
    () => ({ thought: 'stuck on purpose', do: 'stuck' }),
  ];
  let k = 0;
  const learner = new Learner(dev, { app: APP, goal: 'x', values: { to: 'Mall' }, think: async (x) => script[k++](x), media });
  await learner.run();
  assert.deepEqual(learner.steps, [
    { do: 'type', text: '{{to}}', target: { resourceId: 'field' } },
    {
      do: 'if_shown',
      target: { textContains: 'Select pick-up point inside the' },
      wait: 10,
      then: [{ do: 'tap', target: { resourceId: 'point', instance: 0 } }],
    },
  ]);
});

test("a tile is found by its child's text, not by an icon's description before it", async () => {
  const { targetOf } = await import('../plugins/android/recover.js');
  const root = parse(
    xml([
      {
        children: [
          { desc: 'search', tap: false },
          { text: 'Where to?', tap: false },
        ],
      },
    ]),
  );
  const tile = elements(root).find((e) => e.label);
  assert.deepEqual(targetOf(tile), { textContains: 'Where to?' });
  assert.equal(find(root, targetOf(tile)).length, 1);
});

test('of two fields with the same id, the step names the one that was used', async () => {
  const { alone } = await import('../plugins/android/learn.js');
  const root = parse(
    xml([
      { id: 'field_search', text: 'Pickup', field: true },
      { id: 'field_search', text: '', field: true },
    ]),
  );
  const els = elements(root);
  assert.deepEqual(alone(root, els[1], { resourceId: 'field_search' }), { resourceId: 'field_search', instance: 1 });
  assert.deepEqual(alone(root, els[0], { text: 'Pickup' }), { text: 'Pickup' }, 'one match: as it is');
});

test('with the button to stop at named by the owner, learning never taps it and stops only at its screen', async () => {
  const { Learner } = await import('../plugins/android/learn.js');
  const app = { ...APP, commit: [] };
  const screens = { ...SCREENS, cars: { ...SCREENS.cars, els: [...SCREENS.cars.els, { text: 'Continue' }] } };
  const dev = new FakeDevice('cars', screens);
  let n = 0;
  const dump = dev.dump.bind(dev);
  dev.dump = async () => (await dump()).replace('</hierarchy>', `<node text="${n++}" bounds="[0,1900][50,1950]" /></hierarchy>`);
  const at = (els, w) => els.findIndex((e) => e.text === w);
  const script = [
    ({ els }) => ({ thought: 'book', do: 'tap', element: at(els, 'Book now') }),
    ({ els }) => ({ thought: 'this one', do: 'confirm_screen', button: at(els, 'Continue') }),
    ({ els }) => ({ thought: 'this one', do: 'confirm_screen', button: at(els, 'Book now') }),
  ];
  let k = 0;
  const notes = [];
  const learner = new Learner(dev, {
    app: { ...app, commit: ['Book now'] },
    goal: 'x',
    stopAt: 'Book now',
    think: async (x) => (notes.push(...x.notes), script[k++](x)),
    media,
  });
  const got = await learner.run();
  assert.equal(got.ended, 'confirm');
  assert.deepEqual(got.confirm.button, { text: 'Book now' });
  assert.deepEqual(dev.taps, [], 'never tapped');
  assert.match(notes.join(' '), /the owner said to stop at the screen with the "Book now" button, and element \d+ is not it/);
});

test('a result with the same words as the field above it is the one found, not the field', async () => {
  const { alone, targetFor } = await import('../plugins/android/learn.js');
  const root = parse(xml([{ id: 'field_search', text: 'Mall of the Emirates', field: true }, { text: 'Mall of the Emirates, Al Barsha' }]));
  const els = elements(root);
  const values = { from: 'Mall of the Emirates' };
  assert.deepEqual(alone(root, els[1], targetFor(els[1], values), values), { textContains: '{{from}}' });
  // A tile, its words in a child: the same.
  const tiles = parse(
    xml([
      { id: 'field_search', text: 'Mall of the Emirates', field: true },
      {
        at: [40, 250],
        children: [
          { text: 'Mall of the Emirates', tap: false, at: [50, 260], size: [300, 40] },
          { text: 'Al Barsha', tap: false, at: [50, 310], size: [300, 40] },
        ],
      },
    ]),
  );
  const tile = elements(tiles).find((x) => x.label);
  assert.deepEqual(alone(tiles, tile, targetFor(tile, values), values), { textContains: '{{from}}' });
});

test('a target by words never names a text field holding those words', () => {
  const root = parse(xml([{ id: 'field_search', text: 'City Mall', field: true }, { text: 'City Mall, Downtown' }]));
  assert.equal(find(root, { textContains: 'City Mall' }).length, 1);
  assert.equal(find(root, { textContains: 'City Mall' })[0].class, 'android.widget.TextView');
  assert.equal(find(root, { resourceId: 'field_search', textContains: 'City' }).length, 1, 'by its id, it is found');
});

test('words a routine looks for are matched without case; a recovery that taps what the step meant counts as the step', async () => {
  const root = parse(xml([{ text: 'Mall of The Emirates' }]));
  assert.equal(find(root, { textContains: 'Mall of the Emirates' }).length, 1);
  const screens = { ...SCREENS, home: { els: [{ text: 'Ride Hailing' }], go: { 'Ride Hailing': 'search' } } };
  const dev = new FakeDevice('home', screens);
  const recover = async ({ els }) => ({
    kind: 'changed',
    summary: 'Rides is called Ride Hailing now',
    recoverable: true,
    action: { do: 'tap', element: els.findIndex((e) => e.text === 'Ride Hailing') },
    fix: { kind: 'changed', target: els.findIndex((e) => e.text === 'Ride Hailing') },
  });
  const r = {
    name: 'r',
    app: APP.package,
    steps: [
      { do: 'tap', target: { text: 'Rides' }, wait: 0.3 },
      { do: 'wait', target: { resourceId: 'field_search' } },
    ],
  };
  const runner = new Runner(dev, r, APP, { answer: async () => 'cancel', media, recover });
  assert.equal((await runner.run()).outcome, 'finished');
  assert.deepEqual(dev.taps, ['Ride Hailing']);
  assert.deepEqual(runner.recoveries[0].fix.target, { text: 'Ride Hailing' });
});

test('the first in a list, by its place below the heading, whatever it says: found, learned and offered as a fix', async () => {
  const { byPlace, proposedFix } = await import('../plugins/android/recover.js');
  const list = (a, b) =>
    parse(
      xml([
        { text: 'Select pick-up point inside the mall', tap: false, at: [40, 100] },
        { label: true, at: [40, 250], children: [{ text: a, tap: false, at: [50, 260], size: [300, 40] }] },
        { label: true, at: [40, 400], children: [{ text: b, tap: false, at: [50, 410], size: [300, 40] }] },
      ]),
    );
  const root = list('North gate', 'South gate');
  const els = elements(root);
  const first = els.find((e) => e.label?.includes('North gate'));
  const heading = els.find((e) => e.text?.startsWith('Select'));
  const t = byPlace(root, first, heading);
  assert.deepEqual(t, { below: { textContains: 'Select pick-up point inside the' }, clickable: true, width: 600, instance: 0 });
  // Another time, another place: the first is still the first.
  const other = list('East lobby', 'West lobby');
  assert.match(labelOf(find(other, t)[0]), /East lobby/);
  assert.deepEqual(validate({ name: 'by-place', app: APP.package, steps: [{ do: 'tap', target: t }] }, { ...APP, commit: [] }), []);
  // A fix the model offers for a choice by place is kept by place, not by name.
  const fix = proposedFix(
    { fix: { kind: 'changed', target: els.indexOf(first), by_position: true, heading: els.indexOf(heading) } },
    els,
    APP,
    { do: 'tap', target: { textContains: 'Somewhere' } },
    root,
  );
  assert.deepEqual(fix.target, t);
});

test('an optional value: its steps are done only when it is given, and the others only when it is not', async () => {
  const NOCOMMIT = { ...APP, commit: [] };
  const r = {
    name: 'opt',
    app: APP.package,
    params: { to: { summary: 'where to' }, gate: { summary: 'a gate', optional: true } },
    steps: [
      { do: 'tap', target: { textContains: '{{gate}}' }, only_with: 'gate', wait: 0.5 },
      { do: 'tap', target: { text: 'Rides' }, only_without: 'gate' },
      { do: 'wait', target: { textContains: '{{to}}' }, wait: 0.2, only_with: 'nothing' },
    ],
  };
  assert.match(validate(r, NOCOMMIT).join('\n'), /nothing is not in "params"/);
  r.steps.pop();
  r.steps.push({ do: 'check', target: { text: 'Rides' }, text_contains: '{{to}}', only_without: 'gate' });
  assert.deepEqual(validate(r, NOCOMMIT), []);
  assert.match(validate({ ...r, params: { ...r.params, gate: { summary: 'a gate' } } }, NOCOMMIT).join('\n'), /mark it "optional"/);
  const without = new FakeDevice('home');
  const run1 = await runWith(without, 'cancel', withParams({ ...r, steps: r.steps.slice(0, 2) }, { to: 'x' }));
  assert.equal(run1.outcome, 'finished');
  assert.deepEqual(without.taps, ['Rides']);
  const withIt = new FakeDevice('home');
  await runWith(withIt, 'cancel', withParams({ ...r, steps: r.steps.slice(0, 2) }, { to: 'x', gate: 'Food' }));
  assert.deepEqual(withIt.taps, ['Food']);
});

test('of what holds the words looked for, the closest comes first: "Home" before "homee"', () => {
  const root = parse(xml([{ text: 'homee' }, { text: 'Home Centre' }, { text: 'Home' }]));
  assert.equal(find(root, { textContains: 'Home' })[0].text, 'Home');
  assert.equal(find(root, { textContains: 'Home', instance: 1 })[0].text, 'Home Centre');
});

test('steps that bring something about are left out when it is on the screen already (unless_shown)', async () => {
  const steps = [
    {
      do: 'unless_shown',
      target: { resourceId: 'field_search', textContains: '{{from}}' },
      then: [
        { do: 'type', text: '{{from}}', target: { resourceId: 'field_search' } },
        { do: 'tap', target: { text: 'Central Station' } },
      ],
    },
  ];
  const r = (from) => withParams({ name: 'already', app: APP.package, params: { from: { summary: 'from' } }, steps }, { from });
  assert.deepEqual(
    validate({ name: 'already', app: APP.package, params: { from: { summary: 'from' } }, steps }, { ...APP, commit: [] }),
    [],
  );
  const there = new FakeDevice('search');
  await runWith(there, 'cancel', r('Home'));
  assert.deepEqual([there.typed, there.taps], [[], []], 'the field already held "Pickup Home"');
  // Once typed, the field holds the words too: the check is made once, before, so the result is still chosen.
  const other = new FakeDevice('search');
  await runWith(other, 'cancel', r('Central Station'));
  assert.deepEqual([other.typed, other.taps], [['Central Station'], ['Pickup Home', 'Central Station']]);
});

test("a label on the confirmation screen is kept without this moment's numbers", async () => {
  const { steady } = await import('../plugins/android/learn.js');
  assert.deepEqual(steady({ text: 'Arrive by 21:02' }), { textContains: 'Arrive by' });
  assert.deepEqual(steady({ text: 'Comfort' }), { text: 'Comfort' });
  assert.equal(steady({ text: '21:02' }), null);
});

test('what the owner reads names an element in plain words', async () => {
  const { spoken } = await import('../plugins/android/screen.js');
  assert.equal(spoken({ textContains: 'Book now!' }), '"Book now!"');
  assert.equal(
    spoken({ below: { textContains: 'Select pick-up point inside' }, clickable: true, width: 912, instance: 0 }),
    'the first item below "Select pick-up point inside"',
  );
  assert.equal(spoken({ resourceId: 'field_search', instance: 1 }), 'the second field search');
  assert.equal(spoken({ text: 'City Mall', instance: 0 }), '"City Mall"');
});

// ---------- after the press ----------

// A ride app that, once booked, looks for a driver for a few looks at the screen, then shows one.
const AFTER = {
  ...SCREENS,
  cars: { ...SCREENS.cars, go: { 'Book now': 'finding' } },
  finding: {
    els: [
      { text: 'Finding your driver', tap: false },
      { text: 'Searching 12s', tap: false },
    ],
    then: ['booked', 4],
  },
  booked: {
    els: [
      { text: 'Your driver is on the way', tap: false },
      { text: 'Driver', tap: false },
      { text: 'Sam', tap: false },
      { text: 'Arrives in', tap: false },
      { text: '4 min', tap: false },
    ],
  },
};
class SlowApp extends FakeDevice {
  async dump() {
    const s = this.screens[this.at];
    this.looks = (this.looks ?? 0) + 1;
    if (s.then && this.looks >= s.then[1]) [this.at, this.looks] = [s.then[0], 0];
    return xml(this.screens[this.at].els);
  }
  async tap(x, y) {
    this.looks = 0;
    return super.tap(x, y);
  }
}
const pressed = (ph, routine, opts = {}) =>
  new Runner(ph, routine, APP, { answer: async () => 'confirm', media, steadyMs: 300, ...opts }).run();
const withAfter = (result) => {
  const r = withParams(ROUTINE, { to: 'Central Station' });
  return { ...r, steps: [...r.steps.slice(0, -1), { ...r.steps.at(-1), result }] };
};

test("after the press it waits through the app's own screens for the one the routine names, and reads it", async () => {
  const ph = new SlowApp('home', AFTER);
  const r = await pressed(
    ph,
    withAfter({
      shows: { textContains: 'on the way' },
      read: { Driver: { after: { text: 'Driver' } }, Arrives: { after: { text: 'Arrives in' } } },
    }),
  );
  assert.equal(r.outcome, 'confirmed');
  assert.equal(r.after.shown, true);
  assert.equal(r.after.changed, true);
  assert.deepEqual(r.after.values, { Driver: 'Sam', Arrives: '4 min' });
  assert.ok(fs.existsSync(r.after.shot), 'a picture of that screen');
  assert.deepEqual(ph.taps, ['Rides', 'Central Station', 'Book now'], 'nothing is tapped after the press');
});

test('without a named screen, the first that stays the same is taken; a model may say it is not the last one yet', async () => {
  // No model: the screen that stops changing ("Searching 12s" counting is not a change).
  const plain = await pressed(
    new SlowApp('home', { ...AFTER, finding: { ...AFTER.finding, then: null } }),
    withParams(ROUTINE, { to: 'Central Station' }),
  );
  assert.equal(plain.after.shown, null);
  assert.deepEqual(plain.after.words, ['Finding your driver', 'Searching 12s']);
  // A model looking: "still finding" is not the last screen, so the next one is waited for.
  const seen = [];
  const judge = async ({ els }) => {
    seen.push(els[0].text);
    return els[0].text.startsWith('Finding')
      ? { final: false, summary: 'still looking for a driver' }
      : { final: true, summary: 'Sam is on the way', result: { shows: { text: 'Your driver is on the way' } } };
  };
  const ph = new SlowApp('home', { ...AFTER, finding: { ...AFTER.finding, then: ['booked', 8] } });
  const r = await pressed(ph, withParams(ROUTINE, { to: 'Central Station' }), { judge });
  assert.deepEqual(seen, ['Finding your driver', 'Your driver is on the way']);
  assert.equal(r.after.judged.summary, 'Sam is on the way');
  assert.deepEqual(r.after.words.slice(0, 1), ['Your driver is on the way']);
  // A screen that never moves on from the confirmation screen is said so, after the wait.
  const stuck = new SlowApp('home', { ...AFTER, cars: { ...SCREENS.cars, go: {} } });
  const s = await pressed(stuck, withAfter({ shows: { text: 'never' }, wait: 5 }));
  assert.equal(s.after.changed, false);
  assert.equal(s.after.shown, false);
});

test('after the press any one of the screens it names will do, and a value is read by its place', async () => {
  const ph = new SlowApp('home', AFTER);
  const r = await pressed(
    ph,
    withAfter({
      shows: [{ textContains: 'is here' }, { textContains: 'on the way' }],
      read: { Name: { after: { text: 'Driver' } }, Time: { after: { text: 'Driver' }, next: 3 } },
    }),
  );
  assert.equal(r.after.shown, true);
  assert.deepEqual(r.after.values, { Name: 'Sam', Time: '4 min' });
});

// The driver found, said first in a notice sliding in over the app, while the app's own screen
// still says it is looking; then the app's own screen.
const NOTICE = { text: 'Your driver is on the way · Sam', tap: false, at: [40, 20] };
const finding = (notice) => ({
  ...AFTER,
  finding: { els: [...AFTER.finding.els, notice], then: ['booked', 12] },
});
const BOOKED = withAfter({
  shows: { textContains: 'on the way' },
  read: { Driver: { after: { text: 'Driver' } }, Arrives: { after: { text: 'Arrives in' } } },
});

test("after the press only the app's own screen counts: a notification over it with the same words does not", async () => {
  const r = await pressed(new SlowApp('home', finding({ ...NOTICE, pkg: 'com.android.systemui' })), BOOKED);
  assert.equal(r.after.shown, true);
  assert.deepEqual(r.after.words.slice(0, 1), ['Your driver is on the way'], "the app's own last screen, not the notice");
  assert.deepEqual(r.after.values, { Driver: 'Sam', Arrives: '4 min' });
});

test('a screen named as one the app shows while still working is waited past, even with the words of the last one on it', async () => {
  const ph = new SlowApp('home', finding(NOTICE)); // (a banner of the app's own)
  const r = await pressed(ph, {
    ...BOOKED,
    steps: [
      ...BOOKED.steps.slice(0, -1),
      { ...BOOKED.steps.at(-1), result: { ...BOOKED.steps.at(-1).result, waiting: { textContains: 'Finding your' } } },
    ],
  });
  assert.equal(r.after.shown, true);
  assert.ok(!r.after.words.includes('Finding your driver'), 'the picture is not of the screen still looking');
  assert.deepEqual(r.after.values, { Driver: 'Sam', Arrives: '4 min' });
});

test('the last screen is taken once it has stayed the same, not while it is still being drawn', async () => {
  const drawing = {
    ...AFTER,
    finding: { ...AFTER.finding, then: ['half', 2] },
    half: { els: [{ text: 'Your driver is on the way', tap: false }], then: ['booked', 3] },
  };
  // (Half drawn for longer than two looks at the screen, less than it must stay the same.)
  const r = await pressed(new SlowApp('home', drawing), BOOKED, { steadyMs: 1500 });
  assert.equal(r.after.shown, true);
  assert.deepEqual(r.after.values, { Driver: 'Sam', Arrives: '4 min' }, 'read once it was all there');
});

test('what comes after the press only looks: it is checked, and changing it keeps the routine approved', async () => {
  const { fingerprint } = await import('../plugins/android/routines.js');
  const r = structuredClone(ROUTINE);
  const later = { ...r, steps: [...r.steps.slice(0, -1), { ...r.steps.at(-1), result: { shows: { text: 'Booked' }, wait: 90 } }] };
  assert.equal(fingerprint(later), fingerprint(r));
  assert.deepEqual(validate(later, APP), []);
  const bad = (result) => validate({ ...r, steps: [...r.steps.slice(0, -1), { ...r.steps.at(-1), result }] }, APP);
  assert.match(bad({ wait: 2 }).join(), /result.wait/);
  assert.match(bad({ shows: 'Booked' }).join(), /result.shows/);
  assert.deepEqual(bad({ shows: [{ text: 'Booked' }, { text: 'Arrived' }] }), [], 'any of a few screens');
  assert.match(bad({ shows: [] }).join(), /result.shows/);
  assert.deepEqual(bad({ shows: { text: 'Booked' }, waiting: { textContains: 'Finding' } }), [], 'a screen to wait past');
  assert.match(bad({ waiting: [] }).join(), /result.waiting/);
  assert.match(bad({ waiting: 'Finding' }).join(), /result.waiting/);
  assert.deepEqual(bad({ read: { Car: { after: { text: 'Driver' }, next: 2 } } }), []);
  assert.match(bad({ read: { Car: { row_of: { text: 'Driver' }, next: 2 } } }).join(), /result.read/);
  assert.match(bad({ read: { Car: { after: { text: 'Driver' }, next: 40 } } }).join(), /result.read/);
  assert.match(bad({ tap: { text: 'x' } }).join(), /not tap/);
  // A step that does change something is still a change to approve.
  const more = { ...r, steps: [{ do: 'back' }, ...r.steps] };
  assert.notEqual(fingerprint(more), fingerprint(r));
});

// ---------- pictures, and changing a routine ----------

test("the owner's pictures: only pictures, a few at a time, copied; the screen after the press read off one", async () => {
  const { takePictures, resultFromPicture, MAX_PICTURES } = await import('../plugins/android/pictures.js');
  const { PATTERNS } = await import('../plugins/android/learn.js');
  const pic = path.join(dir, 'shot.png');
  fs.writeFileSync(pic, 'picture');
  const got = await takePictures([pic], media);
  assert.equal(got.length, 1);
  assert.notEqual(got[0], pic);
  assert.ok(fs.existsSync(got[0]));
  await assert.rejects(takePictures([path.join(dir, 'notes.txt')], media), /not a picture/);
  await assert.rejects(takePictures(Array(MAX_PICTURES + 1).fill(pic), media), /At most/);
  await assert.rejects(takePictures([path.join(dir, 'gone.png')], media), /no file/);
  assert.deepEqual(
    resultFromPicture(
      {
        pictures: [2],
        shows: ['Your driver is on the way'],
        read: [
          { name: 'Arrives', label: 'Arrives in', lines: 1, kind: 'time' },
          { name: 'bad name!', label: 'x', lines: 1 },
        ],
      },
      PATTERNS,
    ),
    {
      shows: { textContains: 'Your driver is on the way' },
      read: { Arrives: { after: { textContains: 'Arrives in' }, pattern: PATTERNS.time } },
    },
  );
  // Two pictures of the same screen in two states: either will do; a value with no label of its
  // own is read by its place under fixed words.
  assert.deepEqual(
    resultFromPicture(
      {
        pictures: [1, 2],
        shows: ['Your driver is on the way', 'Your driver is here', 'Your driver is on the way'],
        read: [{ name: 'Car', label: 'Your driver', lines: 2 }],
      },
      PATTERNS,
    ),
    {
      shows: [{ textContains: 'Your driver is on the way' }, { textContains: 'Your driver is here' }],
      read: { Car: { after: { textContains: 'Your driver' }, next: 2 } },
    },
  );
  assert.deepEqual(
    resultFromPicture(
      { pictures: [1, 2], shows: ['Your driver is on the way'], waiting: ['Finding your driver', 'x'], read: [] },
      PATTERNS,
    ),
    { shows: { textContains: 'Your driver is on the way' }, waiting: { textContains: 'Finding your driver' } },
    'a picture of the screen while it is still looking: waited past',
  );
  assert.equal(resultFromPicture({ shows: ['12'] }, PATTERNS), null, 'only words that will be there every time');
});

test('a change in plain words: steps put in where they go, and what changed said line by line', async () => {
  const { spliced, changes } = await import('../plugins/android/edit.js');
  const s = [
    { do: 'tap', target: { text: 'A' }, why: 'open A' },
    { do: 'tap', target: { text: 'B' } },
    { do: 'confirm', button: { text: 'Go' } },
  ];
  const added = [{ do: 'tap', target: { text: 'Comfort' }, why: 'choose Comfort' }];
  assert.deepEqual(spliced(s, 2, 0, added), [s[0], s[1], added[0], s[2]]);
  assert.deepEqual(spliced(s, 1, 1, added), [s[0], added[0], s[2]]);
  assert.deepEqual(changes(s, spliced(s, 1, 1, added)), ['− 2. tap "B"', '+ 2. choose Comfort']);
});

test("learning a change goes on from where the routine is: the app is not started again, and the routine's own confirmation screen ends it", async () => {
  const { Learner } = await import('../plugins/android/learn.js');
  const dev = new FakeDevice('cars');
  let restarted = 0;
  Object.assign(dev, { startApp: async () => restarted++ });
  const idx = (els, w) => els.findIndex((e) => (e.text ?? e.description) === w);
  const script = [
    () => ({ thought: 'start again', do: 'restart' }),
    ({ els }) => ({ thought: 'choose Large', do: 'tap', element: idx(els, 'Large'), why: 'choose Large' }),
    ({ els }) => ({ thought: 'the booking button', do: 'confirm_screen', button: idx(els, 'Book now') }),
  ];
  let k = 0;
  const told = [];
  const learner = new Learner(dev, {
    app: APP,
    goal: 'choose the Large car',
    think: async (x) => (told.push(x.goingOn), script[k++](x)),
    media,
    goingOn: { before: ROUTINE.steps.slice(0, 4), next: ROUTINE.steps[5] },
  });
  const got = await learner.run();
  assert.equal(got.ended, 'done');
  assert.equal(restarted, 0);
  assert.deepEqual(learner.steps, [{ do: 'tap', target: { description: 'Large' }, why: 'choose Large' }]);
  assert.ok(told[0].next, 'the model is told what comes after the new part');
});
