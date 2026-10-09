// Home Assistant: see and control the things in your home. Looking is free for the
// agent. What it may switch without asking depends on the kind of thing: lights and the
// like are free, climate and blinds ask, locks and alarms ask every single time.
import { parseDuration, sleep } from '../../src/api.js';
import { HaError, client } from './api.js';
import { libraryVia, matching, shown } from './media.js';
import {
  ACTIONS,
  LEVELS,
  SETTABLE,
  areaName,
  controllable,
  findArea,
  inArea,
  levelFor,
  main,
  primary,
  readCatalogue,
  resolve,
  sync,
  KIND_DEFAULTS,
} from './catalogue.js';

const settings = (ctx) => ctx.config.get();
const api = (ctx) => client({ url: settings(ctx).url, token: ctx.secrets.get('token') });
const configured = (ctx) => !!settings(ctx).url && ctx.secrets.has('token');
const guard = (fn) => async (ctx, input) => {
  try {
    return await fn(ctx, input ?? {});
  } catch (e) {
    if (e instanceof HaError) ctx.fail(e.message);
    throw e;
  }
};
function catalogue(ctx) {
  const cat = readCatalogue(ctx);
  if (!cat)
    ctx.fail(
      configured(ctx)
        ? 'Home Assistant has not been synced yet. Run: bc ha sync'
        : 'Home Assistant is not set up yet. Run `bc ha setup` on this machine, or /setup in the bot.',
    );
  return cat;
}

// "on", "24.5 °C", "on · 60%": a state as a person would say it.
export function describe(s, e) {
  const a = s.attributes ?? {};
  // A yes/no sensor says "on" or "off"; what that means depends on what it senses.
  const WORDS = {
    door: ['open', 'closed'],
    window: ['open', 'closed'],
    opening: ['open', 'closed'],
    garage_door: ['open', 'closed'],
    lock: ['unlocked', 'locked'],
    motion: ['motion', 'no motion'],
    occupancy: ['occupied', 'empty'],
    presence: ['home', 'away'],
    smoke: ['SMOKE', 'clear'],
    moisture: ['WET', 'dry'],
    gas: ['GAS', 'clear'],
    battery: ['low', 'ok'],
    connectivity: ['connected', 'disconnected'],
  };
  const yn =
    e.domain === 'binary_sensor' && WORDS[e.deviceClass] && ['on', 'off'].includes(s.state)
      ? WORDS[e.deviceClass][s.state === 'on' ? 0 : 1]
      : null;
  const bits = [yn ?? `${s.state}${a.unit_of_measurement ? ` ${a.unit_of_measurement}` : ''}`];
  if (e.domain === 'light' && a.brightness != null && s.state === 'on') bits.push(`${Math.round((a.brightness / 255) * 100)}%`);
  if (e.domain === 'climate')
    bits.push(
      [a.current_temperature != null ? `now ${a.current_temperature}°` : null, a.temperature != null ? `set to ${a.temperature}°` : null]
        .filter(Boolean)
        .join(', '),
    );
  if (e.domain === 'cover' && a.current_position != null) bits.push(`${a.current_position}% open`);
  if (e.domain === 'media_player' && a.media_title) bits.push(String(a.media_title).slice(0, 60));
  if (e.domain === 'media_player' && a.volume_level != null) bits.push(`volume ${Math.round(a.volume_level * 100)}%`);
  if (a.battery_level != null) bits.push(`battery ${a.battery_level}%`);
  return bits.filter(Boolean).join(' · ');
}
const line = (cat, e, s) => `${e.name}${e.area ? ` (${areaName(cat, e.area)})` : ''}: ${s ? describe(s, e) : 'unknown'}`;

// Find the thing a command is about. The owner's commands look again in Home Assistant
// when a name is new; the agent's don't, so that what it does is what was judged.
async function target(ctx, words, opts) {
  let cat = catalogue(ctx);
  let r = resolve(cat, words, opts);
  if (r.error && ctx.caller !== 'agent' && /^Nothing here/.test(r.error)) {
    cat = await sync(ctx, api(ctx));
    r = resolve(cat, words, opts);
  }
  if (r.error) ctx.fail(`${r.error}${ctx.caller === 'agent' ? ' If it was added recently, run `blackcat ha sync` first.' : ''}`);
  return { cat, e: r.entity };
}

