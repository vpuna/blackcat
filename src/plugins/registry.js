import { jobSchedule, jobShapeProblem, summary as scheduleSummary } from '../util/schedule.js';
import { registerSource } from '../archive/sources.js';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DATA, HOME, load, update } from '../config.js';
import { log } from '../log.js';
import { CODE_DIR } from '../service/units.js';
import { validateSteps } from './forms.js';
import { storeFor } from '../store.js';
import { pause } from '../util/wait.js';

// Plugins are folders containing a plugin.js whose default export is a manifest.
// Bundled ones ship in the repo; your own go in user-plugins/ (git-ignored).
// A plugin only runs once it has been enabled: `bc plugin enable <name>`.
export const BUNDLED_DIR = path.join(CODE_DIR, 'plugins');
export const USER_DIR = path.join(HOME, 'user-plugins');
export const PLUGIN_DATA = path.join(DATA, 'plugins');
export const API = 1;
export const LEVELS = ['allow', 'ask', 'owner', 'never'];

// Names blackcat itself uses for top-level commands.
const RESERVED = new Set([
  'selftest',
  'status',
  'start',
  'stop',
  'restart',
  'logs',
  'service',
  'plugin',
  'help',
  'setup',
  'agent',
  'chat',
  'permissions',
  'channel',
  'notify',
]);

// The words a plugin's commands hang under: `bc <mount> <command>`. Usually its name;
// `mount: 'tg account'` puts them under an existing group.
export const mountOf = (m) => (m.mount ?? m.name).split(' ');

// An error meant for the person using the plugin: shown as a message, not a stack trace.
export class PluginError extends Error {}

const NAME = /^[a-z][a-z0-9-]{1,20}$/;

// Every key a manifest may have, and what kind of thing it is. A key that is not here is a
// mistake (most often a misspelling, which would otherwise do nothing and say nothing), and
// so is one of the wrong kind. `fn` may be async; `sync` is a function whose answer is used
// on the spot, so it may not be.
const SHAPE = {
  manifest: {
    uses: 'array',
    api: 'number',
    name: 'string',
    title: 'string',
    description: 'string',
    help: 'string',
    mount: 'string',
    default: 'boolean',
    commands: 'object',
    jobs: 'array',
    services: 'array',
    chat: 'object',
    channel: 'object',
    engine: 'object',
    agent: 'object',
    source: 'object',
    storage: 'object',
    checks: 'any',
    when: 'sync',
    status: 'fn',
    settings: 'fn',
    agenda: 'fn',
    names: 'sync',
    briefing: 'fn',
    // What the core asks of any part that has something to say (see docs/plugins.md, "Core hooks").
    nudgeDone: 'sync',
    waiting: 'fn',
    inboxKeeps: 'fn',
    ownerMoved: 'fn',
    privateData: 'array',
    aliases: 'sync',
    selftest: 'fn',
  },
  command: {
    summary: 'string',
    run: 'fn',
    access: 'any',
    usage: 'string',
    options: 'array',
    form: 'any',
    working: 'string',
    raw: 'boolean',
    interactive: 'boolean',
    hidden: 'boolean',
    long: 'boolean',
    sends: 'boolean',
    untrusted: 'boolean',
    standard: 'boolean',
  },
  service: { id: 'string', summary: 'string', command: 'string', ready: 'fn', health: 'fn' },
  job: { id: 'string', summary: 'string', run: 'fn', when: 'sync', cron: 'any', every: 'any', at: 'any' },
  chat: { commands: 'any', install: 'fn', tick: 'fn', quick: 'fn', voice: 'fn', stop: 'fn' },
  agent: { fill: 'sync', readDirs: 'sync', listCommands: 'boolean', notes: 'any' },
  channel: { label: 'string', can: 'object', paired: 'sync', self: 'sync', open: 'fn', start: 'fn' },
  engine: {
    label: 'string',
    process: 'string',
    shapes: 'boolean',
    choices: 'fn',
    ready: 'fn',
    converse: 'fn',
    ask: 'fn',
    has: 'fn',
    forget: 'fn',
    ownResult: 'fn',
    where: 'fn',
  },
  storage: { label: 'string', places: 'sync', list: 'fn', mkdir: 'fn', put: 'fn', get: 'fn', remove: 'fn', free: 'fn' },
  source: {
    id: 'string',
    label: 'string',
    optIn: 'boolean',
    textLimit: 'number',
    todoLimit: 'number',
    todoText: 'string',
    todoQuestion: 'string',
    connected: 'sync',
    collects: 'sync',
    fetchMedia: 'fn',
  },
};
const isAsync = (f) => f?.constructor?.name === 'AsyncFunction';
const KIND = {
  any: () => true,
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  array: (v) => Array.isArray(v),
  object: (v) => !!v && typeof v === 'object' && !Array.isArray(v),
  fn: (v) => typeof v === 'function',
  sync: (v) => typeof v === 'function' && !isAsync(v),
};
const PART_WORD = { manifest: 'a manifest', command: 'a command', service: 'a service', job: 'a job' };
const KIND_WORD = {
  string: 'text',
  number: 'a number',
  boolean: 'true or false',
  array: 'a list',
  object: 'an object',
  fn: 'a function',
  sync: 'a function that answers at once (not async)',
};
// The known key nearest to a misspelt one, if any is near.
function nearest(word, known) {
  const dist = (a, b) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  };
  const best = known.map((k) => [dist(word.toLowerCase(), k.toLowerCase()), k]).sort((x, y) => x[0] - y[0])[0];
  return best && best[0] <= Math.max(2, Math.floor(word.length / 3)) ? best[1] : null;
}
// → problems with one part of a manifest: keys it may not have, and keys of the wrong kind.
function shapeProblems(part, value, at) {
  const out = [];
  if (!KIND.object(value)) return out;
  const known = SHAPE[part];
  for (const [k, v] of Object.entries(value)) {
    if (!(k in known)) {
      const like = nearest(k, Object.keys(known));
      out.push(
        `${at ? `${at}.` : ''}${k} is not something ${PART_WORD[part] ?? `the ${part} part`} has${like ? ` (did you mean "${like}"?)` : ''}`,
      );
    } else if (v != null && !KIND[known[k]](v)) out.push(`${at ? `${at}.` : ''}${k} must be ${KIND_WORD[known[k]]}`);
  }
  return out;
}

