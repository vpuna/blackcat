// Allsky: an all-sky camera's pictures, fetched from its own web server. The latest image,
// the one closest to a time, and what Allsky makes of a night (star trails, a keogram, a
// timelapse). The camera can be on this machine or any other: only its address is needed.
import fs from 'node:fs';
import path from 'node:path';
import { AllskyError, PRODUCTS, client, closest, findProduct, mb, nightOf, nights, parseMoment, parseNight, prettyNight } from './api.js';
import { dataPath, parseDuration } from '../../src/api.js';

// Where what is fetched is kept: one file of each kind, replaced each time, so they don't
// pile up. The agent may look at these and send them, and nothing else of the plugin's.
const MEDIA = dataPath('allsky-media');
const DEFAULTS = { maxMb: 50, staleMin: 10 };
const settings = (ctx) => ({ ...DEFAULTS, ...ctx.config.get() });
const configured = (ctx) => !!ctx.config.get().url;
const api = (ctx, extra = {}) => {
  const s = settings(ctx);
  if (!s.url) ctx.fail('Allsky is not set up yet. Run: bc allsky setup');
  return client({ url: s.url, user: s.user, password: ctx.secrets.get('password'), ...extra });
};
// Turn a problem with the camera into a message for the person, not a stack trace.
const run = (fn) => async (ctx, input) => {
  try {
    return await fn(ctx, input);
  } catch (e) {
    if (e instanceof AllskyError) ctx.fail(e.message);
    throw e;
  }
};
const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const ago = (ms) =>
  ms < 90_000
    ? `${Math.round(ms / 1000)} s`
    : ms < 90 * 60_000
      ? `${Math.round(ms / 60_000)} min`
      : ms < 36 * 3600_000
        ? `${Math.round(ms / 3600_000)} h`
        : `${Math.round(ms / 86400_000)} days`;
const LATEST = '/current/tmp/image.jpg';

// Fetch something to the media folder. → { path, bytes }
async function fetchTo(ctx, c, from, name) {
  fs.mkdirSync(MEDIA, { recursive: true, mode: 0o700 });
  const dest = path.join(MEDIA, name);
  const bytes = await c.download(from, dest, settings(ctx).maxMb * 1024 ** 2);
  return { path: dest, bytes };
}

// How the camera is doing: reachable, and how old its latest picture is.
async function health(ctx, ms = 20_000) {
  const s = settings(ctx);
  const h = await api(ctx).head(LATEST, ms);
  const ageMs = h.modified ? Date.now() - h.modified.getTime() : null;
  return { ageMs, stale: ageMs != null && ageMs > s.staleMin * 60_000, modified: h.modified };
}

// A night's product, fetched: the command behind startrails, keogram and timelapse.
const product = (kind) => ({
  summary: `the ${PRODUCTS[kind].label} of a night (the latest night that has one, unless you name a night), saved where it can be looked at and sent`,
  access: 'allow',
  sends: true,
  options: [['--night <date>', 'which night: 2026-10-04 (the day it began), last, yesterday, tonight']],
  run: run(async (ctx, i) => {
    const c = api(ctx);
    const night = parseNight(i.night);
    const found = await findProduct(c, kind, night);
    if (!found)
      ctx.fail(
        night
          ? `Allsky has no ${PRODUCTS[kind].label} for the night of ${prettyNight(night)}. See which nights there are: bc allsky nights`
          : `Allsky has no ${PRODUCTS[kind].label} for any of its last nights. (It makes one at the end of a night, if it is set to.)`,
      );
    const ext = path.extname(found.path).toLowerCase() || '.jpg';
    const got = await fetchTo(ctx, c, found.path, `${kind}${ext}`);
    const caption = `${PRODUCTS[kind].label[0].toUpperCase()}${PRODUCTS[kind].label.slice(1)}, night of ${prettyNight(found.night)}`;
    return {
      text: `${caption}: saved ${got.path} (${mb(got.bytes)})`,
      data: { kind, night: prettyNight(found.night), path: got.path, bytes: got.bytes, caption },
    };
  }),
});

