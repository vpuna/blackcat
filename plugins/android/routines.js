// Devices, routines, apps and runs, in the plugin's own database (android.db in its private folder):
//   devices   each one paired, by the name the owner gave it ("phone", "tv"): its serial, its
//             address when it is reached on the network, what it is
//   routines  a goal in one app: its steps, what it asks for, where it stops; and whether
//             the owner approved it, with a fingerprint of the steps then, so an edited
//             routine is a draft again until it is tried and approved
//   apps      what an app's routines share: pop-ups to clear, the buttons that book, pay or
//             send, notes. Added to as pop-ups are met.
//   runs      each run: on which device, when, how it ended, at which step, how long, what was read
// The owner sees one whole with `show --json` and puts an edited copy back with `add <file>`,
// through the same checks.
import crypto from 'node:crypto';
import path from 'node:path';
import { now, openSqlite, upgrade, withDb } from '../../src/api.js';
import { ADDRESS, AndroidError, PACKAGE } from './device.js';
import { TARGET_KEYS } from './screen.js';

export const NAME = /^[a-z][a-z0-9-]{1,40}$/;
const STEPS = [
  'tap',
  'type',
  'check',
  'wait',
  'if_shown',
  'choose',
  'scroll',
  'focus',
  'stop',
  'unless_shown',
  'back',
  'key',
  'digits',
  'close_app',
  'confirm',
];
// The keys a step may press: a phone's, and a TV remote's.
export const KEYS = [
  'BACK',
  'HOME',
  'ENTER',
  'TAB',
  'SEARCH',
  'MENU',
  'DPAD_UP',
  'DPAD_DOWN',
  'DPAD_LEFT',
  'DPAD_RIGHT',
  'DPAD_CENTER',
  'MEDIA_PLAY_PAUSE',
  'MEDIA_PLAY',
  'MEDIA_PAUSE',
  'MEDIA_STOP',
  'MEDIA_NEXT',
  'MEDIA_PREVIOUS',
  'MEDIA_FAST_FORWARD',
  'MEDIA_REWIND',
  'VOLUME_UP',
  'VOLUME_DOWN',
  'VOLUME_MUTE',
  'CHANNEL_UP',
  'CHANNEL_DOWN',
  'GUIDE',
  'INFO',
];
export const ARROWS = ['DPAD_UP', 'DPAD_DOWN', 'DPAD_LEFT', 'DPAD_RIGHT'];
// How a run leaves the device: its home screen with the screen off (a phone's way), its home
// screen, or as the routine left it (a TV's way: what was started goes on playing).
export const AFTER = ['sleep', 'home', 'stay'];
// How a run starts: the app from its first screen (`fresh`), or as it is, already in front on a
// device that is awake (`running`: a TV app showing a channel, say).
export const START = ['fresh', 'running'];

const SHAPE = [
  (db) =>
    db.exec(`
      CREATE TABLE devices (name TEXT PRIMARY KEY, serial TEXT NOT NULL UNIQUE, address TEXT, maker TEXT, model TEXT,
        android TEXT, sdk INTEGER, tv INTEGER NOT NULL, paired_ts INTEGER NOT NULL);
      CREATE TABLE routines (name TEXT PRIMARY KEY, app TEXT NOT NULL, body TEXT NOT NULL, created_ts INTEGER NOT NULL,
        updated_ts INTEGER NOT NULL, approved_fp TEXT, approved_ts INTEGER);
      CREATE TABLE apps (package TEXT PRIMARY KEY, body TEXT NOT NULL, updated_ts INTEGER NOT NULL);
      CREATE TABLE runs (id INTEGER PRIMARY KEY, routine TEXT NOT NULL, device TEXT, ts INTEGER NOT NULL, outcome TEXT NOT NULL, step TEXT,
        seconds INTEGER, fingerprint TEXT NOT NULL, dry INTEGER NOT NULL, read TEXT, error TEXT);
      CREATE INDEX runs_by_routine ON runs (routine, ts);
    `),
  // What the agent may run on each with `adb`: read, ask or full (as for a machine over SSH).
  (db) => db.exec("ALTER TABLE devices ADD COLUMN mode TEXT NOT NULL DEFAULT 'ask'"),
  // What a model found when a step failed, and what was done about it (recover.js).
  (db) => db.exec('ALTER TABLE runs ADD COLUMN recoveries TEXT'),
  // The key the server on each device was last started with (by what adb knows it as).
  (db) => db.exec('CREATE TABLE server_keys (target TEXT PRIMARY KEY, key TEXT NOT NULL, started_ts INTEGER NOT NULL)'),
];
const open = (ctx) => () => {
  const db = openSqlite(path.join(ctx.dataDir, 'android.db'));
  upgrade(db, 'android', SHAPE);
  return db;
};
const use = (ctx, fn) => withDb(open(ctx), fn);