// Returns a list of problems with a manifest (empty when it's fine).
export function problems(m, dirName) {
  const out = [];
  const need = (ok, msg) => ok || out.push(msg);
  if (!m || typeof m !== 'object') return ['plugin.js must `export default` a manifest object'];
  out.push(...shapeProblems('manifest', m, ''));
  for (const [n, c] of Object.entries(KIND.object(m.commands) ? m.commands : {})) out.push(...shapeProblems('command', c, `commands.${n}`));
  for (const sv of Array.isArray(m.services) ? m.services : []) out.push(...shapeProblems('service', sv, `services.${sv?.id ?? '?'}`));
  for (const j of Array.isArray(m.jobs) ? m.jobs : []) out.push(...shapeProblems('job', j, `jobs.${j?.id ?? '?'}`));
  for (const k of ['chat', 'agent', 'channel', 'engine', 'source', 'storage']) out.push(...shapeProblems(k, m[k], k));
  out.push(...shapeProblems('chat', m.telegram, 'telegram'));
  // (What follows reads into those parts: with one of them the wrong kind of thing, that is all there is to say.)
  if (
    out.length &&
    ['commands', 'jobs', 'services', 'chat', 'telegram', 'channel', 'engine', 'agent', 'source', 'storage'].some(
      (k) => m[k] != null && !KIND[SHAPE.manifest[k]](m[k]),
    )
  )
    return out;
  need(m.api === API, `api must be ${API} (the plugin API version this blackcat supports)`);
  need(
    typeof m.name === 'string' && NAME.test(m.name),
    'name must be lowercase letters, digits and dashes (2-21 characters, starting with a letter)',
  );
  need(m.name === dirName, `name ("${m.name}") must match its folder name ("${dirName}")`);
  if (m.when != null) need(typeof m.when === 'function', 'when must be a function');
  // Its notes for the agent are a file beside it (agent.md); the manifest only fills it in.
  if (m.agent?.fill != null)
    need(typeof m.agent.fill === 'function', 'agent.fill must be a function of ctx that returns the values for agent.md');
  // Its commands may not take over one of blackcat's own. (A plugin may sit under one, as a
  // group: the Telegram plugin's commands are `bc tg account …`, beside the core's `bc tg bot …`.)
  const top = String(m.mount ?? m.name)
    .trim()
    .split(/\s+/);
  need(
    !(RESERVED.has(top[0]) && top.length === 1),
    `"${top[0]}" is a blackcat command: mount the plugin's commands under it ("${top[0]} <word>") or choose another name`,
  );
  need(typeof m.title === 'string' && m.title, 'title is required');
  need(typeof m.description === 'string' && m.description, 'description is required');
  const cmds = m.commands;
  if (!cmds || typeof cmds !== 'object' || !Object.keys(cmds).length) out.push('commands must define at least one command');
  else {
    for (const [name, c] of Object.entries(cmds)) {
      const at = `commands.${name}`;
      need(NAME.test(name) || /^[a-z]$/.test(name), `${at}: command names are lowercase letters, digits and dashes`);
      need(typeof c.summary === 'string' && c.summary, `${at}.summary is required`);
      need(typeof c.run === 'function', `${at}.run must be a function`);
      need(typeof c.access === 'function' || LEVELS.includes(c.access), `${at}.access must be one of ${LEVELS.join(', ')} or a function`);
      // (A form given as a function is worked out, and checked, once every plugin has loaded.)
      if (c.form && typeof c.form !== 'function') out.push(...validateSteps(c.form).map((p) => `${at}.form: ${p}`));
      need(!(c.form && c.raw), `${at}: a command can't have both form and raw`);
      need(!(c.form && c.interactive), `${at}: a command can't have both form and interactive`);
      for (const o of c.options ?? [])
        need(
          Array.isArray(o) && typeof o[0] === 'string' && typeof o[1] === 'string',
          `${at}.options entries are [flags, description, default?]`,
        );
    }
  }
  // Its own folders at the top of the data folder that hold a login or the like: named so the agent is kept from them by name too.
  for (const n of Array.isArray(m.privateData) ? m.privateData : [])
    need(
      typeof n === 'string' && /^[a-z][a-z0-9.-]{1,40}$/.test(n) && !/-media$/.test(n) && !n.includes('..'),
      "privateData is a list of names of your own: a folder at the top of the data folder that holds a login, or a database in your private folder, e.g. ['sms-account', 'sms.db'] (never the folder you open to the agent)",
    );
  for (const u of Array.isArray(m.uses) ? m.uses : [])
    need(typeof u === 'string' && NAME.test(u), "uses is a list of plugin names, e.g. ['ssh']");
  if (m.mount != null)
    need(
      typeof m.mount === 'string' && /^[a-z][a-z0-9-]*( [a-z][a-z0-9-]*)?$/.test(m.mount),
      'mount is one or two lowercase words, e.g. "tg account"',
    );
  // Its commands sit under its own name, or the part of its name before a dash (tg-bot:
  // "tg bot"). Never under another plugin's word: whose a command is, is told by that word.
  if (typeof m.mount === 'string' && typeof m.name === 'string')
    need(
      [m.name, m.name.split('-')[0]].includes(m.mount.trim().split(/\s+/)[0]),
      `mount ("${m.mount}") must begin with the plugin's own name ("${m.name}"${m.name.includes('-') ? `, or "${m.name.split('-')[0]}"` : ''}): a plugin's commands sit under its own word`,
    );
  if (m.default != null) need(typeof m.default === 'boolean', 'default must be true or false');
  for (const sv of m.services ?? []) {
    need(typeof sv.id === 'string' && NAME.test(sv.id), 'services[].id is required (lowercase)');
    need(sv.id !== 'agent', 'services[].id: "agent" is blackcat\'s own service; choose another id');
    need(typeof sv.summary === 'string' && sv.summary, `services.${sv.id}.summary is required`);
    need(typeof sv.command === 'string' && cmds?.[sv.command], `services.${sv.id}.command must name one of the plugin's commands`);
    for (const k of ['ready', 'health']) need(sv[k] == null || typeof sv[k] === 'function', `services.${sv.id}.${k} must be a function`);
  }
  // What it adds to the chat (`telegram` is the older name for the same key).
  for (const key of ['chat', 'telegram']) {
    const h = m[key];
    if (h == null) continue;
    for (const k of ['install', 'tick', 'quick', 'voice', 'stop'])
      need(h[k] == null || typeof h[k] === 'function', `${key}.${k} must be a function`);
    for (const c of typeof h.commands === 'function' ? [] : (h.commands ?? []))
      need(
        /^[a-z][a-z0-9_]{0,31}$/.test(c.command ?? '') && typeof c.description === 'string',
        `${key}.commands entries are { command, description }`,
      );
  }
  // What runs the model.
  if (m.engine != null) {
    for (const k of ['choices', 'ready', 'converse', 'ask']) need(typeof m.engine[k] === 'function', `engine.${k} must be a function`);
  }
  // Requests for the engine check (bc engine check): what the owner might say, and the command it should lead to.
  if (m.checks != null && typeof m.checks !== 'function') {
    need(Array.isArray(m.checks), 'checks must be a list, or a function of ctx returning one');
    for (const c of Array.isArray(m.checks) ? m.checks : [])
      need(
        typeof c?.say === 'string' && (c.expect instanceof RegExp || c.never instanceof RegExp),
        'checks[]: each needs `say`, and `expect` or `never` (a pattern)',
      );
  }
  // A way to talk to the owner.
  if (m.channel != null) {
    for (const k of ['paired', 'open', 'start']) need(typeof m.channel[k] === 'function', `channel.${k} must be a function`);
  }
  for (const j of m.jobs ?? []) {
    need(typeof j.id === 'string' && NAME.test(j.id), 'jobs[].id is required (lowercase)');
    need(typeof j.run === 'function', `jobs.${j.id}.run must be a function`);
    need(
      [j.cron, j.every, j.at].filter((x) => x != null).length === 1,
      `jobs.${j.id} needs a schedule: cron ("*/15 * * * *", a list, or a function of ctx returning one)`,
    );
    const wrong = jobShapeProblem(j);
    if (wrong) out.push(`jobs.${j.id}: ${wrong}`);
  }
  if (m.status != null) need(typeof m.status === 'function', 'status must be a function');
  if (m.settings != null) need(typeof m.settings === 'function', 'settings must be a function');
  for (const [n, c] of Object.entries(m.commands ?? {}))
    if (c.working != null) need(typeof c.working === 'string', `commands.${n}.working must be a string`);
  if (m.agenda != null) need(typeof m.agenda === 'function', 'agenda must be a function');
  if (m.names != null) need(typeof m.names === 'function', 'names must be a function of ctx and an address');
  if (m.briefing != null) need(typeof m.briefing === 'function', 'briefing must be a function of ctx that returns { problems, fine }');
  // A place files can be kept (src/storage.js).
  if (m.storage != null)
    for (const k of ['places', 'list', 'mkdir', 'put', 'get', 'remove'])
      need(typeof m.storage[k] === 'function', `storage.${k} must be a function`);
  if (m.source != null)
    need(
      typeof m.source === 'object' && /^[a-z][a-z0-9]{1,15}$/.test(m.source.id ?? '') && typeof m.source.label === 'string',
      'source needs an id (a short lowercase word) and a label',
    );
  return out;
}

