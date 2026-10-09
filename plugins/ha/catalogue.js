import { HaError } from './api.js';

// The catalogue is what rarely changes about a Home Assistant: its rooms, the things in
// them, what each is called and what kind it is. It is fetched by `sync` and kept on the
// Pi, so finding "the living room light" needs no round trip. What changes all the time
// (is it on, how warm is it) is never kept: it is asked for when needed.

// What each kind of thing can be told to do: action → [service domain, service].
const ONOFF = { on: 'turn_on', off: 'turn_off', toggle: 'toggle' };
const svc = (domain, map) => Object.fromEntries(Object.entries(map).map(([a, s]) => [a, [domain, s]]));
export const ACTIONS = {
  light: svc('light', ONOFF),
  switch: svc('switch', ONOFF),
  fan: svc('fan', ONOFF),
  input_boolean: svc('input_boolean', ONOFF),
  siren: svc('siren', ONOFF),
  humidifier: svc('humidifier', ONOFF),
  automation: { ...svc('automation', ONOFF), run: ['automation', 'trigger'] },
  climate: svc('climate', { on: 'turn_on', off: 'turn_off' }),
  water_heater: svc('water_heater', { on: 'turn_on', off: 'turn_off' }),
  media_player: svc('media_player', {
    on: 'turn_on',
    off: 'turn_off',
    toggle: 'toggle',
    play: 'media_play',
    pause: 'media_pause',
    stop: 'media_stop',
  }),
  cover: svc('cover', { open: 'open_cover', close: 'close_cover', stop: 'stop_cover', toggle: 'toggle' }),
  valve: svc('valve', { open: 'open_valve', close: 'close_valve', stop: 'stop_valve' }),
  lock: svc('lock', { lock: 'lock', unlock: 'unlock' }),
  vacuum: svc('vacuum', { on: 'start', off: 'return_to_base' }),
  scene: { run: ['scene', 'turn_on'], on: ['scene', 'turn_on'] },
  script: { run: ['script', 'turn_on'], on: ['script', 'turn_on'] },
  button: { run: ['button', 'press'] },
  input_button: { run: ['input_button', 'press'] },
  alarm_control_panel: svc('alarm_control_panel', { on: 'alarm_arm_away', off: 'alarm_disarm' }),
};
// Things you can set a value on, as well.
export const SETTABLE = [
  'light',
  'climate',
  'cover',
  'fan',
  'media_player',
  'input_number',
  'number',
  'input_select',
  'select',
  'humidifier',
  'water_heater',
];
export const controllable = (e) => !!ACTIONS[e.domain] || SETTABLE.includes(e.domain);

// How freely the agent may act on a thing.
//   free     without asking
//   ask      the owner approves each time (and may answer "always")
//   guarded  the owner approves every single time
// A name as one short plain line. Names are set by whoever set a device up and end up in
// the agent's instructions, so line breaks, control characters and length are taken out of their hands.
export const plain = (v) =>
  String(v ?? '')
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);

export const LEVELS = ['free', 'ask', 'guarded'];
const FREE = ['light', 'switch', 'fan', 'scene', 'media_player', 'input_boolean', 'humidifier', 'input_number', 'input_select'];
const GUARDED = ['lock', 'alarm_control_panel', 'siren', 'valve'];
const GUARDED_COVERS = ['garage', 'door', 'gate'];
// The built-in rule for each kind that has one; every other kind is "ask".
export const KIND_DEFAULTS = {
  ...Object.fromEntries(FREE.map((k) => [k, 'free'])),
  ...Object.fromEntries(GUARDED.map((k) => [k, 'guarded'])),
};
export function levelFor(e, cfg = {}) {
  const own = cfg.levels?.[e.id];
  if (LEVELS.includes(own)) return own;
  // The owner's rule for the whole kind ("cover": "free"), then the built-in ones.
  const kind = cfg.kinds?.[e.domain];
  if (LEVELS.includes(kind)) return kind;
  if (GUARDED.includes(e.domain) || (e.domain === 'cover' && GUARDED_COVERS.includes(e.deviceClass))) return 'guarded';
  return cfg.free !== false && FREE.includes(e.domain) ? 'free' : 'ask';
}

// What Home Assistant has, as last read from it, kept in the plugin's store. (It was a
// file, catalogue.json; one from then is taken over the first time this is asked.)
export function readCatalogue(ctx) {
  const cat = ctx.store.get('catalogue');
  return cat && Array.isArray(cat.entities) ? cat : null;
}

// Rooms and which entities are in each, in one request, using Home Assistant's templates.
const AREAS =
  "{% set ns = namespace(out=[]) %}{% for a in areas() %}{% set ns.out = ns.out + [{'id': a, 'name': area_name(a), 'entities': area_entities(a)}] %}{% endfor %}{{ ns.out | tojson }}";