export default {
  api: 1,
  name: 'allsky',
  title: 'Allsky',
  description: "an all-sky camera: the sky now, at any time of a night, and each night's star trails, keogram and timelapse",
  help: `Examples:
  bc allsky setup                          the camera's address (and a login, if its pictures ask for one)
  bc allsky now                            the latest picture
  bc allsky at 02:30                       the picture closest to the last time it was 02:30
  bc allsky at 23:00 --night 2026-10-03    … on a night you name (the day the night began)
  bc allsky startrails                     the latest night's star trails (also: keogram, timelapse)
  bc allsky nights                         which nights it has
  bc allsky camera exposure                how the camera itself is set (all of it, or by a word in the name)
  bc allsky check --max-age 10m            for a check: fails unless it is taking pictures

In the bot the same commands send the picture: /allsky now, /allsky startrails.`,

  commands: {
    setup: {
      summary: "the camera's address, and a login if its pictures ask for one",
      access: 'owner',
      working: 'Looking for the camera…',
      form: [
        {
          type: 'note',
          message:
            'Allsky serves its pictures from its own web pages. Give the address you open those pages at. A login is only needed if the pictures themselves ask for one (the settings pages asking for one does not count).',
        },
        {
          id: 'url',
          type: 'text',
          message: "Allsky's address",
          default: (_a, ctx) => ctx.config.get().url ?? 'http://localhost',
          validate: (v) =>
            /^https?:\/\/[^\s/]+(:\d+)?(\/[^\s]*)?$/.test(String(v).trim()) ? undefined : 'Like http://192.168.1.30 or http://allsky.local',
        },
        {
          id: 'user',
          type: 'text',
          message: 'User name for its pictures (empty: they need no login)',
          default: (_a, ctx) => ctx.config.get().user ?? '',
          optional: true,
        },
        { id: 'password', type: 'secret', message: 'The password', keep: true, when: (a) => !!String(a.user ?? '').trim() },
        {
          id: 'maxMb',
          type: 'text',
          message: 'Largest file to fetch, in MB (a timelapse can be large; Telegram sends up to 50)',
          default: (_a, ctx) => String(settings(ctx).maxMb),
          validate: (v) => (/^\d+$/.test(String(v)) && Number(v) >= 1 && Number(v) <= 2000 ? undefined : 'A number from 1 to 2000'),
        },
        {
          id: 'staleMin',
          type: 'text',
          message: 'How old may the latest picture be before the camera counts as stopped? (minutes)',
          default: (_a, ctx) => String(settings(ctx).staleMin),
          validate: (v) =>
            /^\d+$/.test(String(v)) && Number(v) >= 1 && Number(v) <= 1440 ? undefined : 'A number of minutes, from 1 to 1440',
        },
      ],
      run: run(async (ctx, a) => {
        const url = String(a.url).trim().replace(/\/+$/, '');
        const user = String(a.user ?? '').trim();
        const password = user ? a.password || ctx.secrets.get('password') : undefined; // left empty: the one that is saved
        // Try it before anything is saved.
        const c = client({ url, user, password });
        const h = await c.head(LATEST);
        const have = await nights(c).catch((e) => (e.missing ? [] : Promise.reject(e)));
        ctx.config.set({ url, user: user || undefined, maxMb: Number(a.maxMb), staleMin: Number(a.staleMin) });
        if (user) ctx.secrets.set('password', password);
        else ctx.secrets.delete('password');
        const age = h.modified ? Date.now() - h.modified.getTime() : null;
        return [
          `Connected to Allsky at ${url}${user ? ` as ${user}` : ''}.`,
          age == null ? 'It has a latest picture.' : `Its latest picture is ${ago(age)} old.`,
          have.length
            ? `It has ${have.length} night${have.length === 1 ? '' : 's'}, from ${prettyNight(have[0])} to ${prettyNight(have.at(-1))}.`
            : 'It has no saved nights yet.',
          'Try: bc allsky now      Then restart the agent so it knows the camera: bc restart agent',
        ].join('\n');
      }),
    },

    now: {
      summary: 'the latest picture of the sky, saved where it can be looked at and sent',
      access: 'allow',
      sends: true,
      run: run(async (ctx) => {
        const c = api(ctx);
        const h = await c.head(LATEST).catch(() => ({}));
        const got = await fetchTo(ctx, c, LATEST, 'now.jpg');
        const age = h.modified ? Date.now() - h.modified.getTime() : null;
        const stale = age != null && age > settings(ctx).staleMin * 60_000;
        const caption =
          age == null
            ? 'The sky now'
            : stale
              ? `The latest picture is ${ago(age)} old: the camera may have stopped`
              : `The sky at ${hhmm(h.modified)}`;
        return {
          text: `${caption}: saved ${got.path} (${mb(got.bytes)})`,
          data: {
            path: got.path,
            bytes: got.bytes,
            taken: h.modified?.toISOString() ?? null,
            ageSeconds: age == null ? null : Math.round(age / 1000),
            stale,
            caption,
          },
        };
      }),
    },

    at: {
      summary: 'the picture taken closest to a time: the last time it was that time, or on a night you name',
      access: 'allow',
      sends: true,
      usage: '<time>',
      options: [['--night <date>', 'which night: 2026-10-04 (the day it began), last, yesterday, tonight']],
      run: run(async (ctx, i) => {
        const c = api(ctx);
        const all = await nights(c);
        const named = i.night ? (parseNight(i.night) ?? all.at(-1)) : null;
        const moment = parseMoment(i.time, named);
        const night = named ?? nightOf(moment);
        let names;
        try {
          names = await c.listing(`/images/${night}/`);
        } catch (e) {
          if (!e.missing) throw e;
          ctx.fail(
            `Allsky has no pictures for the night of ${prettyNight(night)}${all.length ? ` (it has ${prettyNight(all[0])} to ${prettyNight(all.at(-1))})` : ''}.`,
          );
        }
        const best = closest(names, moment);
        if (!best) ctx.fail(`Allsky has no pictures for the night of ${prettyNight(night)}.`);
        const got = await fetchTo(ctx, c, `/images/${night}/${best.name}`, `at${path.extname(best.name).toLowerCase()}`);
        const off =
          best.offMs > 20 * 60_000
            ? ` (the closest there is to ${hhmm(moment)}: ${ago(best.offMs)} away, so the camera was not taking pictures then)`
            : '';
        const caption = `The sky at ${hhmm(best.at)}, night of ${prettyNight(night)}${off}`;
        return {
          text: `${caption}: saved ${got.path} (${mb(got.bytes)})`,
          data: {
            path: got.path,
            bytes: got.bytes,
            taken: best.at.toISOString(),
            asked: moment.toISOString(),
            night: prettyNight(night),
            offSeconds: Math.round(best.offMs / 1000),
            caption,
          },
        };
      }),
    },

    startrails: product('startrails'),
    keogram: product('keogram'),
    timelapse: product('timelapse'),

    nights: {
      summary: 'the nights the camera has pictures for',
      access: 'allow',
      options: [['-n, --limit <n>', 'how many, latest first', '14']],
      run: run(async (ctx, i) => {
        const all = (await nights(api(ctx))).reverse();
        const shown = all.slice(0, Math.max(1, Number(i.limit) || 14));
        return {
          text: all.length
            ? `${all.length} night${all.length === 1 ? '' : 's'} (named for the day each began), latest first:\n${shown.map((n) => `  ${prettyNight(n)}${n === nightOf(new Date()) ? '  (tonight)' : ''}`).join('\n')}${all.length > shown.length ? `\n  … and ${all.length - shown.length} earlier` : ''}`
            : 'Allsky has no saved nights yet.',
          data: { nights: shown.map(prettyNight), total: all.length, tonight: prettyNight(nightOf(new Date())) },
        };
      }),
    },

    camera: {
      summary: 'how the camera itself is set (exposure, gain, location…): all of it, or the settings whose name contains a word',
      access: 'allow',
      usage: '[word]',
      run: run(async (ctx, i) => {
        const all = await api(ctx).json('/config/settings.json');
        // Anything that could be a login of the camera's own is left out.
        const safe = Object.entries(all ?? {}).filter(([k]) => !/pass|secret|token|apikey|api_key|user|login|key$/i.test(k));
        const word = String(i.word ?? '').toLowerCase();
        const rows = word ? safe.filter(([k]) => k.toLowerCase().includes(word)) : safe;
        if (!rows.length) ctx.fail(word ? `Allsky has no setting with "${i.word}" in its name.` : 'Allsky gave no settings.');
        return {
          text: rows.map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n'),
          data: { settings: Object.fromEntries(rows) },
        };
      }),
    },

    check: {
      summary: 'succeed only if the camera is reachable and its latest picture is recent (made for checks)',
      access: 'allow',
      untrusted: false,
      options: [['--max-age <time>', 'how old the latest picture may be: 10m, 1h (default: what setup says)']],
      run: run(async (ctx, i) => {
        let limitMs = settings(ctx).staleMin * 60_000;
        if (i.maxAge) {
          try {
            limitMs = parseDuration(i.maxAge) * 1000;
          } catch (e) {
            ctx.fail(e.message);
          }
        }
        const h = await health(ctx);
        if (h.ageMs == null) ctx.fail('Allsky has a latest picture but does not say when it was taken.');
        if (h.ageMs > limitMs)
          ctx.fail(`Allsky's latest picture is ${ago(h.ageMs)} old (taken at ${hhmm(h.modified)}): it has stopped taking pictures.`);
        return { text: `ok: the latest picture is ${ago(h.ageMs)} old`, data: { ok: true, ageSeconds: Math.round(h.ageMs / 1000) } };
      }),
    },
  },

  // One line for `bc status`: quick, and never in the way if the camera is off.
  // `bc selftest`: the camera asked for its latest picture's date. Nothing is fetched.
  selftest: (ctx) =>
    configured(ctx)
      ? [
          {
            name: settings(ctx).url,
            run: async () => {
              const h = await health(ctx);
              if (h.stale) throw new Error(`it answers, and is not taking pictures: the latest is ${ago(h.ageMs)} old`);
              return h.ageMs == null ? 'answers' : `answers · the latest picture is ${ago(h.ageMs)} old`;
            },
          },
        ]
      : [],

  status: async (ctx) => {
    if (!configured(ctx)) return 'not set up → bc allsky setup';
    try {
      const h = await health(ctx, 3000);
      return h.ageMs == null
        ? `reachable at ${settings(ctx).url}`
        : h.stale
          ? `NOT TAKING PICTURES: the latest is ${ago(h.ageMs)} old`
          : `taking pictures · the latest is ${ago(h.ageMs)} old`;
    } catch (e) {
      return `NOT REACHABLE: ${e.message}`;
    }
  },

  // For `bc engine check`: what the owner might say, and the command it should lead to.
  checks: (ctx) =>
    configured(ctx)
      ? [
          { say: "show me last night's star trails", expect: /blackcat allsky startrails\b/ },
          { say: 'what did the sky look like at 2am?', expect: /blackcat allsky at 0?2:00\b/ },
        ]
      : [],

  agent: {
    readDirs: () => [MEDIA],
    fill: (ctx) => ({ ready: configured(ctx) }),
  },
};