// Every plugin folder that exists, without running any plugin code.
// Every plugin folder there is, without running any plugin code: what comes with blackcat
// first, then the owner's own, then the parts of blackcat itself.
//
// A name belongs to whoever had it first, and blackcat's own always had it first. A folder
// in user-plugins/ with the name of a bundled plugin, or of a part of blackcat, is not a
// plugin: it is never loaded, and it is said (see refused()). A plugin's settings, secrets
// and private folder go by its name, so one that took a name would be handed all of them.
export function available() {
  const own = new Map();
  for (const n of folders(BUNDLED_DIR)) own.set(n, { name: n, dir: path.join(BUNDLED_DIR, n), bundled: true });
  for (const m of FRAMEWORK) own.set(m.name, m);
  const yours = [];
  shadowing = [];
  for (const n of folders(USER_DIR)) {
    const taken = own.get(n);
    if (taken)
      shadowing.push({
        name: n,
        dir: path.join(USER_DIR, n),
        why: `blackcat has ${taken.framework ? 'a part' : 'a plugin'} of its own called "${n}". A plugin of yours cannot take its name: rename the folder ${path.join(USER_DIR, n)} (and the name in its plugin.js)`,
      });
    else yours.push({ name: n, dir: path.join(USER_DIR, n), bundled: false });
  }
  // (The parts of blackcat come last, so that when one asks what the plugins offer, the
  // plugins have been loaded. Plain comparison, not localeCompare: the first use of that
  // loads the language tables, 30 ms on a small machine, on every command.)
  const by = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const mine = [...own.values()];
  return [...mine.filter((e) => !e.framework).sort(by), ...yours.sort(by), ...mine.filter((e) => e.framework).sort(by)];
}
const folders = (dir) => {
  try {
    return fs.readdirSync(dir).filter((n) => fs.existsSync(path.join(dir, n, 'plugin.js')));
  } catch {
    return [];
  }
};
let shadowing = [];
let clashing = [];
// What was not loaded because it claimed what is another's: [{ name, why }]. Said at
// start-up, in `bc plugin list` and by `bc selftest`.
export const refused = () => [...shadowing, ...clashing];