export async function sync(ctx, api) {
  const [config, states] = await Promise.all([api.config(), api.states()]);
  // Rooms, and what each thing is: from the registries when they can be read, otherwise
  // (an older Home Assistant, a blocked WebSocket) rooms only, from a template.
  let areas = [];
  const info = new Map(); // entity id → { area, category, hidden, device }
  try {
    const reg = await api.registries();
    areas = reg.areas.map((a) => ({ id: a.area_id, name: plain(a.name) }));
    const devices = new Map(reg.devices.map((d) => [d.id, d]));
    for (const r of reg.entities) {
      const d = devices.get(r.device_id);
      info.set(r.entity_id, {
        area: r.area_id ?? d?.area_id ?? null,
        category: r.entity_category ?? null,
        hidden: !!r.hidden_by,
        device: d ? (d.name_by_user ?? d.name ?? null) : null,
      });
    }
  } catch (e) {
    if (!(e instanceof HaError)) throw e;
    ctx.log(`registries not available (${e.message}); using rooms only`);
    try {
      const raw = await api.template(AREAS);
      const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
      areas = list.map((a) => ({ id: a.id, name: plain(a.name) }));
      for (const a of list) for (const id of a.entities ?? []) info.set(id, { area: a.id, category: null, hidden: false, device: null });
    } catch (e2) {
      if (!(e2 instanceof HaError || e2 instanceof SyntaxError)) throw e2; // no rooms then
    }
  }
  const entities = states
    .map((s) => {
      const r = info.get(s.entity_id) ?? {};
      return {
        id: s.entity_id,
        domain: s.entity_id.split('.')[0],
        name: plain(s.attributes?.friendly_name ?? s.entity_id),
        area: r.area ?? null,
        deviceClass: s.attributes?.device_class ?? null,
        unit: s.attributes?.unit_of_measurement ?? null,
        // config / diagnostic: a device's settings and internals, not something you use day to day
        category: r.category ?? null,
        hidden: !!r.hidden,
        device: r.device ?? null,
        // Was it reachable when synced? Things that are switched off or gone stay out of the agent's list.
        available: s.state !== 'unavailable',
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const cat = {
    synced: Math.floor(Date.now() / 1000),
    version: config.version ?? null,
    location: config.location_name ?? null,
    areas: areas.sort((a, b) => a.name.localeCompare(b.name)),
    entities,
  };
  ctx.store.set('catalogue', cat);
  return cat;
}

// The things you actually use: not a device's settings or diagnostics, and not hidden.
export const primary = (e) => !e.category && !e.hidden;
// What the menus and the agent's list show: usable things you can control.
export const main = (e) =>
  controllable(e) && primary(e) && !['automation', 'button', 'input_button', 'number', 'select'].includes(e.domain);

const norm = (s) => String(s).toLowerCase().replace(/[_.]/g, ' ').replace(/\s+/g, ' ').trim();
export const areaName = (cat, id) => cat.areas.find((a) => a.id === id)?.name ?? null;

// Which thing does a name mean? → { entity } or { error }. `domains` narrows it to things
// the action applies to, so "living room" + "off" finds the light and not the thermometer.
export function resolve(cat, words, { domains } = {}) {
  const q = norm([words].flat().join(' '));
  if (!q) return { error: 'Which one? Give its name, e.g. "living room light".' };
  let pool = cat.entities;
  if (domains) pool = pool.filter((e) => domains.includes(e.domain));
  const label = (e) => norm(`${areaName(cat, e.area) ?? ''} ${e.name}`);
  const exact = pool.filter(
    (e) => e.id === q.replace(/ /g, '_') || e.id === [words].flat().join(' ') || norm(e.name) === q || label(e) === q,
  );
  const terms = q.split(' ');
  const hits = exact.length ? exact : pool.filter((e) => terms.every((t) => `${label(e)} ${norm(e.id)}`.includes(t)));
  if (hits.length === 1) return { entity: hits[0] };
  if (!hits.length) return { error: `Nothing here is called "${[words].flat().join(' ')}"${domains ? ' that this can be done to' : ''}.` };
  // Several match. If only one of them is an everyday thing (not a setting or a
  // diagnostic) that is reachable, that is the one meant. A word that names what a sensor
  // measures ("temperature", "humidity") means the sensor that measures it, not the device's
  // other entries. Only for an action (`domains` given) does "the one that can be
  // controlled" settle it: asked what something reads, a device's "identify" button is
  // never the answer.
  const terms2 = new Set(terms);
  const measures = (e) => !!e.deviceClass && terms2.has(norm(e.deviceClass));
  const there = (e) => e.available !== false;
  const tries = [
    (e) => primary(e) && there(e) && measures(e),
    (e) => primary(e) && measures(e),
    (e) => primary(e) && there(e),
    primary,
    main,
    ...(domains ? [controllable] : []),
  ];
  let closest = hits;
  for (const narrow of tries) {
    const few = hits.filter(narrow);
    if (few.length === 1) return { entity: few[0] };
    if (few.length && few.length < closest.length) closest = few;
  }
  // Still several: the likeliest are named, so that one more word settles it.
  return {
    error: `"${[words].flat().join(' ')}" could be ${closest.length} things: ${closest
      .slice(0, 8)
      .map((e) => `${e.name}${e.area ? ` (${areaName(cat, e.area)})` : ''}${there(e) ? '' : ', not reachable'} [${e.id}]`)
      .join('; ')}${closest.length > 8 ? '; …' : ''}. Say which, or use the id in brackets.`,
  };
}

export const inArea = (cat, areaId) => cat.entities.filter((e) => e.area === areaId);
export function findArea(cat, words) {
  const q = norm([words].flat().join(' '));
  const hits = cat.areas.filter((a) => norm(a.name) === q);
  const loose = hits.length ? hits : cat.areas.filter((a) => norm(a.name).includes(q));
  return loose.length === 1 ? loose[0] : null;
}