// The words of a name, as typed before any option.
const nameOf = (tokens) => {
  const i = tokens.findIndex((t) => t.startsWith('--'));
  return i < 0 ? tokens : tokens.slice(0, i);
};
// What the agent may do with an action on the thing these words name.
const actionAccess = (action, domains) => (ctx, tokens) => {
  const cat = readCatalogue(ctx);
  const r = cat
    ? resolve(cat, nameOf(tokens), { domains: domains ?? Object.keys(ACTIONS).filter((d) => ACTIONS[d][action]) })
    : { error: true };
  // Not sure what is meant: the owner decides.
  if (!r.entity)
    return {
      level: 'ask',
      once: true,
      describe: `${action} "${nameOf(tokens).join(' ')}" in your home (I could not tell exactly which thing that is)`,
    };
  const level = levelFor(r.entity, settings(ctx));
  const what = `${action === 'set' ? 'change' : action} ${r.entity.name}${r.entity.area ? ` in ${areaName(cat, r.entity.area)}` : ''}`;
  if (level === 'free') return 'allow';
  return { level: 'ask', once: level === 'guarded', describe: what };
};

// The speakers and TVs a media listing can be asked of: the ones that were reachable first.
const players = (cat) =>
  cat.entities
    .filter((e) => e.domain === 'media_player')
    .sort((a, b) => (a.available === false) - (b.available === false))
    .map((e) => e.id);
// How long to give a speaker: before saying what it is doing now, and before setting a volume it would not take while off.
export const wait = { settle: 700, volume: 1500 };

async function act(ctx, action, words) {
  const { cat, e } = await target(ctx, words, { domains: Object.keys(ACTIONS).filter((d) => ACTIONS[d][action]) });
  const [domain, service] = ACTIONS[e.domain][action];
  await api(ctx).call(domain, service, { entity_id: e.id });
  // Give it a moment, then say what it is now.
  await sleep(700);
  const s = await api(ctx)
    .state(e.id)
    .catch(() => null);
  return { text: `Done: ${line(cat, e, s)}`, data: { entity: e.id, name: e.name, action, state: s?.state ?? null } };
}
const action = (name, summary) => ({
  summary,
  access: actionAccess(name),
  usage: '<name...>',
  run: guard((ctx, i) => act(ctx, name, i.name)),
});