// What a plugin claims that only one may have, with who has it. Asked of everything
// blackcat knows of, its own first (switched on or not: what is switched off still has
// its name), so that a clash always costs the newcomer.
function claims(entries, chatWords) {
  const held = {
    mount: [],
    title: new Map(),
    service: new Map([['agent', 'blackcat']]),
    chat: new Map(chatWords.map((w) => [w, 'blackcat'])),
  };
  const out = [];
  const order = [
    ...entries.filter((e) => e.framework),
    ...entries.filter((e) => e.bundled && !e.framework),
    ...entries.filter((e) => !e.bundled),
  ];
  for (const e of order) {
    const m = e.manifest;
    const who = (n) => (n === 'blackcat' ? 'blackcat itself' : `the ${n} plugin`);
    const mount = mountOf(m);
    const why = [];
    const over = held.mount.find((h) => h.words.every((w, i) => mount[i] === w) || mount.every((w, i) => h.words[i] === w));
    if (over) why.push(`its commands would sit at "bc ${mount.join(' ')}", where ${who(over.name)} has "bc ${over.words.join(' ')}"`);
    const t = String(m.title).trim().toLowerCase();
    if (held.title.has(t)) why.push(`it calls itself "${m.title}", which is what ${who(held.title.get(t))} is called`);
    for (const sv of m.services ?? [])
      if (held.service.has(sv.id)) why.push(`its service "${sv.id}" has the name of one ${who(held.service.get(sv.id))} has`);
    const words = Array.isArray(m.chat?.commands) ? m.chat.commands.map((c) => c.command) : [];
    for (const w of words)
      if (held.chat.has(w) && held.chat.get(w) !== e.name) why.push(`its chat command /${w} is ${who(held.chat.get(w))}'s`);
    if (held.chat.has(mount[0]) && held.chat.get(mount[0]) !== e.name && !held.mount.some((h) => h.words[0] === mount[0]))
      why.push(`/${mount[0]} in the chat is ${who(held.chat.get(mount[0]))}'s`);
    if (why.length) {
      out.push({ name: e.name, dir: e.dir, why: why.join('; ') });
      continue;
    }
    held.mount.push({ name: e.name, words: mount });
    held.title.set(t, e.name);
    for (const sv of m.services ?? []) held.service.set(sv.id, e.name);
    for (const w of [...words, mount[0]]) if (!held.chat.has(w)) held.chat.set(w, e.name);
  }
  return out;
}