// What the owner approves: everything up to the press. What comes after it (the confirmation
// step's `result`: which screen to wait for, what to read there) only looks, so it is left out.
const approvedPart = (r) =>
  r?.steps?.some((s) => s?.do === 'confirm' && s.result)
    ? { ...r, steps: r.steps.map((s) => (s?.do === 'confirm' && s.result ? (({ result, ...rest }) => rest)(s) : s)) }
    : r;
export const fingerprint = (r) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify(approvedPart(r)))
    .digest('hex')
    .slice(0, 16);

// ---------- the key of the server on a device ----------
// A new one at each start (device.js, ensureServer); every blackcat process reads it here.
export const serverKey = (ctx, target) =>
  use(ctx, (db) => db.prepare('SELECT key FROM server_keys WHERE target = ?').pluck().get(target) ?? null);
export const setServerKey = (ctx, target, key) =>
  use(ctx, (db) =>
    db
      .prepare(
        'INSERT INTO server_keys (target, key, started_ts) VALUES (?, ?, ?) ON CONFLICT (target) DO UPDATE SET key = excluded.key, started_ts = excluded.started_ts',
      )
      .run(target, key, now()),
  );
export const dropServerKey = (ctx, target) => use(ctx, (db) => db.prepare('DELETE FROM server_keys WHERE target = ?').run(target));

// ---------- devices ----------

export const DEVICE_NAME = /^[a-z][a-z0-9-]{0,20}$/;
const deviceOf = (row) => row && { ...row, tv: !!row.tv, label: `${row.maker ?? ''} ${row.model ?? ''}`.trim() || row.serial };
export const listDevices = (ctx) => use(ctx, (db) => db.prepare('SELECT * FROM devices ORDER BY paired_ts, name').all().map(deviceOf));
export const getDevice = (ctx, name) => use(ctx, (db) => deviceOf(db.prepare('SELECT * FROM devices WHERE name = ?').get(name)));

// Paired again (the same serial): the one row, under the name and address given now.
export function saveDevice(ctx, d) {
  if (!DEVICE_NAME.test(d.name ?? ''))
    throw new AndroidError(`"${d.name}" is not a name for a device (lowercase letters, digits and dashes, like phone or tv)`);
  if (d.address != null && !ADDRESS.test(d.address)) throw new AndroidError(`"${d.address}" is not an address (host:port)`);
  use(ctx, (db) =>
    db.transaction(() => {
      // (Renamed: what the owner chose for it goes with it.)
      const was = db.prepare('SELECT mode FROM devices WHERE serial = ? AND name != ?').pluck().get(d.serial, d.name);
      db.prepare('DELETE FROM devices WHERE serial = ? AND name != ?').run(d.serial, d.name);
      if (was && !d.mode) d = { ...d, mode: was };
      db.prepare(
        `INSERT INTO devices (name, serial, address, maker, model, android, sdk, tv, paired_ts, mode)
           VALUES (@name, @serial, @address, @maker, @model, @android, @sdk, @tv, @ts, @mode)
         ON CONFLICT (name) DO UPDATE SET serial = excluded.serial, address = excluded.address, maker = excluded.maker,
           model = excluded.model, android = excluded.android, sdk = excluded.sdk, tv = excluded.tv, paired_ts = excluded.paired_ts,
           mode = CASE WHEN @given THEN excluded.mode ELSE devices.mode END`,
      ).run({
        address: null,
        maker: null,
        model: null,
        android: null,
        sdk: null,
        ...d,
        tv: d.tv ? 1 : 0,
        ts: now(),
        mode: d.mode ?? 'ask',
        given: d.mode ? 1 : 0,
      });
    })(),
  );
}
export const setMode = (ctx, name, mode) =>
  use(ctx, (db) => db.prepare('UPDATE devices SET mode = ? WHERE name = ?').run(mode, name).changes > 0);
