// Which engine runs the model, and with what.
//
// An engine is a plugin whose manifest has `engine` (see docs/plugins.md, "Engines"):
//
//   engine: {
//     label,
//     choices(ctx) → { models: [{ id, label, hint }], options: [{ id, label, values }], defaults: { chat: {…}, readers: {…} } },
//     ready(ctx)   → { ok, why?, detail? }           installed and signed in?
//     converse(ctx, spec, on) → conversation          the chat agent: kept running, fed messages
//     ask(ctx, { system, content, model, options }) → { text, isError, usage }   one question, NO tools
//     has(ctx, sessionId, workdir) → boolean          does it still hold a conversation of its own?
//     where(ctx) → text                               where the model is, for the owner to see
//     forget(ctx, workdir)                            discard what it kept about conversations started in a folder
//     ownResult(ctx, workdir, file) → boolean         is this a file it made to hold the result of a command that was allowed?
//   }
//
// What an engine is given to work with is decided here and nowhere else: the six things
// the agent can do (TOOLS), every one of which is put to blackcat's policy before it
// happens. An engine may offer less; it may never offer more.
//
// The chat agent and the background readers are set separately ("roles"): which engine,
// which model, which options. It is kept under `engine` in the settings:
//   engine: { chat: { name, model, options }, readers: { name, model, options } }
// A model is whatever the owner says it is: a name from the engine's list, or any other.
import { load, update } from '../config.js';
import { findLoaded, loaded, makeCtx } from '../plugins/registry.js';

// What the agent can do at all, by the names and shapes blackcat's policy judges them by:
//   Bash { command } · Read { file_path } · Write { file_path, content } · Edit { file_path, … }
//   Glob { pattern, path? } · Grep { pattern, path? }
export const TOOLS = ['Bash', 'Read', 'Glob', 'Grep', 'Write', 'Edit'];
export const ROLES = ['chat', 'readers'];
export const DEFAULT_ENGINE = 'claude-code';

export const enginePlugins = () => loaded().filter((p) => p.manifest.engine);

// What the owner chose for a role, as it is stored (anything not chosen is absent).
export const stored = (role) => load().engine?.[role] ?? {};
export const engineName = (role) => stored(role).name ?? DEFAULT_ENGINE;

// What an engine says can be chosen, tidied: { label, models, options, defaults }. It is
// answered at once (an engine that has to ask somewhere keeps what it last learned).
export function choicesOf(name) {
  const plugin = findLoaded(name);
  const def = plugin?.manifest.engine;
  let c = {};
  try {
    c = def?.choices?.(makeCtx(plugin, { caller: 'owner', surface: 'job' })) ?? {};
  } catch {}
  if (typeof c.then === 'function') c = {};
  // An option's values are names, or { value, label, hint } to say what each means. `roles`
  // says which of chat and readers it applies to (both, unless it says).
  const options = (c.options ?? [])
    .filter((o) => o?.id && Array.isArray(o.values))
    .map((o) => ({
      ...o,
      choices: o.values.map((v) =>
        typeof v === 'object' ? { hint: undefined, label: String(v.value), ...v } : { value: v, label: String(v) },
      ),
      values: o.values.map((v) => (typeof v === 'object' ? v.value : v)),
    }));
  return { label: def?.label ?? plugin?.manifest.title ?? name, models: c.models ?? [], options, defaults: c.defaults ?? {} };
}

// The options of an engine that apply to a role.
export const optionsFor = (name, role) => choicesOf(name).options.filter((o) => !o.roles || o.roles.includes(role));

// What a role's options come to: the engine's defaults for it, with what was chosen on top.
export function effectiveOptions(role, choice = stored(role)) {
  const name = choice.name ?? DEFAULT_ENGINE;
  return { ...choicesOf(name).defaults[role]?.options, ...choice.options };
}

// The engine for a role, ready to use: { name, plugin, def, ctx, model, options, label }.
// What was not chosen comes from the engine's own defaults for that role.
export async function engineFor(role) {
  const name = engineName(role);
  const plugin = findLoaded(name);
  if (!plugin?.manifest.engine) throw new Error(`The engine "${name}" is not available. See: bc engine status`);
  const def = plugin.manifest.engine;
  const c = choicesOf(name);
  const defaults = c.defaults[role] ?? {};
  const s = stored(role);
  return {
    name,
    plugin,
    def,
    ctx: makeCtx(plugin, { caller: 'owner', surface: 'job' }),
    label: c.label,
    model: s.model ?? defaults.model ?? null,
    options: { ...defaults.options, ...s.options },
  };
}