// Parts of the framework that are described with a manifest, like a plugin, so the same
// machinery gives them commands, a place in the agent's instructions and scheduled jobs.
// They are not plugins: nothing replaces or removes them. Each says with `when()` whether
// it applies to this installation. One marked `optional` can be switched off by the owner
// (bc plugin disable watch): blackcat is of use without it, as a bot that runs your
// shortcuts and looks after your machines, say.
//   watch    what blackcat is for: it goes through what the sources bring into the archive,
//            keeps what the owner cares about on lists, and reports (the briefing, nudges)
//   remind   the reminders those lists and the owner set, and when they may arrive
//   check    looks at a system on a schedule, says when it stops working, and may try a fix
const FRAMEWORK = [
  { name: 'msg', dir: path.join(CODE_DIR, 'src/archive/commands'), file: 'manifest.js', bundled: true, framework: true },
  { name: 'activity', dir: path.join(CODE_DIR, 'src/activity'), file: 'manifest.js', bundled: true, framework: true },
  { name: 'backup', dir: path.join(CODE_DIR, 'src/backup'), file: 'manifest.js', bundled: true, framework: true, optional: true },
  { name: 'check', dir: path.join(CODE_DIR, 'src/checks'), file: 'manifest.js', bundled: true, framework: true, optional: true },
  { name: 'conversations', dir: path.join(CODE_DIR, 'src/conversations'), file: 'manifest.js', bundled: true, framework: true },
  { name: 'memory', dir: path.join(CODE_DIR, 'src/memory'), file: 'manifest.js', bundled: true, framework: true },
  { name: 'engine', dir: path.join(CODE_DIR, 'src/engines'), file: 'manifest.js', bundled: true, framework: true },
  { name: 'remind', dir: path.join(CODE_DIR, 'src/reminders'), file: 'manifest.js', bundled: true, framework: true, optional: true },
  { name: 'watch', dir: path.join(CODE_DIR, 'src/watch'), file: 'manifest.js', bundled: true, framework: true, optional: true },
];

// A plugin is on if you enabled it, or if it is one of blackcat's own features
// (manifest `default: true`) and you haven't disabled it.
export function isEnabled(name, manifest) {
  // A part of the framework is there when it applies, whatever the lists say: unless it is
  // one the owner may switch off, and has.
  const own = FRAMEWORK.find((m) => m.name === name);
  if (own) {
    if (own.optional && (load().plugins?.disabled ?? []).includes(name)) return false;
    try {
      return manifest?.when ? !!manifest.when() : true;
    } catch {
      return false;
    }
  }
  const p = load().plugins ?? {};
  if ((p.disabled ?? []).includes(name)) return false;
  return (p.enabled ?? []).includes(name) || !!manifest?.default;
}

export function setEnabled(name, on) {
  update((cfg) => {
    const enabled = new Set(cfg.plugins?.enabled ?? []);
    const disabled = new Set(cfg.plugins?.disabled ?? []);
    if (on) (enabled.add(name), disabled.delete(name));
    else (enabled.delete(name), disabled.add(name));
    cfg.plugins = { ...cfg.plugins, enabled: [...enabled].sort(), disabled: [...disabled].sort() };
  });
}