export const deleteDevice = (ctx, name) => use(ctx, (db) => db.prepare('DELETE FROM devices WHERE name = ?').run(name).changes > 0);

// ---------- apps ----------

const NO_APP = (pkg) => ({ package: pkg, popups: [], commit: [], notes: [] });
export function loadApp(ctx, pkg) {
  const body = use(ctx, (db) => db.prepare('SELECT body FROM apps WHERE package = ?').pluck().get(pkg));
  return { ...NO_APP(pkg), ...(body ? JSON.parse(body) : {}) };
}

export function appProblems(a) {
  const out = [];
  if (!PACKAGE.test(a?.package ?? '')) out.push('"package": the package name of the app, like com.example.app');
  if (a.popups && !(Array.isArray(a.popups) && a.popups.every((x) => isTarget(x?.when) && isTarget(x?.tap))))
    out.push('"popups": a list of { "when": an element, "tap": an element }');
  if (a.commit && !(Array.isArray(a.commit) && a.commit.every((x) => typeof x === 'string' && x.trim())))
    out.push('"commit": the labels of the buttons that book, pay or send');
  return out;
}

export function saveApp(ctx, a) {
  use(ctx, (db) =>
    db
      .prepare(
        'INSERT INTO apps (package, body, updated_ts) VALUES (?, ?, ?) ON CONFLICT (package) DO UPDATE SET body = excluded.body, updated_ts = excluded.updated_ts',
      )
      .run(a.package, JSON.stringify({ ...NO_APP(a.package), ...a }), now()),
  );
}

export const listApps = (ctx) =>
  use(ctx, (db) =>
    db
      .prepare('SELECT body FROM apps ORDER BY package')
      .pluck()
      .all()
      .map((b) => JSON.parse(b)),
  );

// ---------- routines ----------

export const listRoutines = (ctx) => use(ctx, (db) => db.prepare('SELECT name FROM routines ORDER BY name').pluck().all());

const rowOf = (ctx, name) => use(ctx, (db) => db.prepare('SELECT * FROM routines WHERE name = ?').get(name));

export function loadRoutine(ctx, name) {
  if (!NAME.test(name ?? '')) throw new AndroidError(`"${name}" is not a routine's name (lowercase letters, digits and dashes)`);
  const row = rowOf(ctx, name);
  if (!row) throw new AndroidError(`There is no routine called "${name}". bc android list shows them.`);
  const r = JSON.parse(row.body);
  const problems = validate(r, loadApp(ctx, r.app));
  if (problems.length) throw new AndroidError(`The routine "${name}" has mistakes:\n- ${problems.join('\n- ')}`);
  return r;
}

// → true when it replaced one. A routine saved is a draft until it is approved again.
export function saveRoutine(ctx, r) {
  return use(ctx, (db) => {
    const had = db.prepare('SELECT 1 FROM routines WHERE name = ?').get(r.name);
    db.prepare(
      'INSERT INTO routines (name, app, body, created_ts, updated_ts) VALUES (@name, @app, @body, @ts, @ts) ON CONFLICT (name) DO UPDATE SET app = excluded.app, body = excluded.body, updated_ts = excluded.updated_ts',
    ).run({ name: r.name, app: r.app, body: JSON.stringify(r), ts: now() });
    return !!had;
  });
}

export const deleteRoutine = (ctx, name) => use(ctx, (db) => db.prepare('DELETE FROM routines WHERE name = ?').run(name).changes > 0);