export default {
  api: 1,
  name: 'ha',
  title: 'Home Assistant',
  description: 'the things in your home: see what is on, read sensors, switch lights and other devices',
  help: `Setup:
  bc ha setup        the address of Home Assistant and a long-lived access token
  bc ha sync         fetch the rooms and devices again (done every night, and after setup)

Examples:
  bc ha rooms
  bc ha devices living room
  bc ha state bedroom temperature
  bc ha off living room light
  bc ha set living room light --brightness 40
  bc ha set bedroom ac --temperature 23
  bc ha run movie night
  bc ha media rain                                   files in Home Assistant's media folder with "rain" in the name
  bc ha play bedroom speaker --media "rain thunder" --volume 30
  bc ha pause bedroom speaker
  bc ha check front door --is off --grace 10m     for: bc check add … --run 'blackcat ha check …'`,

  commands: {
    setup: {
      summary: 'connect to Home Assistant',
      access: 'owner',
      form: [
        {
          type: 'note',
          message:
            'You need a long-lived access token: in Home Assistant, open your profile (bottom left) → Security → Long-lived access tokens → Create token. A separate Home Assistant user for blackcat is a good idea.',
        },
        {
          id: 'url',
          type: 'text',
          message: "Home Assistant's address",
          default: (_a, ctx) => ctx.config.get().url ?? 'http://homeassistant.local:8123',
          validate: (v) => (/^https?:\/\/[^\s/]+(:\d+)?\/?$/.test(String(v).trim()) ? undefined : 'Like http://192.168.1.20:8123'),
        },
        { id: 'token', type: 'secret', message: 'The long-lived access token', keep: true },
        {
          id: 'free',
          type: 'confirm',
          message:
            'May the agent switch lights, switches, fans, scenes and media players without asking you? (Everything else always asks; locks and alarms ask every time.)',
          default: (_a, ctx) => ctx.config.get().free ?? true,
        },
      ],
      run: guard(async (ctx, a) => {
        const url = String(a.url).trim().replace(/\/+$/, '');
        const token = a.token || ctx.secrets.get('token'); // left empty: the one that is saved
        const cfg = await client({ url, token }).config();
        ctx.secrets.set('token', token);
        ctx.config.set({ url, free: !!a.free });
        const cat = await sync(ctx, api(ctx));
        const acts = cat.entities.filter(main).length;
        return [
          `Connected to ${cfg.location_name ?? 'Home Assistant'} (version ${cfg.version}).`,
          `Found ${cat.areas.length} room${cat.areas.length === 1 ? '' : 's'} and ${cat.entities.length} things, ${acts} of which can be controlled.`,
          a.free
            ? 'The agent may switch lights, switches, fans, scenes and media players by itself.'
            : 'The agent asks before switching anything.',
          'Try: bc ha rooms      Then restart the agent so it knows your home: bc restart agent',
        ].join('\n');
      }),
    },

    sync: {
      summary: 'fetch the rooms and devices from Home Assistant again',
      access: 'allow',
      untrusted: false,
      run: guard(async (ctx) => {
        const cat = await sync(ctx, api(ctx));
        return {
          text: `Synced: ${cat.areas.length} rooms, ${cat.entities.length} things (${cat.entities.filter(main).length} everyday ones you can control).`,
          data: { rooms: cat.areas.length, things: cat.entities.length },
        };
      }),
    },

    rooms: {
      summary: 'your rooms, and how many things in each can be controlled',
      access: 'allow',
      run: guard((ctx) => {
        const cat = catalogue(ctx);
        const rows = [
          ...cat.areas.map((a) => ({ name: a.name, things: inArea(cat, a.id) })),
          { name: '(no room)', things: inArea(cat, null) },
        ]
          .map((r) => ({
            name: r.name,
            ctl: r.things.filter(main),
            sensors: r.things.filter((e) => primary(e) && ['sensor', 'binary_sensor'].includes(e.domain)),
            rest: r.things.length,
          }))
          .filter((r) => r.ctl.length || r.sensors.length);
        return {
          text:
            rows
              .map(
                (r) =>
                  `${r.name}: ${r.ctl.length} to control, ${r.sensors.length} sensors${r.rest > r.ctl.length + r.sensors.length ? ` (+${r.rest - r.ctl.length - r.sensors.length} settings and diagnostics)` : ''}`,
              )
              .join('\n') || 'No rooms. Is anything assigned to an area in Home Assistant?',
          data: { rooms: rows.map((r) => ({ name: r.name, controllable: r.ctl.map((e) => e.name), sensors: r.sensors.length })) },
        };
      }),
    },

    devices: {
      summary: 'what is in a room (or everything controllable), with its state now',
      access: 'allow',
      usage: '[room...]',
      options: [['--all', 'include everything: settings, diagnostics, hidden things']],
      run: guard(async (ctx, i) => {
        const cat = catalogue(ctx);
        const room = i.room?.length ? findArea(cat, i.room) : null;
        if (i.room?.length && !room)
          ctx.fail(`No single room matches "${i.room.join(' ')}". Rooms: ${cat.areas.map((a) => a.name).join(', ')}`);
        // Everyday things only, unless --all: a device's settings and diagnostics are left out.
        const list = (room ? inArea(cat, room.id) : cat.entities).filter(
          (e) => i.all || main(e) || (room && primary(e) && ['sensor', 'binary_sensor', 'weather'].includes(e.domain)),
        );
        const states = new Map((await api(ctx).states()).map((s) => [s.entity_id, s]));
        // What can be reached now comes first; what is unavailable is only counted and named.
        const up = list.filter((e) => states.get(e.id) && states.get(e.id).state !== 'unavailable');
        const down = list.filter((e) => !up.includes(e));
        const shown = [...up.filter(main), ...up.filter((e) => !main(e))].slice(0, 80);
        return {
          text: [
            `${room ? room.name : 'Everything controllable'}: ${up.length} thing${up.length === 1 ? '' : 's'}${down.length ? `, and ${down.length} unavailable right now` : ''}`,
            ...shown.map((e) => `  ${line(cat, e, states.get(e.id))}${controllable(e) ? '' : '  [read only]'}`),
            ...(up.length > shown.length ? [`  …and ${up.length - shown.length} more`] : []),
            ...(down.length
              ? [
                  `  unavailable: ${down
                    .slice(0, 12)
                    .map((e) => e.name)
                    .join('; ')}${down.length > 12 ? `; and ${down.length - 12} more` : ''}`,
                ]
              : []),
          ].join('\n'),
          data: {
            room: room?.name ?? null,
            unavailable: down.map((e) => e.name),
            things: shown.map((e) => ({
              id: e.id,
              name: e.name,
              kind: e.domain,
              room: areaName(cat, e.area),
              state: states.get(e.id)?.state ?? null,
              text: states.get(e.id) ? describe(states.get(e.id), e) : null,
              controllable: controllable(e),
            })),
          },
        };
      }),
    },

    find: {
      summary: 'search every thing Home Assistant knows by name, including sensors',
      access: 'allow',
      usage: '<text...>',
      run: guard(async (ctx, i) => {
        const cat = catalogue(ctx);
        const terms = i.text.join(' ').toLowerCase().split(/\s+/);
        const hits = cat.entities
          .filter((e) => terms.every((t) => `${e.name} ${e.id} ${areaName(cat, e.area) ?? ''}`.toLowerCase().includes(t)))
          .slice(0, 40);
        if (!hits.length) return { text: 'Nothing matches.', data: { things: [] } };
        const states = new Map((await api(ctx).states()).map((s) => [s.entity_id, s]));
        return {
          text: hits.map((e) => `${line(cat, e, states.get(e.id))}  [${e.id}]`).join('\n'),
          data: {
            things: hits.map((e) => ({
              id: e.id,
              name: e.name,
              kind: e.domain,
              room: areaName(cat, e.area),
              text: states.get(e.id) ? describe(states.get(e.id), e) : null,
            })),
          },
        };
      }),
    },

    state: {
      summary: 'what one thing is doing right now',
      access: 'allow',
      usage: '<name...>',
      run: guard(async (ctx, i) => {
        const { cat, e } = await target(ctx, i.name);
        const s = await api(ctx).state(e.id);
        const { friendly_name: _f, icon: _i, entity_picture: _p, ...attrs } = s.attributes ?? {};
        return {
          text: `${line(cat, e, s)}\nlast changed ${new Date(s.last_changed).toLocaleString('en-GB')}`,
          data: {
            id: e.id,
            name: e.name,
            kind: e.domain,
            room: areaName(cat, e.area),
            state: s.state,
            text: describe(s, e),
            lastChanged: s.last_changed,
            attributes: attrs,
          },
        };
      }),
    },

    history: {
      summary: 'how a sensor or device has changed over the last hours',
      access: 'allow',
      usage: '<name...>',
      options: [
        ['--since <when>', 'how far back: 6h, 24h, 7d (default 24h, at most 7d)'],
        ['--hours <n>', 'the same, in hours'],
      ],
      run: guard(async (ctx, i) => {
        const { cat, e } = await target(ctx, i.name);
        let asked = Number(i.hours) || 24;
        if (i.since) {
          try {
            asked = parseDuration(i.since) / 3600;
          } catch (e) {
            ctx.fail(e.message);
          }
        }
        const hours = Math.min(168, Math.max(1, Math.ceil(asked)));
        const rows = ((await api(ctx).history(e.id, new Date(Date.now() - hours * 3600_000).toISOString()))?.[0] ?? []).filter(
          (r) => !['unknown', 'unavailable'].includes(r.state),
        );
        const nums = rows.map((r) => Number(r.state)).filter(Number.isFinite);
        const summary =
          nums.length > 2 && nums.length === rows.length
            ? `min ${Math.min(...nums)} · max ${Math.max(...nums)} · now ${nums.at(-1)}${e.unit ? ` ${e.unit}` : ''} (${rows.length} readings)`
            : rows
                .slice(-12)
                .map(
                  (r) =>
                    `${new Date(r.last_changed).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} ${r.state}`,
                )
                .join('\n') || 'no changes';
        return {
          text: `${e.name}${e.area ? ` (${areaName(cat, e.area)})` : ''}, last ${hours}h:\n${summary}`,
          data: { id: e.id, hours, readings: rows.length, changes: rows.slice(-40).map((r) => ({ at: r.last_changed, state: r.state })) },
        };
      }),
    },

    on: action('on', 'switch something on'),
    off: action('off', 'switch something off'),
    toggle: action('toggle', 'switch something to its other state'),
    open: action('open', 'open a blind, curtain or valve'),
    close: action('close', 'close a blind, curtain or valve'),
    stop: action('stop', 'stop a blind or curtain where it is, or what a speaker or TV is playing'),
    pause: action('pause', 'pause what a speaker or TV is playing'),
    lock: action('lock', 'lock a lock'),
    unlock: action('unlock', 'unlock a lock'),
    run: action('run', 'run a scene or script, or press a button'),

    media: {
      summary:
        "the files in Home Assistant's own media folder that a speaker or TV can be asked to play: all of them, or those whose name has these words",
      access: 'allow',
      usage: '[words...]',
      run: guard(async (ctx, i) => {
        const cat = catalogue(ctx);
        const all = await libraryVia(api(ctx), players(cat));
        const hits = matching(all, i.words ?? []);
        const asked = (i.words ?? []).join(' ');
        if (!hits.length)
          return {
            text: all.length
              ? `Nothing in the media folder has "${asked}" in its name. There ${all.length === 1 ? 'is' : 'are'} ${all.length}: see bc ha media`
              : 'Home Assistant\'s media folder is empty. (Files go in its "media" folder: Media → My media → Manage.)',
            data: { media: [], total: all.length },
          };
        return {
          text: `${hits.length}${asked ? ` of ${all.length}` : ''} in Home Assistant's media folder:\n${hits.map((m) => `  ${m.folder ? `${m.folder}/` : ''}${shown(m.title)}`).join('\n')}\n\nPlay one: bc ha play <speaker> --media "<some words of its name>" [--volume 30]`,
          data: {
            media: hits.map((m) => ({ name: shown(m.title), ...(m.folder ? { folder: m.folder } : {}), kind: m.type })),
            total: all.length,
          },
        };
      }),
    },
    play: {
      summary:
        'play on a speaker or TV: a file from the media folder (--media, by words of its name), at a volume if you give one; without --media, carry on with what was playing',
      access: actionAccess('play', ['media_player']),
      usage: '<name...>',
      options: [
        ['--media <words>', 'which file from the media folder: enough words of its name to mean one (see: bc ha media)'],
        ['--volume <percent>', 'set the volume too: 0 to 100'],
      ],
      run: guard(async (ctx, i) => {
        const { cat, e } = await target(ctx, i.name, { domains: ['media_player'] });
        const ha = api(ctx);
        const volume =
          i.volume == null
            ? null
            : Number.isFinite(Number(i.volume)) && Number(i.volume) >= 0 && Number(i.volume) <= 100
              ? Number(i.volume)
              : ctx.fail('--volume is a number from 0 to 100.');
        // Which file is meant is settled before anything is done to the speaker.
        let item = null;
        if (i.media != null) {
          const all = await libraryVia(ha, [e.id, ...players(cat).filter((id) => id !== e.id)]);
          const hits = matching(all, String(i.media));
          if (!hits.length)
            ctx.fail(`Nothing in Home Assistant's media folder has "${i.media}" in its name. See what there is: bc ha media`);
          if (hits.length > 1)
            ctx.fail(
              `"${i.media}" could be ${hits.length} files: ${hits
                .slice(0, 6)
                .map((m) => `"${shown(m.title)}"`)
                .join(', ')}${hits.length > 6 ? ', …' : ''}. Give more of the name.`,
            );
          [item] = hits;
        }
        const setVolume = () => ha.call('media_player', 'volume_set', { entity_id: e.id, volume_level: volume / 100 });
        // The volume first, so it never starts loud. A speaker that is off may not take it
        // until something is playing: then it is set straight after.
        let later = false;
        if (volume != null) await setVolume().catch((err) => (err instanceof HaError ? (later = true) : Promise.reject(err)));
        if (item)
          await ha.call('media_player', 'play_media', { entity_id: e.id, media_content_id: item.id, media_content_type: item.type });
        else await ha.call('media_player', 'media_play', { entity_id: e.id });
        if (later) {
          await sleep(wait.volume);
          await setVolume();
        }
        await sleep(wait.settle);
        const s = await ha.state(e.id).catch(() => null);
        return {
          text: `${item ? `Playing "${shown(item.title)}" on` : 'Playing on'} ${line(cat, e, s)}`,
          data: {
            entity: e.id,
            name: e.name,
            action: 'play',
            ...(item ? { media: shown(item.title) } : {}),
            ...(volume != null ? { volume } : {}),
            state: s?.state ?? null,
          },
        };
      }),
    },
    set: {
      summary: 'set a value: brightness, temperature, position, volume, mode',
      access: actionAccess('set', SETTABLE),
      usage: '<name...>',
      options: [
        ['--brightness <percent>', 'a light: 0 to 100'],
        ['--color <name>', 'a light: a colour name, e.g. warmwhite, red'],
        ['--temperature <degrees>', 'a thermostat or AC'],
        ['--mode <mode>', 'a thermostat or AC: cool, heat, auto, off, …'],
        ['--position <percent>', 'a blind: 0 (closed) to 100 (open)'],
        ['--volume <percent>', 'a media player'],
        ['--speed <percent>', 'a fan'],
        ['--value <value>', 'a number or a choice (input_number, input_select)'],
      ],
      run: guard(async (ctx, i) => {
        const { cat, e } = await target(ctx, i.name, { domains: SETTABLE });
        const num = (v, lo, hi, what) =>
          Number.isFinite(Number(v)) && Number(v) >= lo && Number(v) <= hi
            ? Number(v)
            : ctx.fail(`${what} is a number from ${lo} to ${hi}.`);
        const calls = [];
        const id = { entity_id: e.id };
        if (e.domain === 'light' && (i.brightness != null || i.color))
          calls.push([
            'light',
            'turn_on',
            {
              ...id,
              ...(i.brightness != null ? { brightness_pct: num(i.brightness, 0, 100, '--brightness') } : {}),
              ...(i.color ? { color_name: String(i.color) } : {}),
            },
          ]);
        if (e.domain === 'climate' && i.mode) calls.push(['climate', 'set_hvac_mode', { ...id, hvac_mode: String(i.mode) }]);
        if (['climate', 'water_heater'].includes(e.domain) && i.temperature != null)
          calls.push([e.domain, 'set_temperature', { ...id, temperature: num(i.temperature, 5, 40, '--temperature') }]);
        if (e.domain === 'cover' && i.position != null)
          calls.push(['cover', 'set_cover_position', { ...id, position: num(i.position, 0, 100, '--position') }]);
        if (e.domain === 'media_player' && i.volume != null)
          calls.push(['media_player', 'volume_set', { ...id, volume_level: num(i.volume, 0, 100, '--volume') / 100 }]);
        if (e.domain === 'fan' && i.speed != null)
          calls.push(['fan', 'set_percentage', { ...id, percentage: num(i.speed, 0, 100, '--speed') }]);
        if (['input_number', 'number'].includes(e.domain) && i.value != null)
          calls.push([e.domain, 'set_value', { ...id, value: Number(i.value) }]);
        if (['input_select', 'select'].includes(e.domain) && i.value != null)
          calls.push([e.domain, 'select_option', { ...id, option: String(i.value) }]);
        if (!calls.length) ctx.fail(`Nothing to set on ${e.name} (a ${e.domain}) with those options. See: bc ha set --help`);
        for (const [d, s, data] of calls) await api(ctx).call(d, s, data);
        await sleep(700);
        const s = await api(ctx)
          .state(e.id)
          .catch(() => null);
        return {
          text: `Done: ${line(cat, e, s)}`,
          data: { entity: e.id, name: e.name, state: s?.state ?? null, text: s ? describe(s, e) : null },
        };
      }),
    },

    check: {
      summary: 'succeed only if a thing is in the state you expect (made for checks)',
      access: 'allow',
      usage: '<name...>',
      options: [
        ['--is <state>', 'it must be in this state, e.g. off, home, locked'],
        ['--not <state>', 'it must not be in this state'],
        ['--above <n>', 'its value must be above this'],
        ['--below <n>', 'its value must be below this'],
        ['--grace <duration>', 'only fail once it has been wrong for this long, e.g. 10m'],
      ],
      run: guard(async (ctx, i) => {
        const { e } = await target(ctx, i.name);
        const s = await api(ctx).state(e.id);
        const v = Number(s.state);
        const wrong =
          (i.is != null && s.state !== String(i.is)) ||
          (i.not != null && s.state === String(i.not)) ||
          (i.above != null && !(v > Number(i.above))) ||
          (i.below != null && !(v < Number(i.below)));
        if (i.is == null && i.not == null && i.above == null && i.below == null)
          ctx.fail('Say what to expect: --is, --not, --above or --below.');
        const unit = s.attributes?.unit_of_measurement ? ` ${s.attributes.unit_of_measurement}` : '';
        if (!wrong) return `${e.name} is ${s.state}${unit}`;
        const mins = (Date.now() - new Date(s.last_changed).getTime()) / 60_000;
        const m = /^(\d+)\s*([mh])$/.exec(String(i.grace ?? '0m'));
        const grace = m ? Number(m[1]) * (m[2] === 'h' ? 60 : 1) : 0;
        if (mins < grace) return `${e.name} is ${s.state}${unit}, but only for ${Math.round(mins)} min (allowed: ${grace})`;
        return ctx.fail(
          `${e.name} has been ${s.state}${unit} for ${mins >= 120 ? `${Math.round(mins / 60)} hours` : `${Math.round(mins)} minutes`}`,
        );
      }),
    },

    kind: {
      summary: 'how freely the agent may act on a whole kind of thing (light, cover, lock…): free, ask, guarded or default',
      access: 'owner',
      usage: '[kind] [level]',
      run: guard(async (ctx, i) => {
        const cat = readCatalogue(ctx);
        const kinds = [...new Set(cat.entities.filter((e) => main(e) && controllable(e)).map((e) => e.domain))].sort();
        const own = { ...settings(ctx).kinds };
        const rule = (k) => own[k] ?? (settings(ctx).free === false && KIND_DEFAULTS[k] === 'free' ? 'ask' : (KIND_DEFAULTS[k] ?? 'ask'));
        if (!i.kind)
          return {
            text: [
              'How freely the agent may act, by kind (yours are marked *):',
              ...kinds.map((k) => `  ${k.padEnd(22)} ${rule(k)}${own[k] ? ' *' : ''}`),
              'Change one: bc ha kind cover free   ·   back to the built-in rule: bc ha kind cover default',
              'A level set for a single thing (bc ha level) still takes precedence.',
            ].join('\n'),
            data: { kinds: Object.fromEntries(kinds.map((k) => [k, rule(k)])), own },
          };
        if (!kinds.includes(i.kind) && !KIND_DEFAULTS[i.kind])
          ctx.fail(`Your home has no "${i.kind}". The kinds are: ${kinds.join(', ')}.`);
        if (!i.level) return `${i.kind}: ${rule(i.kind)}${own[i.kind] ? ' (set by you)' : ' (the built-in rule)'}`;
        if (![...LEVELS, 'default'].includes(i.level)) ctx.fail(`The level is one of: ${LEVELS.join(', ')}, or default.`);
        if (i.level === 'default') delete own[i.kind];
        else own[i.kind] = i.level;
        ctx.config.set({ kinds: own });
        return `${i.kind}: the agent's level is now ${rule(i.kind)}${i.level === 'default' ? ' (the built-in rule)' : ''}. Restart the agent so it knows: bc restart agent`;
      }),
    },

    level: {
      summary: 'how freely the agent may act on one thing: free, ask or guarded (overrides the rule for its kind)',
      access: 'owner',
      usage: '<level> <name...>',
      run: guard(async (ctx, i) => {
        if (![...LEVELS, 'default'].includes(i.level))
          ctx.fail(`The level is one of: ${LEVELS.join(', ')}, or default. e.g. bc ha level guarded garden gate`);
        const { cat, e } = await target(ctx, i.name);
        const levels = { ...settings(ctx).levels };
        if (i.level === 'default') delete levels[e.id];
        else levels[e.id] = i.level;
        ctx.config.set({ levels });
        return `${e.name}${e.area ? ` (${areaName(cat, e.area)})` : ''}: the agent's level is now ${levelFor(e, settings(ctx))}${i.level === 'default' ? ' (the rule for its kind)' : ''}.`;
      }),
    },
  },

  jobs: [
    {
      id: 'sync',
      cron: '10 4 * * *',
      when: configured,
      summary: 'refresh the rooms and devices',
      run: async (ctx) => {
        try {
          await sync(ctx, api(ctx));
          return { did: 'rooms and devices refreshed' };
        } catch (e) {
          ctx.log(`sync failed: ${e.message}`);
          throw e; // so the run is recorded as failed
        }
      },
    },
  ],

  // What it adds to the chat, on whichever channel is in use.
  chat: {
    install: async (ui, { ctx }) => (await import('./chat.js')).install(ui, ctx),
    // "turn on kitchen lights", "kitchen lights off": done without the agent when it is one of a
    // few fixed sentence shapes and names exactly one thing. See quick.js.
    quick: async (text, { ctx }) => {
      const cat = readCatalogue(ctx);
      if (!cat || !configured(ctx)) return null;
      const { plan, carryOut } = await import('./quick.js');
      const pl = plan(text, cat, settings(ctx));
      if (!pl) return null;
      const names = pl.things.map((e) => e.name).join(', ');
      const run = async () => {
        try {
          const said = await carryOut(pl, cat, api(ctx));
          ctx.log(`${pl.action}: ${names} (direct, without the agent)`);
          return { text: `✅ ${said}`, note: `${pl.action} → ${said.replace(/\n/g, '; ')}` };
        } catch (e) {
          return { text: `😿 ${e.message}`, note: `tried to ${pl.action} ${names}, which failed: ${e.message}` };
        }
      };
      return pl.free
        ? run()
        : {
            confirm: `${pl.action === 'on' || pl.action === 'off' ? `Turn ${pl.action}` : pl.action[0].toUpperCase() + pl.action.slice(1)}: ${names}?`,
            run,
          };
    },
  },

  // No network call here: `bc status` must stay quick.
  // `bc selftest`: Home Assistant asked what it is. Nothing is switched.
  selftest: (ctx) =>
    configured(ctx)
      ? [
          {
            name: settings(ctx).url,
            run: async () => {
              const cfg = await api(ctx).config();
              const cat = readCatalogue(ctx);
              return `answers · version ${cfg.version ?? '?'}${cfg.location_name ? ` · ${cfg.location_name}` : ''}${cat ? ` · ${cat.entities.length} things known here` : ' · not synced yet (bc ha sync)'}`;
            },
          },
        ]
      : [],

  status: (ctx) => {
    const cat = readCatalogue(ctx);
    if (!configured(ctx)) return 'not set up → bc ha setup';
    return cat
      ? `connected to ${settings(ctx).url} · ${cat.areas.length} rooms · ${cat.entities.filter(main).length} things to control · synced ${new Date(cat.synced * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
      : `connected to ${settings(ctx).url} · not synced yet → bc ha sync`;
  },

  settings: (ctx) => {
    const s = settings(ctx);
    const own = Object.entries(s.levels ?? {});
    return {
      address: s.url ?? 'not set',
      'the agent may switch lights, switches, fans, scenes and media players without asking': s.free === false ? 'no' : 'yes',
      'levels set for whole kinds': Object.keys(s.kinds ?? {}).length
        ? Object.entries(s.kinds)
            .map(([k, l]) => `${k}: ${l}`)
            .join(', ')
        : 'none (the built-in rules; see bc ha kind)',
      'levels set for single things': own.length ? own.map(([id, l]) => `${id}: ${l}`).join(', ') : 'none',
    };
  },

  // For `bc engine check`: what the owner might say, and the command it should lead to.
  checks: (ctx) =>
    configured(ctx) && readCatalogue(ctx)
      ? [
          { say: 'is anything left switched on at home right now?', expect: /blackcat ha \w+/ },
          { say: 'what sounds or music files do i have at home that you could play on a speaker?', expect: /blackcat ha media\b/ },
        ]
      : [],
  agent: {
    fill: (ctx) => {
      const cat = readCatalogue(ctx);
      if (!configured(ctx) || !cat) return { ready: false };
      const cfg = settings(ctx);
      const SENSORS = [
        'temperature',
        'humidity',
        'door',
        'window',
        'motion',
        'occupancy',
        'presence',
        'opening',
        'garage_door',
        'lock',
        'smoke',
        'moisture',
        'carbon_dioxide',
        'illuminance',
      ];
      // Everyday things that were reachable at the last sync. Settings, diagnostics and things that are gone stay out.
      const worth = (e) =>
        e.available !== false &&
        primary(e) &&
        (main(e) ||
          (['sensor', 'binary_sensor'].includes(e.domain) && SENSORS.includes(e.deviceClass)) ||
          ['weather', 'person'].includes(e.domain));
      const tag = (e) => {
        const l = controllable(e) ? levelFor(e, cfg) : null;
        return `${e.name} [${e.domain}${l && l !== 'free' ? `, ${l === 'guarded' ? 'asks every time' : 'asks'}` : ''}]`;
      };
      let left = 160; // keep this section a reasonable size however large the home is
      const rooms = [...cat.areas.map((a) => [a.name, inArea(cat, a.id)]), ['No room', inArea(cat, null)]]
        .map(([name, things]) => {
          const keep = things.filter(worth).slice(0, Math.max(0, left));
          left -= keep.length;
          return keep.length ? `- ${name}: ${keep.map(tag).join('; ')}` : null;
        })
        .filter(Boolean);
      const total = cat.entities.filter(worth).length;
      return {
        ready: true,
        location: cat.location ? ` ("${cat.location}")` : '',
        rooms,
        // (How many everyday things did not fit in the list above, if any.)
        more: total > 160 ? total - 160 : null,
        'all-listed': total <= 160,
        'none-free': cfg.free === false ? ' (none at present: the owner chose to be asked for everything)' : '',
      };
    },
  },
};