// Import one plugin and check it. Returns { name, dir, bundled, manifest } or { …, error }.
export async function loadOne(entry) {
  try {
    const manifest = (await import(pathToFileURL(path.join(entry.dir, entry.file ?? 'plugin.js')).href)).default;
    const bad = problems(manifest, entry.name);
    if (bad.length) return { ...entry, error: bad.join('; ') };
    // A plugin that collects messages from somewhere says so, and the archive learns the
    // source from it (registered whether or not the plugin is switched on: what it stored
    // earlier is still in the archive and still has to be told apart).
    if (manifest.source) {
      const plugin = { ...entry, manifest };
      const s = manifest.source;
      // (The bundled sources for WhatsApp and Telegram describe the two sources the archive knows by id format.)
      // (How it is connected, for "no messages yet": its pair command, or the one that adds an account.)
      const link = ['pair', 'add', 'setup'].find((n) => manifest.commands?.[n]);
      registerSource(
        {
          ...s,
          plugin: entry.name,
          link: link ? `bc ${mountOf(manifest).join(' ')} ${link}` : null,
          connected: s.connected && (() => isEnabled(entry.name, manifest) && s.connected(makeCtx(plugin, { caller: 'job' }))),
          fetchMedia: s.fetchMedia && ((row, dest, id) => s.fetchMedia(makeCtx(plugin, { caller: 'job' }), { row, dest, id })),
        },
        { own: !!entry.bundled },
      );
    }
    return { ...entry, manifest: withStandardCommands(manifest) };
  } catch (e) {
    return { ...entry, error: `could not be loaded: ${e.message}` };
  }
}

// Every plugin answers the same two questions the same way, whether or not its author
// wrote the commands:
//   status    how it is doing right now: working or not, what it last did, what it runs
//   settings  how it is set up: the choices made for it (secrets are named, never shown)
// A plugin's own `status` or `settings` command takes precedence. A manifest may give
// `settings: (ctx) => ({ … })` when its settings are not simply what it stored with ctx.config.
function withStandardCommands(manifest) {
  const show = (v) =>
    v == null
      ? 'not set'
      : typeof v === 'object'
        ? JSON.stringify(v).slice(0, 110) + (JSON.stringify(v).length > 110 ? '…' : '')
        : String(v);
  const at = mountOf(manifest).join(' ');
  const extra = {};
  if (!manifest.commands.settings) {
    extra.settings = {
      summary: 'how it is set up (secrets are named, never shown)',
      access: 'allow',
      untrusted: false,
      standard: true,
      run: async (ctx) => {
        const cfg = manifest.settings ? await manifest.settings(ctx) : ctx.config.get();
        const names = ctx.secrets.names();
        const lines = Object.keys(cfg).length ? Object.entries(cfg).map(([k, v]) => `  ${k}: ${show(v)}`) : ['  nothing to set'];
        return {
          text: [
            `${manifest.title} settings`,
            ...lines,
            ...(names.length ? [`  stored secretly (not shown): ${names.join(', ')}`] : []),
            ...(manifest.commands.setup ? [`change them: bc ${at} setup`] : []),
          ].join('\n'),
          data: { settings: cfg, secrets: names },
        };
      },
    };
  }
  if (!manifest.commands.status) {
    extra.status = {
      summary: 'how it is doing right now',
      access: 'allow',
      untrusted: false,
      standard: true,
      run: async (ctx) => {
        let line = 'enabled';
        try {
          if (manifest.status) line = String(await manifest.status(ctx));
        } catch (e) {
          line = `could not tell (${e.message})`;
        }
        const jobs = (manifest.jobs ?? []).map(
          (j) => `  ${j.id}: ${describeJob(j, ctx)}${j.when && !j.when(ctx) ? ' (not running: not set up)' : ''}`,
        );
        return {
          text: [
            `${manifest.title}: ${line}`,
            ...(jobs.length ? ['runs by itself', ...jobs] : []),
            `how it is set up: bc ${at} settings`,
          ].join('\n'),
          data: { status: line },
        };
      },
    };
  }
  return Object.keys(extra).length ? { ...manifest, commands: { ...manifest.commands, ...extra } } : manifest;
}

let cache = null;
let cacheKey = null;
const told = new Set(); // (what was refused is said once in a process)

// The enabled plugins, loaded once per process and again if the enabled list changes.
// Bundled plugins are trusted code, so their manifests are always read (that's how the
// default-on ones are found). Your own are only imported once you enable them.
// A broken plugin is reported and skipped; it never takes blackcat down with it.
// A plugin's own settings, for its code that has no `ctx` at hand. (`ctx.config` is the same thing.)
export const pluginSettings = (name) => load().plugins?.settings?.[name] ?? {};
export function setPluginSettings(name, patch) {
  let mine;
  update((cfg) => {
    mine = { ...cfg.plugins?.settings?.[name], ...patch };
    cfg.plugins = { ...cfg.plugins, settings: { ...cfg.plugins?.settings, [name]: mine } };
  });
  return mine;
}