export function setApproved(ctx, name, r) {
  use(ctx, (db) => db.prepare('UPDATE routines SET approved_fp = ?, approved_ts = ? WHERE name = ?').run(fingerprint(r), now(), name));
}

// Approved, draft, or edited since it was approved.
export function stateOf(ctx, name, r) {
  const row = rowOf(ctx, name);
  if (!row?.approved_fp) return 'draft';
  return row.approved_fp === fingerprint(r) ? 'approved' : 'edited since it was approved';
}

// ---------- runs ----------

export function recordRun(ctx, r, x) {
  use(ctx, (db) =>
    db
      .prepare(
        'INSERT INTO runs (routine, device, ts, outcome, step, seconds, fingerprint, dry, read, error, recoveries) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        r.name,
        x.device ?? null,
        now(),
        x.outcome,
        x.step ?? null,
        x.seconds ?? null,
        fingerprint(r),
        x.dry ? 1 : 0,
        x.values ? JSON.stringify(x.values) : null,
        x.error ?? null,
        x.recoveries?.length ? JSON.stringify(x.recoveries.map(({ shot, ...t }) => t)) : null,
      ),
  );
}

export function lastRun(ctx, name) {
  const row = use(ctx, (db) => db.prepare('SELECT * FROM runs WHERE routine = ? ORDER BY id DESC LIMIT 1').get(name));
  return row ? { ...row, read: row.read ? JSON.parse(row.read) : null } : null;
}

const isTarget = (t) =>
  t &&
  typeof t === 'object' &&
  Object.keys(t).length &&
  Object.keys(t).every((k) => TARGET_KEYS.includes(k)) &&
  (t.below == null || (isTarget(t.below) && t.below.below == null));