// blackcat runs without a model: commands, shortcuts, reminders and checks need none. What
// needs one (a message in words, a watch reading messages) says so instead of failing.
export class NoModel extends Error {}
export const noModelText = (st) =>
  `No model is set up (${st.why}). Commands still work without one: /help lists them. To set one up: bc engine status`;

// Is there a model for a role right now? → { ok, why?, label }. Asking the engine takes
// most of a second, so the answer is kept: a yes for as long as the process lives (a turn
// that fails asks again), a no for a minute.
const states = new Map(); // by engine: the chat and the readers are usually the same one
const NO_FOR_MS = 60_000;
const keyOf = (role) => {
  try {
    return engineName(role);
  } catch {
    return role;
  }
};
export function modelState(role, { fresh = false } = {}) {
  const had = states.get(keyOf(role));
  if (!fresh && had && (!had.st || had.st.ok || Date.now() - had.at < NO_FOR_MS)) return had.asked;
  const entry = { at: Date.now(), st: null };
  entry.asked = (async () => {
    try {
      const e = await engineFor(role);
      const r = await e.def.ready(e.ctx);
      entry.st = r.ok
        ? { ok: true, label: e.label, detail: r.detail ?? null }
        : { ok: false, label: e.label, why: `${e.label} is not ready: ${r.why}` };
    } catch (err) {
      // (An engine that is chosen and is not there is a setting to put right, not "no model".)
      entry.st = { ok: false, broken: true, label: 'engine', why: err.message };
    }
    entry.at = Date.now();
    return entry.st;
  })();
  states.set(keyOf(role), entry);
  return entry.asked;
}
// Something that needed the model has just failed to start. Is there one? → null when there
// is (the failure was something else), or what is missing. Only this marks a model as
// missing: a sign-in check that fails by itself never stops a model that works from being used.
const missing = new Map();
export async function whyNoModel(role) {
  const st = await modelState(role, { fresh: true });
  if (st.ok || st.broken) missing.delete(keyOf(role));
  else missing.set(keyOf(role), { ...st, at: Date.now() });
  return st.ok || st.broken ? null : st;
}
// What failed for want of a model within the last minute: said again without trying.
export const knownMissing = (role) => {
  const had = missing.get(keyOf(role));
  return had && Date.now() - had.at < NO_FOR_MS ? had : null;
};

// The model a role uses, or null when it is left to the engine.
export const modelNow = (role) => stored(role).model ?? choicesOf(engineName(role)).defaults[role]?.model ?? null;

// A fingerprint of what a role is set to: a conversation kept ready is let go when it changes.
// (`choice`: one being considered, in place of what is stored.)
export function engineStamp(role, choice = stored(role)) {
  const name = choice.name ?? DEFAULT_ENGINE;
  // (What the options come to, not only what was chosen: a default that is changed in a new
  // version is a change too, and what was checked before no longer stands.)
  const options = effectiveOptions(role, choice);
  return JSON.stringify([
    name,
    choice.model ?? null,
    Object.keys(options).length ? options : null,
    load().plugins?.settings?.[name] ?? null,
  ]);
}

// Store a choice for a role. `patch`: { name?, model?, options? }; a value of null goes back to the engine's default.
export function choose(role, patch) {
  if (!ROLES.includes(role)) throw new Error(`"${role}" is not something an engine is chosen for. Use: ${ROLES.join(', ')}`);
  update((cfg) => {
    const cur = { ...(cfg.engine?.[role] ?? {}) };
    // A different engine starts from its own defaults: the old one's model names mean nothing to it.
    if (patch.name && patch.name !== (cur.name ?? DEFAULT_ENGINE)) {
      delete cur.model;
      delete cur.options;
    }
    for (const k of ['name', 'model']) {
      if (patch[k] === null) delete cur[k];
      else if (patch[k] !== undefined) cur[k] = patch[k];
    }
    if (patch.options) {
      const o = { ...cur.options };
      for (const [k, v] of Object.entries(patch.options)) {
        if (v === null) delete o[k];
        else o[k] = v;
      }
      if (Object.keys(o).length) cur.options = o;
      else delete cur.options;
    }
    cfg.engine = { ...cfg.engine, [role]: cur };
    if (!Object.keys(cur).length) delete cfg.engine[role];
    if (!Object.keys(cfg.engine).length) delete cfg.engine;
  });
  return stored(role);
}