// "Every 15 minutes (next: Mon 5 Oct 09:15)", or why it can't be worked out.
export function describeJob(job, ctx) {
  try {
    return scheduleSummary(jobSchedule(job, ctx));
  } catch (e) {
    return `no valid schedule (${e.message})`;
  }
}

let apiNamespace = null; // src/api.js, loaded with the plugins (it imports this file, so not at the top)

export async function loadPlugins() {
  apiNamespace ??= await import('../api.js');
  const p = load().plugins ?? {};
  const key = `${(p.enabled ?? []).join(',')}|${(p.disabled ?? []).join(',')}`;
  if (cache && cacheKey === key) return cache;
  const out = [];
  const read = [];
  const seen = new Set();
  for (const entry of available()) {
    seen.add(entry.name);
    if (!entry.bundled && !isEnabled(entry.name)) continue;
    const loadedP = await loadOne(entry);
    if (!loadedP.error) read.push(loadedP);
    if (loadedP.error) {
      if (isEnabled(entry.name)) console.error(`plugin "${entry.name}" skipped: ${loadedP.error}`);
      continue;
    }
    if (isEnabled(entry.name, loadedP.manifest)) out.push(loadedP);
  }
  for (const n of p.enabled ?? []) if (!seen.has(n)) console.error(`plugin "${n}" skipped: its folder is missing`);
  // What claims a word, a title or a service that is another's is not loaded. (Looked at
  // across everything known, so a plugin that is switched off keeps what is its own.)
  const { CHAT_COMMANDS } = await import('../channels/commands.js');
  clashing = claims(
    read,
    CHAT_COMMANDS.map((c) => c.command),
  );
  for (const r of clashing) {
    for (const list of [out, read]) {
      const i = list.findIndex((x) => x.name === r.name);
      if (i >= 0) list.splice(i, 1);
    }
  }
  for (const r of refused()) if (!told.has(r.name)) (told.add(r.name), console.error(`plugin "${r.name}" was not loaded: ${r.why}`));
  // Forms that depend on what the other plugins offer (a question per source) are built now.
  // (The plugins count as loaded from here, so such a form can ask what they offer.)
  cache = out;
  known = read;
  cacheKey = key;
  for (const said of (await import('./call.js')).usesProblems(out)) console.error(said);
  for (const pl of out) {
    for (const [name, c] of Object.entries(pl.manifest.commands)) {
      if (typeof c.form !== 'function') continue;
      // (A form that cannot be built costs that one command, and says so when it is run:
      // never the rest of the plugin, and never blackcat.)
      let why = null;
      try {
        c.form = c.form();
        const bad = validateSteps(c.form);
        if (bad.length) why = bad.join('; ');
      } catch (e) {
        why = e.message;
      }
      if (why == null) continue;
      console.error(`plugin "${pl.name}": ${name}.form could not be built: ${why}`);
      delete c.form;
      c.run = () => {
        throw new PluginError(`${pl.manifest.title}: "${name}" cannot be used: its form could not be built (${why}).`);
      };
    }
  }
  return out;
}

// The plugins loaded so far (for code that can't wait: call loadPlugins() first).
export const loaded = () => cache ?? [];
// Every plugin whose manifest was read, switched on or not (everything bundled, and the
// owner's own that are on). For what must hold whether or not a plugin is in use: what it
// left in the data folder is still there, and still private.
let known = [];
export const everyKnown = () => known;
export const findLoaded = (name) => loaded().find((p) => p.name === name);

// Which enabled plugin, if any, owns a command line? `words` are the words after the
// program name. → { plugin, command, rest } or null.
export function findCommand(words) {
  for (const p of loaded()) {
    const mount = mountOf(p.manifest);
    if (mount.every((w, i) => words[i] === w)) return { plugin: p, command: words[mount.length], rest: words.slice(mount.length + 1) };
  }
  return null;
}

// ---------- what a plugin's code is given ----------