// What is wrong with a routine, as sentences (an empty list when nothing is).
export function validate(r, app) {
  const out = [];
  if (!r || typeof r !== 'object') return ['it is not a JSON object'];
  if (!NAME.test(r.name ?? '')) out.push('"name": lowercase letters, digits and dashes');
  if (!PACKAGE.test(r.app ?? '')) out.push('"app": the package name of the app, like com.example.app');
  if (r.device != null && !DEVICE_NAME.test(r.device)) out.push('"device": the name of a paired device, like phone or tv');
  if (r.after != null && !AFTER.includes(r.after)) out.push(`"after": one of ${AFTER.join(', ')}`);
  if (r.start != null && !START.includes(r.start))
    out.push('"start": fresh (the app from its first screen) or running (the app as it is, already in front)');
  if (r.picture != null && typeof r.picture !== 'boolean')
    out.push('"picture": true sends the screen at the end (after the press, for one with a confirmation); false, none');
  if (r.params && (typeof r.params !== 'object' || Object.keys(r.params).some((k) => !/^[a-z][a-zA-Z0-9]*$/.test(k))))
    out.push('"params": names in camelCase, each with a "summary"');
  if (!Array.isArray(r.steps) || !r.steps.length) out.push('"steps": a list of steps');
  let confirms = 0;
  const check = (steps, where) =>
    (steps ?? []).forEach((s, i) => {
      const at = `${where}${i + 1}`;
      if (!STEPS.includes(s?.do)) return out.push(`step ${at}: "do" is one of ${STEPS.join(', ')}`);
      if (['tap', 'check', 'wait', 'if_shown', 'unless_shown'].includes(s.do) && !isTarget(s.target))
        out.push(`step ${at}: "target" names an element (${TARGET_KEYS.join(', ')})`);
      if (s.do === 'type' && typeof s.text !== 'string') out.push(`step ${at}: "text" is what to type`);
      if (s.keyboard != null && !(s.do === 'type' && s.keyboard === 'keep'))
        out.push(`step ${at}: "keyboard": "keep" leaves the keyboard open after typing`);
      if (s.do === 'check' && typeof s.text_contains !== 'string' && s.text_contains !== undefined)
        out.push(`step ${at}: "text_contains" is text`);
      if (s.do === 'key' && !KEYS.includes(s.key)) out.push(`step ${at}: "key" is one of ${KEYS.join(', ')}`);
      // (A channel or a code on a TV: a number, or a value that must be one when it is given.)
      if (s.do === 'digits' && !(typeof s.number === 'string' && /^(\d{1,6}|\{\{\w+\}\})$/.test(s.number)))
        out.push(`step ${at}: "number" is pressed digit by digit: up to 6 digits, or a value such as "{{channel}}"`);
      if (s.times != null && !(s.do === 'key' && Number.isInteger(s.times) && s.times >= 1 && s.times <= 20))
        out.push(`step ${at}: "times" is how often a key is pressed, 1 to 20`);
      if (s.retry != null && !(s.do === 'tap' && s.retry === false))
        out.push(`step ${at}: "retry": false is for a tap that must not be repeated`);
      if (s.do === 'stop' && !(typeof s.say === 'string' && s.say.trim())) out.push(`step ${at}: "say" is why the routine stops there`);
      if (s.do === 'focus' && !(isTarget(s.target) && (s.key == null || ARROWS.includes(s.key))))
        out.push(`step ${at}: "target" names the element to move to, and "key" the arrow that moves there (${ARROWS.join(', ')})`);
      if (s.do === 'scroll' && !isTarget(s.until)) out.push(`step ${at}: "until" names the element to scroll to`);
      if (s.do === 'choose' && !(isTarget(s.option) && Array.isArray(s.options) && s.options.every(isTarget)))
        out.push(`step ${at}: "option" and "options" name elements`);
      if (s.do === 'if_shown' || s.do === 'unless_shown') check(s.then, `${at}.`);
      if (s.do === 'confirm') {
        confirms++;
        if (where) out.push(`step ${at}: the confirmation step is the last step, not inside another`);
        if (i !== steps.length - 1) out.push(`step ${at}: nothing may come after the confirmation step`);
        if (!isTarget(s.button)) out.push(`step ${at}: "button" names the button that books, pays or sends`);
        if (s.must_show && !(Array.isArray(s.must_show) && s.must_show.every(isTarget)))
          out.push(`step ${at}: "must_show" is a list of elements`);
        check(s.cancel, `${at} cancel `);
        out.push(...resultProblems(s.result, at));
      }
      // A button that books, pays or sends is pressed only by the confirmation step, on the owner's word.
      if (s.do === 'tap' && commits(app, s.target))
        out.push(`step ${at} taps "${commitWord(app, s.target)}", which books, pays or sends: only the confirmation step may`);
    });
  check(r.steps, '');
  if (confirms > 1) out.push('one confirmation step only');
  if (!confirms && app.commit.length)
    out.push(`${r.app} has buttons that book, pay or send, so a routine for it ends with a confirmation step`);
  for (const k of r.params ? Object.keys(r.params) : [])
    if (!JSON.stringify(r.steps).includes(`{{${k}}}`)) out.push(`"params": ${k} is never used`);
  // Steps for when an optional value is given, or is not (only_with / only_without).
  const conditions = (steps) =>
    (steps ?? []).flatMap((s) =>
      [s?.only_with, s?.only_without, ...conditions(s?.then), ...conditions(s?.cancel)].filter((x) => x != null),
    );
  for (const k of conditions(r.steps))
    if (!r.params?.[k]) out.push(`only_with / only_without: ${k} is not in "params"`);
    else if (!r.params[k].optional) out.push(`only_with / only_without: ${k} is always given; mark it "optional": true`);
  for (const [, k] of JSON.stringify(r.steps ?? []).matchAll(/\{\{(\w+)\}\}/g))
    if (!r.params?.[k]) out.push(`{{${k}}} is used but not in "params"`);
  return [...new Set(out)];
}

