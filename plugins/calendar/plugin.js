// Calendar: reads your calendars through their private iCal address (Google, iCloud,
// Outlook and most others have one). Read-only by nature: that address cannot change
// anything. Events are fetched every half hour into a local copy, so "what's on today?"
// is answered without going online. The coming week's events are put on the "Things I
// need to do" list (through `agenda`), which is how they reach the daily briefing.
import crypto from 'node:crypto';
import {
  accountKey,
  accountName,
  accountNameQuestions,
  ago,
  chosenAccountName,
  hm,
  mentioning,
  nameOf,
  personLabel,
  plural,
  renameAccount,
  ymd,
} from '../../src/api.js';

const BACK_DAYS = 7;
const AHEAD_DAYS = 120;
const SYNC_EVERY = '30m';
const FETCH_TIMEOUT_MS = 30_000;
const MAX_BYTES = 20 * 1024 ** 2;
const NAME = /^[a-z][a-z0-9_-]{0,24}$/;

// The calendar parser is loaded when a feed is actually read.
const ics = () => import('./ics.js');

// Each calendar is kept under a key that never changes (its address and its events are filed
// under it); the name it is known by can change (bc calendar rename).
const cals = (ctx) => ctx.config.get().calendars ?? {};
const label = (ctx, key) => accountName(cals(ctx), key);
const RULE_TEXT = 'Lowercase letters, digits, - or _, starting with a letter';
// The key of the calendar called `name`.
const keyFor = (ctx, name) => {
  const key = accountKey(cals(ctx), name);
  if (key == null) ctx.fail(`There is no calendar called "${name}". See: bc calendar list`);
  return key;
};
// What was last read from the calendars, kept in the plugin's store. (It was a file,
// events.json; one from then is taken over the first time this is asked.)
const cache = (ctx) => {
  const kept = ctx.store.get('events');
  return kept && Array.isArray(kept.events) ? kept : { syncedAt: 0, events: [], errors: {} };
};
const dayLabel = (day) => {
  const today = ymd(Date.now());
  if (day === today) return 'Today';
  if (day === ymd(Date.now() + 86400000)) return 'Tomorrow';
  return new Date(`${day}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
};

async function fetchFeed(url) {
  const res = await fetch(url.replace(/^webcal:/i, 'https:'), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
  if (!res.ok)
    throw new Error(
      res.status === 404 || res.status === 403
        ? "the address was not accepted (has the calendar's secret address been reset?)"
        : `the calendar's server answered ${res.status}`,
    );
  if (!/^https:/i.test(res.url) && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(res.url))
    throw new Error('the calendar was redirected to an address that is not https');
  // Read no further than the limit: the size is checked as it arrives, not afterwards.
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error('the calendar is too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!/BEGIN:VCALENDAR/.test(text))
    throw new Error('that address does not return a calendar. Use the secret address in iCal format, which ends in .ics');
  return text;
}

// Fetch every calendar. One that fails keeps the events it had, and the failure is noted.
// A calendar's contents in a few characters. The same calendar comes back with its events
// and lines in a different order every time, and with a "generated at" stamp on every event,
// so the lines are compared as a set, without those stamps.
export const fingerprint = (text) =>
  crypto
    .createHash('sha1')
    .update(
      String(text)
        .split(/\r?\n/)
        .filter((l) => !/^DTSTAMP:/.test(l))
        .sort()
        .join('\n'),
    )
    .digest('hex');

// What is read from an event. Raised when more is read (2: who it is from and with), so that
// a calendar copied before is read again though it has not changed.
const READS = 2;

// `full`: read every calendar again, whether or not it looks the same.
async function sync(ctx, { full = false } = {}) {
  const old = cache(ctx);
  const from = Date.now() - BACK_DAYS * 86400000;
  const to = Date.now() + AHEAD_DAYS * 86400000;
  const events = [];
  const errors = {};
  const seen = {};
  const read = []; // the calendars that had changed and were read again
  const today = ymd(Date.now());
  for (const name of Object.keys(cals(ctx))) {
    try {
      const text = await fetchFeed(ctx.secrets.get(`url:${name}`));
      // Reading a calendar takes seconds on a small machine; finding out that it is the same
      // one as last time takes a moment. It is read again when it has changed, and once a
      // day regardless (the days it is read for move on).
      const print = fingerprint(text);
      seen[name] = { print, day: today, reads: READS };
      const was = old.seen?.[name];
      if (!full && was?.print === print && was.day === today && was.reads === READS && !old.errors?.[name])
        events.push(...old.events.filter((ev) => ev.cal === name));
      else {
        events.push(...(await ics()).readCalendar(text, name, from, to));
        read.push(name);
      }
    } catch (e) {
      if (old.seen?.[name]) seen[name] = old.seen[name];
      errors[name] = {
        message:
          e.name === 'TimeoutError'
            ? "the calendar's server did not answer"
            : e.message === 'fetch failed'
              ? "the calendar's server could not be reached"
              : e.message,
        since: old.errors?.[name]?.since ?? Math.floor(Date.now() / 1000),
      };
      events.push(...old.events.filter((ev) => ev.cal === name));
    }
  }
  events.sort((a, b) => a.start - b.start);
  const next = { syncedAt: Math.floor(Date.now() / 1000), events, errors, seen };
  ctx.store.set('events', next);
  return { ...next, read };
}

// Events that touch the days from `first` to `last` (YYYY-MM-DD, inclusive).
const between = (events, first, last, cal) => events.filter((e) => e.lastDay >= first && e.day <= last && (!cal || e.cal === cal));
// Who it is from when somebody else organised it; otherwise who else is in it, if anyone.
const who = (e) =>
  e.from
    ? ` · from ${personLabel(e.from)}`
    : e.with?.length
      ? ` · with ${e.with.slice(0, 3).join(', ')}${e.with.length + (e.others ?? 0) > 3 ? ` and ${e.with.length + (e.others ?? 0) - 3} more` : ''}`
      : '';
// An event as it is handed on: with a name for whoever it is from, when the invitation gave
// only an address and a name is known for it (from the owner's mail, say).
const named = (e) => (e.from && !e.from.name && nameOf(e.from.email) ? { ...e, from: { ...e.from, name: nameOf(e.from.email) } } : e);
// And with its calendar called by the name it goes by now.
const shown = (ctx, e) => ({ ...named(e), cal: label(ctx, e.cal) });
const line = (ctx, e, many) =>
  `${e.allDay ? 'all day' : `${hm(e.start)}–${hm(e.end)}`}  ${e.title}${who(e)}${e.location ? ` · ${e.location}` : ''}${many ? ` [${label(ctx, e.cal)}]` : ''}`;

function agenda(ctx, first, last, cal) {
  const c = cache(ctx);
  const many = Object.keys(cals(ctx)).length > 1;
  const rows = between(c.events, first, last, cal);
  const out = [];
  for (let ms = new Date(`${first}T12:00:00`).getTime(); ymd(ms) <= last; ms += 86400000) {
    const day = ymd(ms);
    const todays = rows.filter((e) => e.day <= day && e.lastDay >= day).sort((a, b) => b.allDay - a.allDay || a.start - b.start);
    if (!todays.length) continue;
    out.push(
      `${dayLabel(day)}${dayLabel(day).startsWith('To') ? `, ${new Date(ms).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}` : ''}`,
      ...todays.map((e) => `  ${line(ctx, e, many)}`),
    );
  }
  return { text: out.join('\n'), events: rows.map((e) => shown(ctx, e)), syncedAt: c.syncedAt };
}

const need = (ctx) => {
  if (!Object.keys(cals(ctx)).length) ctx.fail('No calendar is connected yet. Connect one: bc calendar add');
};
const stale = (c) =>
  c.syncedAt && Date.now() / 1000 - c.syncedAt > 3 * 3600 ? `\n(last fetched ${ago(c.syncedAt)}; fetch now with: bc calendar sync)` : '';

export default {
  api: 1,
  name: 'calendar',
  title: 'Calendar',
  description:
    'reads your calendars (Google, iCloud, Outlook…) through their private iCal address: what is on, in the briefing and when you ask',
  help: `Examples:
  bc calendar add                    # connect a calendar (asks for a name and its address)
  bc calendar today
  bc calendar agenda --days 14
  bc calendar agenda --from 2026-12-20 --days 10 --calendar family
  bc calendar find dentist
  bc calendar sync                   # fetch now (it is fetched every 30 minutes anyway)

Read-only: the iCal address of a calendar cannot be used to change it.`,

  commands: {
    add: {
      summary: 'connect a calendar by its private iCal address',
      access: 'owner',
      working: 'Fetching the calendar…',
      form: [
        {
          type: 'note',
          message:
            'You need the calendar\'s private address in iCal format. Google Calendar: Settings → click the calendar → "Secret address in iCal format". iCloud: share the calendar as "Public Calendar" and copy the link. Outlook: Settings → Calendar → Shared calendars → Publish → the ICS link. Anyone with this address can read the calendar, so it is stored as a secret and never shown.',
        },
        ...accountNameQuestions({
          what: 'calendar',
          message: 'A short name for it (personal, family, work)',
          rule: NAME,
          ruleText: RULE_TEXT,
          all: cals,
          describe: (c) => c.title,
        }),
        {
          id: 'url',
          type: 'secret',
          message: "The calendar's iCal address",
          validate: (v) => (/^(https|webcal):\/\/\S+$/i.test(String(v).trim()) ? undefined : 'It starts with https:// or webcal://'),
        },
      ],
      run: async (ctx, a) => {
        const { name, key, replacing } = chosenAccountName(cals(ctx), a, ctx.fail);
        const before = replacing ? cals(ctx)[key] : null;
        const url = String(a.url).trim();
        let text;
        try {
          text = await fetchFeed(url);
        } catch (e) {
          ctx.fail(`Could not read that calendar: ${e.message === 'fetch failed' ? 'its server could not be reached' : e.message}.`);
        }
        const { calendarName, readCalendar } = await ics();
        const found = readCalendar(text, key, Date.now(), Date.now() + 30 * 86400000);
        ctx.secrets.set(`url:${key}`, url);
        const cal = { title: calendarName(text) ?? name, added: Math.floor(Date.now() / 1000) };
        ctx.config.set({ calendars: { ...cals(ctx), [key]: key === name ? cal : { ...cal, name } } });
        // Read in full: a calendar that replaces another must not keep the other's events.
        await sync(ctx, { full: replacing });
        return `${replacing ? `Replaced "${before.title}" with` : 'Connected'} "${calendarName(text) ?? name}" as ${name}: ${plural(found.length, 'event')} in the next 30 days.\nIt is fetched every 30 minutes, and the coming week's events appear in your daily briefing on their day.\nTry: bc calendar today`;
      },
    },

    remove: {
      summary: 'disconnect a calendar',
      access: 'ask',
      usage: '<name>',
      run: async (ctx, i) => {
        const all = { ...cals(ctx) };
        const key = keyFor(ctx, i.name);
        delete all[key];
        ctx.config.set({ calendars: all });
        ctx.secrets.delete(`url:${key}`);
        await sync(ctx);
        return `Disconnected ${i.name}. Its address is forgotten.`;
      },
    },

    rename: {
      summary: 'give a calendar another name',
      access: 'owner',
      usage: '<name> <newName>',
      run: async (ctx, i) => {
        const { key, all } = renameAccount(cals(ctx), i.name, i.newName, {
          what: 'calendar',
          rule: NAME,
          ruleText: `A name is ${RULE_TEXT.toLowerCase()}`,
          fail: ctx.fail,
        });
        ctx.config.set({ calendars: all });
        const old = await mentioning(new RegExp(`--calendar[ =]['"]?${i.name}\\b`));
        return [
          `"${i.name}" is now called "${label(ctx, key)}".`,
          ...(old.length ? [`These still say "${i.name}"; change them:`, ...old.map((o) => `  ${o}`)] : []),
        ].join('\n');
      },
    },

    list: {
      summary: 'the calendars that are connected',
      access: 'allow',
      untrusted: false,
      run: (ctx) => {
        const c = cache(ctx);
        const names = Object.entries(cals(ctx));
        return {
          text: names.length
            ? names
                .map(
                  ([n, v]) =>
                    `${label(ctx, n)}: ${v.title} · ${plural(c.events.filter((e) => e.cal === n).length, 'event')}${c.errors?.[n] ? ` · NOT UPDATING since ${ago(c.errors[n].since)}: ${c.errors[n].message}` : ''}`,
                )
                .join('\n')
            : 'No calendar is connected yet. Connect one: bc calendar add',
          data: { calendars: Object.fromEntries(names.map(([n, v]) => [label(ctx, n), { ...v, error: c.errors?.[n] ?? null }])) },
        };
      },
    },

    today: {
      summary: 'what is on today and tomorrow',
      access: 'allow',
      run: (ctx) => {
        need(ctx);
        const a = agenda(ctx, ymd(Date.now()), ymd(Date.now() + 86400000));
        return {
          text: (a.text || 'Nothing in your calendar today or tomorrow.') + stale(a),
          data: { events: a.events, syncedAt: a.syncedAt },
        };
      },
    },

    agenda: {
      summary: 'what is coming up',
      access: 'allow',
      options: [
        ['--days <n>', 'how many days', '7'],
        ['--from <date>', 'the first day, YYYY-MM-DD (today if left out)'],
        ['--calendar <name>', 'only this calendar'],
      ],
      run: (ctx, i) => {
        need(ctx);
        const days = Number(i.days);
        if (!Number.isInteger(days) || days < 1 || days > 366) ctx.fail('--days is a number from 1 to 366.');
        if (i.from && !/^\d{4}-\d{2}-\d{2}$/.test(i.from)) ctx.fail('--from is a date like 2026-12-20.');
        const cal = i.calendar ? keyFor(ctx, i.calendar) : null;
        const first = i.from ?? ymd(Date.now());
        const last = ymd(new Date(`${first}T12:00:00`).getTime() + (days - 1) * 86400000);
        const a = agenda(ctx, first, last, cal);
        const beyond =
          last > ymd(Date.now() + AHEAD_DAYS * 86400000)
            ? `\n(Only the next ${AHEAD_DAYS} days are kept, so later days may be incomplete.)`
            : '';
        return {
          text: (a.text || `Nothing in your calendar from ${first} to ${last}.`) + stale(a) + beyond,
          data: { from: first, to: last, events: a.events, syncedAt: a.syncedAt },
        };
      },
    },

    find: {
      summary: 'search events by words in the title, place or notes, or by who is in them',
      access: 'allow',
      usage: '<text...>',
      run: (ctx, i) => {
        need(ctx);
        const words = i.text.join(' ').toLowerCase().split(/\s+/).filter(Boolean);
        const many = Object.keys(cals(ctx)).length > 1;
        const hits = cache(ctx).events.filter((e) =>
          words.every((w) =>
            `${e.title} ${e.location ?? ''} ${e.notes ?? ''} ${e.from?.name ?? ''} ${e.from?.email ?? ''} ${(e.with ?? []).join(' ')}`
              .toLowerCase()
              .includes(w),
          ),
        );
        // A repeating event shows its next few times, not all of them.
        const seen = new Map();
        const rows = hits
          .filter((e) => e.end >= Date.now() / 1000 - 86400)
          .filter((e) => {
            const n = (seen.get(e.uid) ?? 0) + 1;
            seen.set(e.uid, n);
            return n <= 3;
          })
          .slice(0, 30);
        return {
          text: rows.length
            ? rows.map((e) => `${dayLabel(e.day)}  ${line(ctx, e, many)}`).join('\n')
            : `Nothing in your calendar matches "${i.text.join(' ')}" (from a week ago to ${AHEAD_DAYS} days ahead).`,
          data: { events: rows.map((e) => shown(ctx, e)) },
        };
      },
    },

    sync: {
      changes: true,
      summary: 'fetch the calendars now',
      access: 'allow',
      untrusted: false,
      run: async (ctx) => {
        need(ctx);
        const c = await sync(ctx, { full: true }); // asked for by hand: read everything again
        const bad = Object.entries(c.errors);
        return {
          text: [
            `Fetched: ${plural(c.events.length, 'event')} from a week ago to ${AHEAD_DAYS} days ahead.`,
            ...bad.map(([n, e]) => `${n} could not be fetched: ${e.message}. Its earlier events are kept.`),
          ].join('\n'),
          data: { events: c.events.length, errors: c.errors },
        };
      },
    },
  },

  jobs: [
    {
      id: 'sync',
      cron: '*/30 * * * *',
      summary: 'fetch the calendars',
      when: (ctx) => Object.keys(cals(ctx)).length > 0,
      run: async (ctx) => {
        const before = cache(ctx).errors ?? {};
        const c = await sync(ctx);
        // Say so once when a calendar has not updated for a day (its secret address was reset, usually).
        for (const [n, e] of Object.entries(c.errors)) {
          const day = 86400;
          const was = before[n] ? Math.floor((c.syncedAt - before[n].since) / day) : 0;
          if (Math.floor((c.syncedAt - e.since) / day) >= 1 && was < 1)
            await ctx.notify(
              `📅 Your "${n}" calendar has not updated for a day: ${e.message}. I am still showing what I had. Reconnect it with /setup or bc calendar add.`,
            );
        }
        const failed = Object.keys(c.errors);
        if (!c.read.length && !failed.length) return { idle: true };
        return {
          did: [
            c.read.length ? `read again: ${c.read.join(', ')}` : null,
            failed.length ? `could not be fetched: ${failed.join(', ')}` : null,
          ]
            .filter(Boolean)
            .join(' · '),
        };
      },
    },
  ],

  // Dated things for "Things I need to do": the events between two moments, as they are.
  agenda: (ctx, { from, to }) => {
    if (!Object.keys(cals(ctx)).length) return [];
    return between(cache(ctx).events, ymd(from), ymd(to)).map((e) => ({
      id: e.uid,
      source: e.cal,
      sourceName: label(ctx, e.cal),
      title: e.title,
      start: e.start,
      end: e.end,
      allDay: e.allDay,
      day: e.day,
      lastDay: e.lastDay,
      location: e.location,
      from: e.from ? personLabel(e.from) : null,
    }));
  },

  // `bc selftest`: every calendar, its address fetched and read as a calendar. Nothing is kept.
  selftest: (ctx) =>
    Object.entries(cals(ctx)).map(([name, c]) => ({
      name: c.title && c.title !== label(ctx, name) ? `${label(ctx, name)} (${c.title})` : label(ctx, name),
      run: async () => {
        const url = ctx.secrets.get(`url:${name}`);
        if (!url) throw new Error('its address is not saved (connect it again: bc calendar add)');
        const text = await fetchFeed(url);
        if (!/BEGIN:VCALENDAR/.test(text)) throw new Error('what its address gives is not a calendar');
        return `reachable · ${plural((text.match(/BEGIN:VEVENT/g) ?? []).length, 'event')} in it`;
      },
    })),

  status: (ctx) => {
    const n = Object.keys(cals(ctx)).length;
    if (!n) return 'no calendar connected (bc calendar add)';
    const c = cache(ctx);
    const soon = between(c.events, ymd(Date.now()), ymd(Date.now() + 7 * 86400000)).length;
    const bad = Object.keys(c.errors ?? {});
    return `${plural(n, 'calendar')} · ${plural(soon, 'event')} in the next 7 days · ${c.syncedAt ? `fetched ${ago(c.syncedAt)}` : 'not fetched yet'}${bad.length ? ` · NOT UPDATING: ${bad.map((n) => label(ctx, n)).join(', ')}` : ''}`;
  },
  settings: (ctx) => ({
    ...Object.fromEntries(Object.entries(cals(ctx)).map(([n, v]) => [label(ctx, n), v.title])),
    fetched: `every ${SYNC_EVERY}`,
    keeps: `a week back and ${AHEAD_DAYS} days ahead`,
  }),

  // For `bc engine check`: what the owner might say, and the command it should lead to.
  checks: (ctx) => (Object.keys(cals(ctx)).length ? [{ say: 'whats on my calendar this week', expect: /blackcat calendar agenda\b/ }] : []),
  agent: {
    fill: (ctx) => ({
      ready: Object.keys(cals(ctx)).length > 0,
      calendars: Object.keys(cals(ctx))
        .map((n) => label(ctx, n))
        .join(', '),
      days: AHEAD_DAYS,
    }),
  },
};