function secretsFor(name) {
  const dir = path.join(PLUGIN_DATA, name);
  const file = path.join(dir, 'secrets.json');
  // None yet is an empty set. A file that is there and cannot be read is not: to take it
  // for empty would have the next write replace every secret in it with one.
  const read = () => {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return {};
      throw new Error(`the secrets of ${name} cannot be read (${e.message})`);
    }
    try {
      const o = JSON.parse(text);
      if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('it is not a set of names and values');
      return o;
    } catch (e) {
      throw new Error(
        `the secrets of ${name} cannot be read: ${file} is damaged (${e.message}). Mend it or move it away, then set them again.`,
      );
    }
  };
  // Written beside it and moved into place, so that it is whole or as it was. One change
  // at a time: read, change and write under a lock, so two at once keep both.
  const change = (fn) => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const lock = `${file}.lock`;
    const until = Date.now() + 5000;
    for (;;) {
      try {
        fs.closeSync(fs.openSync(lock, 'wx', 0o600));
        break;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        // (A lock left by a process that died is not waited for long.)
        let age = 0;
        try {
          age = Date.now() - fs.statSync(lock).mtimeMs;
        } catch {}
        if (age > 10_000 || Date.now() > until) fs.rmSync(lock, { force: true });
        else pause(20);
      }
    }
    try {
      const o = read();
      fn(o);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(o, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } finally {
      fs.rmSync(lock, { force: true });
    }
  };
  return {
    get: (k) => read()[k],
    set: (k, v) =>
      change((o) => {
        o[k] = v;
      }),
    delete: (k) =>
      change((o) => {
        delete o[k];
      }),
    has: (k) => k in read(),
    names: () => Object.keys(read()),
  };
}

// `caller` is who started the command: 'owner' (terminal or /setup), 'agent', or 'job'.
export function makeCtx(plugin, { caller = 'owner', surface = 'terminal' } = {}) {
  const name = plugin.name;
  const dataDir = path.join(PLUGIN_DATA, name);
  return {
    plugin: name,
    caller,
    surface,
    // Everything in src/api.js. A bundled plugin imports that file; a plugin kept outside
    // the repository (user-plugins/, or installed with `bc plugin add`) can't rely on where
    // blackcat's code is, so it reaches the same functions here: `ctx.api.shell(…)`.
    get api() {
      return apiNamespace;
    },
    // Settings, kept in config.json under plugins.settings.<name>. Not for secrets.
    config: {
      get: () => load().plugins?.settings?.[name] ?? {},
      set(patch) {
        let mine;
        update((cfg) => {
          mine = { ...cfg.plugins?.settings?.[name], ...patch };
          cfg.plugins = { ...cfg.plugins, settings: { ...cfg.plugins?.settings, [name]: mine } };
        });
        return mine;
      },
    },
    // Tokens, passwords, keys. Stored in data/plugins/<name>/, which the agent can never read.
    secrets: secretsFor(name),
    // What it keeps between runs and that changes with use (what it last fetched, where it
    // had got to): get(key), set(key, value), delete(key), keys(), update(key, fn). In agent.db.
    get store() {
      return storeFor(name);
    },
    // Run a command of a plugin this one says it uses (`uses: ['ssh']` in the manifest).
    // → { text, data }, as the command would print it with --json. See src/plugins/call.js.
    async command(target, commandName, input) {
      return (await import('./call.js')).callCommand(plugin, { caller, surface }, target, commandName, input);
    },
    get dataDir() {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      return dataDir;
    },
    log: (msg) => log(`[${name}] ${msg}`),
    // Run a program without a shell. Never throws: returns { code, stdout, stderr }.
    exec: (cmd, args = [], { timeoutMs = 60_000, input } = {}) =>
      new Promise((resolve) => {
        const child = execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
          resolve({
            code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
            stdout,
            stderr: stderr || (err && !stdout ? err.message : ''),
            timedOut: !!err?.killed,
          });
        });
        if (input != null) child.stdin.end(input);
      }),
    // Send the owner a message, through whichever channel is in use (for jobs and alerts). → true if it went.
    async notify(text) {
      const { notifyOwner } = await import('../channels/send.js');
      const t0 = Date.now();
      const went = await notifyOwner(text);
      (await import('../activity/log.js')).sentOwner(name, 'a notice', {
        ok: !!went,
        chars: String(text ?? '').length,
        ms: Date.now() - t0,
      });
      return went;
    },
    // Ask a model one question with no tools at all: the safe way to have a model read
    // untrusted text (messages, web pages, logs). Whatever that text says, nothing can be
    // run. `system` is your instruction, `input` the text to read. Returns its answer.
    async ask(system, input, { model } = {}) {
      const { askModel } = await import('../agent/oneshot.js');
      return askModel(system, input, model, { category: `plugin: ${plugin.name}` });
    },
    // Ask a reader of the plugin's own: a model with no tools, told what `readers/<job>.md` beside
    // plugin.js says (after the ground rules every reader is told), and held to the shape of
    // answer given as `schema`. → that object; or text, when no shape is asked for.
    async reader(job, { values, input, schema, also } = {}) {
      const { askReader } = await import('../readers.js');
      return askReader({ dir: plugin.dir, part: plugin.name, job, values, input, schema, also, category: `plugin: ${plugin.name}` });
    },
    fail(msg) {
      throw new PluginError(msg);
    },
  };
}