// The screen after the press (`result`): what shows when the app is done (`shows`: an element,
// or a list of them when the app ends on one of a few screens, any of which will do), what shows
// while it is still working, to wait past even when `shows` is there too (`waiting`), how long to
// wait for it (`wait`, in seconds) and what to read there (`read`, as at the confirmation screen;
// `next` reads the n-th text after `after`, for a value with no label of its own beside it).
export const RESULT_WAIT = { least: 5, most: 600 };
export const MAX_SIGNS = 4;
export const MAX_NEXT = 6;
export const signsOf = (shows) => (shows == null ? [] : [shows].flat());
const isRead = (x) =>
  x &&
  typeof x === 'object' &&
  !Array.isArray(x) &&
  Object.values(x).every(
    (h) =>
      h &&
      ['after', 'row_of', 'target'].some((k) => isTarget(h[k])) &&
      (h.pattern == null || typeof h.pattern === 'string') &&
      (h.next == null || (h.after && Number.isInteger(h.next) && h.next >= 1 && h.next <= MAX_NEXT)),
  );
function resultProblems(x, at) {
  if (x == null) return [];
  const out = [];
  if (typeof x !== 'object' || Array.isArray(x))
    return [`step ${at}: "result" says what shows after the press: shows, waiting, wait, read`];
  for (const k of Object.keys(x))
    if (!['shows', 'waiting', 'wait', 'read'].includes(k)) out.push(`step ${at}: "result" has shows, waiting, wait and read, not ${k}`);
  const signs = signsOf(x.shows);
  if (x.shows != null && (!signs.length || signs.length > MAX_SIGNS || !signs.every(isTarget)))
    out.push(
      `step ${at}: "result.shows" names an element of the screen after the press, or a list of up to ${MAX_SIGNS}, any of which will do`,
    );
  const holds = signsOf(x.waiting);
  if (x.waiting != null && (!holds.length || holds.length > MAX_SIGNS || !holds.every(isTarget)))
    out.push(
      `step ${at}: "result.waiting" names an element the app shows while it is still working ("Finding a driver"), or a list of up to ${MAX_SIGNS}`,
    );
  if (x.wait != null && !(Number.isInteger(x.wait) && x.wait >= RESULT_WAIT.least && x.wait <= RESULT_WAIT.most))
    out.push(`step ${at}: "result.wait" is how many seconds to wait, ${RESULT_WAIT.least} to ${RESULT_WAIT.most}`);
  if (x.read != null && !isRead(x.read)) out.push(`step ${at}: "result.read" is like the confirmation step's "read"`);
  return out;
}

// The app's commit buttons are whole labels ("Pay", "Place order"), compared without case: a tile
// called "Book a table" is not the button "Book".
const wordsOf = (t) => [t.text, t.textContains, t.description, t.descriptionContains].filter(Boolean);
const same = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
const commitWord = (app, t) => wordsOf(t).find((w) => app.commit.some((c) => same(w, c)));
export const commits = (app, t) => !!commitWord(app, t ?? {});

// The routine with each {{param}} replaced by its value. Values are typed or matched, never
// run, but are still kept to one plain line.
export function withParams(r, given) {
  const values = {};
  for (const [k, spec] of Object.entries(r.params ?? {})) {
    const v = given[k] ?? spec.default;
    // (A value marked optional may be left out: the steps marked only_with it are left out too.)
    if ((v == null || v === '') && spec.optional) {
      values[k] = '';
      continue;
    }
    if (v == null || v === '') throw new AndroidError(`"${r.name}" needs ${k} (${spec.summary ?? k}): --set ${k}="…"`);
    if (String(v).length > 200 || /[\n\r\t\u0000-\u001f]/.test(String(v))) throw new AndroidError(`${k} must be one line of text`);
    values[k] = String(v);
  }
  for (const k of Object.keys(given))
    if (!(k in values)) throw new AndroidError(`"${r.name}" has no ${k}; it takes: ${Object.keys(values).join(', ') || 'nothing'}`);
  const fill = (x) =>
    typeof x === 'string'
      ? x.replace(/\{\{(\w+)\}\}/g, (_, k) => values[k])
      : Array.isArray(x)
        ? x.map(fill)
        : x && typeof x === 'object'
          ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, fill(v)]))
          : x;
  return { ...r, steps: fill(r.steps), values };
}
