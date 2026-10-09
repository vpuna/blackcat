// UniFi: the state of your network and cameras, read from a UniFi console (Dream Router,
// Cloud Gateway…) through its official APIs. Looking is free for the agent; the two
// actions (restart a device, power-cycle a port) need your approval.
import fs from 'node:fs';
import path from 'node:path';
import { bytes, events, usage } from './insight.js';
import { UnifiError, client, fingerprint } from './api.js';
import { dataPath, parseDuration } from '../../src/api.js';

// Camera snapshots are saved here: the one folder of this plugin the agent may read.
const MEDIA = dataPath('unifi-media');

const settings = (ctx) => ctx.config.get();
const api = (ctx) => client({ host: settings(ctx).host, key: ctx.secrets.get('key'), pin: settings(ctx).pin });
// Turn API problems into a message for the person, not a stack trace.
const run = (fn) => async (ctx, input) => {
  try {
    return await fn(ctx, input ?? {});
  } catch (e) {
    if (e instanceof UnifiError) ctx.fail(e.message);
    throw e;
  }
};

async function siteId(ctx, u) {
  const saved = settings(ctx).siteId;
  if (saved) return saved;
  const sites = await u.list('network', '/sites');
  if (!sites.length) ctx.fail('The console reports no sites.');
  ctx.config.set({ siteId: sites[0].id, siteName: sites[0].name ?? null });
  return sites[0].id;
}

// --since 6h or 3d (--hours 6 and --days 3 are the older way to say it), or (for usage) today since midnight.
function period(ctx, i, fallback) {
  const to = Date.now();
  const num = (v, max, what) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0 || n > max) ctx.fail(`${what} is a number from 1 to ${max}.`);
    return n;
  };
  // --since 6h, 3d: the same way a period is given everywhere else in blackcat.
  if (i.since) {
    if (i.hours || i.days) ctx.fail('Give --since, or --hours, or --days: one of them.');
    let secs;
    try {
      secs = parseDuration(i.since);
    } catch (e) {
      ctx.fail(e.message);
    }
    if (secs < 3600 || secs > 90 * 86400) ctx.fail('--since is from 1h to 90d.');
    return { from: to - secs * 1000, to, text: `in the last ${i.since}` };
  }
  if (i.hours && i.days) ctx.fail('Give --hours or --days, not both.');
  if (i.days)
    return { from: to - num(i.days, 90, '--days') * 86400_000, to, text: `in the last ${i.days} day${Number(i.days) === 1 ? '' : 's'}` };
  if (i.hours || fallback === 'hours') {
    const h = num(i.hours ?? 24, 72, '--hours');
    return { from: to - h * 3600_000, to, text: `in the last ${h} hour${h === 1 ? '' : 's'}` };
  }
  return { from: new Date().setHours(0, 0, 0, 0), to, text: 'today (since midnight)' };
}

const online = (d) => /^(online|connected)$/i.test(String(d.state ?? ''));
const words = (v) => (Array.isArray(v) ? v.join(' ') : String(v ?? '')).trim();

// Find one thing by id, MAC, exact name, or an unambiguous part of the name.
function pick(ctx, rows, ref, what) {
  const q = words(ref).toLowerCase();
  if (!q) ctx.fail(`Which ${what}?`);
  const name = (r) => String(r.name ?? r.hostname ?? '').toLowerCase();
  const exact = rows.filter(
    (r) => r.id === q || String(r.macAddress ?? r.mac ?? '').toLowerCase() === q || name(r) === q || String(r.ipAddress ?? '') === q,
  );
  const hits = exact.length ? exact : rows.filter((r) => name(r).includes(q));
  if (hits.length === 1) return hits[0];
  ctx.fail(
    hits.length
      ? `"${words(ref)}" matches ${hits.length} ${what}s: ${hits
          .slice(0, 8)
          .map((r) => r.name ?? r.id)
          .join(', ')}. Be more specific.`
      : `No ${what} matches "${words(ref)}".`,
  );
}

const deviceLine = (d) =>
  `${online(d) ? '●' : '○'} ${d.name ?? d.model ?? d.id}${d.model && d.name ? ` (${d.model})` : ''}${d.ipAddress ? ` · ${d.ipAddress}` : ''} · ${String(d.state ?? 'unknown').toLowerCase()}${d.firmwareUpdatable ? ' · update available' : ''}`;
const clientLine = (c, devices) => {
  const up = devices?.get(c.uplinkDeviceId);
  return `${c.name ?? c.hostname ?? c.macAddress ?? c.id}${c.ipAddress ? ` · ${c.ipAddress}` : ''} · ${String(c.type ?? '').toLowerCase() || 'unknown'}${up ? ` · via ${up.name ?? up.model}` : ''}`;
};

async function overview(ctx) {
  const u = api(ctx);
  const site = await siteId(ctx, u);
  const [devices, clients] = await Promise.all([u.list('network', `/sites/${site}/devices`), u.list('network', `/sites/${site}/clients`)]);
  const cameras = await u.list('protect', '/cameras').catch(() => null); // Protect may not be installed
  return {
    devices,
    clients,
    cameras,
    offline: devices.filter((d) => !online(d)),
    camerasOffline: (cameras ?? []).filter((c) => !online(c)),
  };
}

export default {
  api: 1,
  name: 'unifi',
  title: 'UniFi',
  description:
    'your UniFi network and cameras: what is online, who is connected, who used the most data, what the console logged, camera snapshots',
  help: `Setup:
  bc unifi setup      the console's address and an API key (Network → Settings → Control Plane → Integrations)

Examples:
  bc unifi status
  bc unifi clients --match iphone
  bc unifi device "U7 Pro"
  bc unifi snapshot "AI Theta"
  bc unifi get network /sites
  bc unifi check                 exits with an error if anything is offline (for: bc check add … --run 'blackcat unifi check')`,

  commands: {
    setup: {
      summary: 'connect to your UniFi console',
      access: 'owner',
      form: [
        {
          type: 'note',
          message:
            'You need an API key from the console itself: open it in a browser, then Network → Settings → Control Plane → Integrations → Create API Key.',
        },
        {
          id: 'host',
          type: 'text',
          message: "The console's address (IP or hostname)",
          default: (_a, ctx) => ctx.config.get().host,
          validate: (v) =>
            /^[a-z0-9.-]+(:\d+)?$/i.test(
              String(v)
                .replace(/^https?:\/\//, '')
                .replace(/\/.*$/, ''),
            )
              ? undefined
              : 'Just the address, e.g. 192.168.1.1',
        },
        { id: 'key', type: 'secret', message: 'The API key', keep: true },
      ],
      run: run(async (ctx, a) => {
        const host = String(a.host)
          .replace(/^https?:\/\//, '')
          .replace(/\/.*$/, '');
        const key = a.key || ctx.secrets.get('key'); // left empty: the one that is saved
        const pin = await fingerprint(host);
        const u = client({ host, key, pin });
        const info = await u.get('network', '/info');
        const sites = await u.list('network', '/sites');
        // Only now, having seen the key work, is anything saved.
        ctx.secrets.set('key', key);
        ctx.config.set({
          host,
          pin,
          siteId: sites[0]?.id ?? null,
          siteName: sites[0]?.name ?? null,
          network: info?.applicationVersion ?? null,
        });
        const protect = await client({ host, key, pin })
          .get('protect', '/meta/info')
          .then((p) => p?.applicationVersion ?? 'yes')
          .catch((e) => (e.status === 401 || e.status === 403 ? 'refused' : null));
        ctx.config.set({ protect });
        return [
          `Connected to ${host}: UniFi Network ${info?.applicationVersion ?? '(version unknown)'}${sites[0]?.name ? `, site "${sites[0].name}"` : ''}.`,
          protect === 'refused'
            ? 'Protect refused this key. If you want camera snapshots, create an API key inside the Protect application and run setup again with it.'
            : protect
              ? `Protect ${protect === 'yes' ? '' : `${protect} `}is available: camera snapshots will work.`
              : 'Protect was not found on this console, so there are no cameras.',
          `I will only talk to this console while its certificate stays the same (${pin.slice(0, 23)}…).`,
          'Try: bc unifi status',
        ].join('\n');
      }),
    },

    status: {
      summary: 'is everything online: devices, cameras, how many clients',
      access: 'allow',
      run: run(async (ctx) => {
        const o = await overview(ctx);
        const wireless = o.clients.filter((c) => /wireless/i.test(c.type ?? '')).length;
        const head = `${o.devices.length - o.offline.length}/${o.devices.length} devices online · ${o.clients.length} clients (${wireless} on Wi-Fi)${o.cameras ? ` · ${o.cameras.length - o.camerasOffline.length}/${o.cameras.length} cameras connected` : ''}`;
        return {
          text: [
            head,
            ...o.devices.map(deviceLine),
            ...(o.cameras ?? []).map(
              (c) => `${online(c) ? '●' : '○'} camera ${c.name ?? c.id} · ${String(c.state ?? 'unknown').toLowerCase()}`,
            ),
          ].join('\n'),
          data: {
            summary: head,
            allOnline: !o.offline.length && !o.camerasOffline.length,
            devices: o.devices.map((d) => ({
              id: d.id,
              name: d.name,
              model: d.model,
              ip: d.ipAddress,
              state: d.state,
              updateAvailable: d.firmwareUpdatable ?? null,
            })),
            cameras: (o.cameras ?? []).map((c) => ({ id: c.id, name: c.name, state: c.state })),
            clients: { total: o.clients.length, wireless },
          },
        };
      }),
    },

    check: {
      summary: 'succeed only if every device and camera is online (made for checks)',
      access: 'allow',
      run: run(async (ctx) => {
        const o = await overview(ctx);
        const down = [...o.offline.map((d) => d.name ?? d.model ?? d.id), ...o.camerasOffline.map((c) => `camera ${c.name ?? c.id}`)];
        if (down.length) ctx.fail(`offline: ${down.join(', ')}`);
        return `all ${o.devices.length} devices${o.cameras ? ` and ${o.cameras.length} cameras` : ''} online`;
      }),
    },

    devices: {
      summary: 'your UniFi devices: router, switches, access points',
      access: 'allow',
      run: run(async (ctx) => {
        const u = api(ctx);
        const devices = await u.list('network', `/sites/${await siteId(ctx, u)}/devices`);
        return { text: devices.map(deviceLine).join('\n') || 'No devices.', data: { devices } };
      }),
    },

    device: {
      summary: 'one device in detail, with its current statistics (load, uptime, uplink, radios, ports)',
      access: 'allow',
      usage: '<name...>',
      run: run(async (ctx, i) => {
        const u = api(ctx);
        const site = await siteId(ctx, u);
        const d = pick(ctx, await u.list('network', `/sites/${site}/devices`), i.name, 'device');
        const [details, statistics] = await Promise.all([
          u.get('network', `/sites/${site}/devices/${d.id}`),
          u
            .get('network', `/sites/${site}/devices/${d.id}/statistics/latest`)
            .catch(() => u.get('network', `/sites/${site}/devices/${d.id}/statistics`))
            .catch(() => null),
        ]);
        const s = statistics ?? {};
        const dd = details ?? d;
        const rate = (bps) => (bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} Mbit/s` : `${Math.round(bps / 1e3)} kbit/s`);
        const days = (sec) =>
          sec >= 86400 ? `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h` : `${Math.floor(sec / 3600)}h`;
        const lines = [
          deviceLine(dd),
          [
            s.uptimeSec != null ? `up ${days(s.uptimeSec)}` : null,
            s.cpuUtilizationPct != null ? `cpu ${Math.round(s.cpuUtilizationPct)}%` : null,
            s.memoryUtilizationPct != null ? `memory ${Math.round(s.memoryUtilizationPct)}%` : null,
            s.loadAverage1Min != null ? `load ${s.loadAverage1Min}` : null,
          ]
            .filter(Boolean)
            .join(' · '),
          dd.firmwareVersion ? `firmware ${dd.firmwareVersion}${dd.firmwareUpdatable ? ' (update available)' : ''}` : null,
          s.uplink ? `uplink: ${rate(s.uplink.txRateBps ?? 0)} up, ${rate(s.uplink.rxRateBps ?? 0)} down` : null,
          s.interfaces?.radios?.length
            ? `radios: ${s.interfaces.radios.map((r) => `${r.frequencyGHz} GHz ${r.txRetriesPct ?? 0}% retries`).join(' · ')}`
            : null,
          dd.interfaces?.ports?.length
            ? `ports: ${dd.interfaces.ports.filter((p) => /^up$/i.test(p.state ?? '')).length}/${dd.interfaces.ports.length} up`
            : null,
        ].filter(Boolean);
        const bits = [lines.join('\n')];
        return { text: bits[0], data: { device: dd, statistics } };
      }),
    },

    clients: {
      summary: 'what is connected to the network right now',
      access: 'allow',
      options: [
        ['--match <text>', 'only clients whose name, address or MAC contains this'],
        ['--type <type>', 'wired, wireless or vpn'],
        ['-n, --limit <n>', 'how many to show', '60'],
      ],
      run: run(async (ctx, i) => {
        const u = api(ctx);
        const site = await siteId(ctx, u);
        const [all, devs] = await Promise.all([u.list('network', `/sites/${site}/clients`), u.list('network', `/sites/${site}/devices`)]);
        const devices = new Map(devs.map((d) => [d.id, d]));
        const q = String(i.match ?? '').toLowerCase();
        const rows = all.filter(
          (c) =>
            (!q ||
              [c.name, c.hostname, c.ipAddress, c.macAddress].some((v) =>
                String(v ?? '')
                  .toLowerCase()
                  .includes(q),
              )) &&
            (!i.type || String(c.type ?? '').toLowerCase() === String(i.type).toLowerCase()),
        );
        const shown = rows.slice(0, Number(i.limit) || 60);
        return {
          text: [
            `${rows.length} client${rows.length === 1 ? '' : 's'}${rows.length < all.length ? ` of ${all.length}` : ''}`,
            ...shown.map((c) => clientLine(c, devices)),
            ...(rows.length > shown.length ? [`…and ${rows.length - shown.length} more (--limit, --match)`] : []),
          ].join('\n'),
          data: {
            total: all.length,
            matching: rows.length,
            clients: shown.map((c) => ({ ...c, via: devices.get(c.uplinkDeviceId)?.name ?? null })),
          },
        };
      }),
    },

    client: {
      summary: 'one connected client in detail',
      access: 'allow',
      usage: '<name...>',
      run: run(async (ctx, i) => {
        const u = api(ctx);
        const site = await siteId(ctx, u);
        const c = pick(ctx, await u.list('network', `/sites/${site}/clients`), i.name, 'client');
        const details = await u.get('network', `/sites/${site}/clients/${c.id}`).catch(() => c);
        return { text: clientLine(details), data: { client: details } };
      }),
    },

    usage: {
      summary: 'who used the most data: today, or over the last hours or days; name a client for its hours and apps',
      access: 'allow',
      usage: '[client...]',
      options: [
        ['--since <when>', 'how far back: 6h, 24h, 7d (instead of today)'],
        ['--hours <n>', 'the same, in hours'],
        ['--days <n>', 'the same, in days'],
        ['-n, --limit <n>', 'how many clients to show', '10'],
      ],
      run: run(async (ctx, i) => {
        const p = period(ctx, i, 'today');
        const r = await usage(api(ctx), settings(ctx).siteName, p.from, p.to);
        const byNet = (a, b) => (b.internet ?? 0) - (a.internet ?? 0) || b.total - a.total;
        const all = r.clients.filter((c) => c.total || c.internet);
        const ref = words(i.client).toLowerCase();
        if (ref) {
          const hits = all.filter((c) =>
            [c.name, c.mac, c.ip].some((v) =>
              String(v ?? '')
                .toLowerCase()
                .includes(ref),
            ),
          );
          const c = hits.find((x) => x.name.toLowerCase() === ref) ?? (hits.length === 1 ? hits[0] : null);
          if (!c)
            ctx.fail(
              hits.length
                ? `"${words(i.client)}" matches ${hits.length} clients: ${hits
                    .slice(0, 8)
                    .map((x) => x.name)
                    .join(', ')}. Use the full name.`
                : `No client matching "${words(i.client)}" moved any data ${p.text}.`,
            );
          const busiest = [...c.hours]
            .sort((a, b) => b.bytes - a.bytes)
            .slice(0, 5)
            .filter((h) => h.bytes);
          const clock = (t) =>
            new Date(t).toLocaleString(
              'en-GB',
              r.kind === 'hourly'
                ? { weekday: 'short', hour: '2-digit', minute: '2-digit' }
                : { weekday: 'short', day: 'numeric', month: 'short' },
            );
          return {
            text: [
              `${c.name}${c.ip ? ` (${c.ip})` : ''}, ${p.text}`,
              `  internet: ${c.internet == null ? 'not known' : bytes(c.internet)}   ·   all traffic, including inside your home: ${bytes(c.total)}`,
              ...(c.internet ? [`  of the internet traffic: ${bytes(c.down)} down, ${bytes(c.up)} up`] : []),
              ...(c.apps.length
                ? [
                    '  on the internet, by kind of traffic:',
                    ...c.apps.slice(0, 8).map((a) => `    ${bytes(a.bytes).padStart(8)}  ${a.kind}`),
                  ]
                : []),
              ...(busiest.length
                ? [
                    `  busiest ${r.kind === 'hourly' ? 'hours' : 'days'} (all traffic):`,
                    ...busiest.map((h) => `    ${bytes(h.bytes).padStart(8)}  ${clock(h.time)}`),
                  ]
                : []),
            ].join('\n'),
            data: { period: p.text, client: { ...c, apps: c.apps.slice(0, 20) } },
          };
        }
        const n = Math.min(Number(i.limit) || 10, 50);
        const top = [...all].sort(r.hasInternet ? byNet : (a, b) => b.total - a.total).slice(0, n);
        const sum = (k) => all.reduce((t, c) => t + (c[k] ?? 0), 0);
        return {
          text: [
            `Data used ${p.text}${r.hasInternet ? `: ${bytes(sum('internet'))} to and from the internet` : ''}`,
            `${'internet'.padStart(10)}  ${'all traffic'.padStart(11)}  client`,
            ...top.map(
              (c) =>
                `${(c.internet == null ? '?' : bytes(c.internet)).padStart(10)}  ${bytes(c.total).padStart(11)}  ${c.name}${c.apps[0] ? `  · mostly ${c.apps[0].kind}` : ''}`,
            ),
            '"all traffic" comes from a different report of the console: it also counts traffic between machines at home (a copy to a server, cameras), so it can be far larger than "internet", and for some Wi-Fi clients it is incomplete.',
            'One client in detail: bc unifi usage <name>',
          ].join('\n'),
          data: {
            period: p.text,
            internetTotal: r.hasInternet ? sum('internet') : null,
            clients: top.map((c) => ({
              name: c.name,
              mac: c.mac,
              ip: c.ip,
              wired: c.wired,
              internetBytes: c.internet,
              internet: c.internet == null ? null : bytes(c.internet),
              allBytes: c.total,
              all: bytes(c.total),
              down: c.internet == null ? null : bytes(c.down),
              up: c.internet == null ? null : bytes(c.up),
              mostly: c.apps.slice(0, 3).map((a) => `${a.kind} ${bytes(a.bytes)}`),
            })),
          },
        };
      }),
    },

    events: {
      summary: 'what the console logged: anything out of the ordinary, clients that keep dropping, and new devices',
      access: 'allow',
      options: [
        ['--since <when>', 'how far back: 6h, 24h, 7d (default 24h)'],
        ['--hours <n>', 'the same, in hours'],
        ['--days <n>', 'the same, in days'],
      ],
      run: run(async (ctx, i) => {
        const p = period(ctx, i, 'hours');
        const r = await events(api(ctx), settings(ctx).siteName, p.from, p.to);
        const at = (t) => new Date(t).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
        // A client that left the Wi-Fi this often did not do so on purpose.
        const hours = (p.to - p.from) / 3600_000;
        const flappy = r.clients.filter((c) => c.left >= Math.max(6, hours / 4));
        const quiet = !r.notable.length && !flappy.length && !r.fresh.length;
        // Sign-ins to the console, grouped: who, from which address, how often.
        const visits = new Map();
        for (const a of r.admin) {
          const k = `${a.who} from ${a.ip ?? 'an unknown address'}${a.how ? ` (${a.how})` : ''}`;
          const v = visits.get(k) ?? visits.set(k, { who: a.who, ip: a.ip, how: a.how, times: 0, last: 0, label: k }).get(k);
          v.times++;
          v.last = Math.max(v.last, a.time);
        }
        const guard = r.protection;
        return {
          text: [
            `The console logged ${r.total} thing${r.total === 1 ? '' : 's'} ${p.text}.${quiet ? ' Nothing out of the ordinary: only clients joining and leaving the Wi-Fi.' : ''}`,
            ...(r.notable.length
              ? [
                  '',
                  `Not routine (${r.notableTotal}):`,
                  ...r.notable
                    .slice(0, 40)
                    .map(
                      (e) =>
                        `  ${at(e.time)}  [${e.category}${e.severity && e.severity !== 'LOW' ? `, ${e.severity.toLowerCase()}` : ''}] ${e.text}`,
                    ),
                ]
              : ['', 'Security, internet, UniFi devices, power, VPN, updates, admin activity: nothing logged.']),
            ...(guard && !guard.intrusion
              ? [
                  '',
                  "Threat detection (UniFi's Intrusion Prevention) is switched off on this console, so attacks and blocked connections are not looked for or logged. It is turned on in the UniFi app under Settings → Security.",
                ]
              : guard?.intrusion
                ? ['', `Threat detection is on (${guard.intrusion}).`]
                : []),
            ...(visits.size
              ? [
                  '',
                  "The console's own pages were opened:",
                  ...[...visits.values()].map((v) => `  ${v.label}: ${v.times} time${v.times === 1 ? '' : 's'}, last ${at(v.last)}`),
                ]
              : ['', "Nobody opened the console's own pages."]),
            ...(flappy.length
              ? [
                  '',
                  'Keep dropping off the Wi-Fi:',
                  ...flappy
                    .slice(0, 10)
                    .map(
                      (c) =>
                        `  ${c.name}: left ${c.left} times, joined ${c.joined}${c.via ? ` · last on ${c.via}` : ''}${c.signal ? ` at ${c.signal} dBm` : ''}`,
                    ),
                ]
              : []),
            ...(r.fresh.length
              ? [
                  '',
                  'Seen for the first time:',
                  ...r.fresh
                    .slice(0, 15)
                    .map(
                      (c) =>
                        `  ${c.name}${c.ip ? ` (${c.ip})` : ''} · ${c.wired ? 'wired' : 'Wi-Fi'} · first seen ${at(c.firstSeen * 1000)}${c.connected ? ' · connected now' : ''}`,
                    ),
                ]
              : ['', 'No device was seen for the first time.']),
            ...(r.truncated ? ['', '(There were more joins and leaves than were read; the counts per client are a lower bound.)'] : []),
          ].join('\n'),
          data: {
            period: p.text,
            threatDetection: guard
              ? guard.intrusion
                ? `on (${guard.intrusion})`
                : 'off: nothing is looked for, so an empty security log proves nothing'
              : 'unknown',
            consoleOpened: [...visits.values()].map(({ label, ...v }) => v),
            logged: r.total,
            notRoutine: r.notable.slice(0, 60),
            keepDropping: flappy.slice(0, 20),
            firstSeen: r.fresh,
            joinsAndLeaves: r.clients.slice(0, 25).map(({ mac, name, joined, left, roamed }) => ({ name, mac, joined, left, roamed })),
            truncated: r.truncated,
          },
        };
      }),
    },

    cameras: {
      summary: 'your UniFi Protect cameras and whether they are connected',
      access: 'allow',
      run: run(async (ctx) => {
        const cams = await api(ctx).list('protect', '/cameras');
        return {
          text:
            cams.map((c) => `${online(c) ? '●' : '○'} ${c.name ?? c.id} · ${String(c.state ?? 'unknown').toLowerCase()}`).join('\n') ||
            'No cameras.',
          data: { cameras: cams.map((c) => ({ id: c.id, name: c.name, state: c.state, model: c.modelKey ?? c.type ?? null })) },
        };
      }),
    },

    snapshot: {
      summary: 'take a picture from a camera now, and save it where the agent can look at it and send it',
      access: 'allow',
      sends: true, // typed in the chat (/unifi snapshot …), the picture itself is sent
      usage: '<camera...>',
      run: run(async (ctx, i) => {
        const u = api(ctx);
        const cam = pick(ctx, await u.list('protect', '/cameras'), i.camera, 'camera');
        const jpg = await u
          .image('protect', `/cameras/${cam.id}/snapshot?highQuality=true`)
          .catch(() => u.image('protect', `/cameras/${cam.id}/snapshot`));
        fs.mkdirSync(MEDIA, { recursive: true, mode: 0o700 });
        // One file per camera, replaced each time: snapshots don't pile up.
        const file = path.join(MEDIA, `${String(cam.name ?? cam.id).replace(/[^\w.-]+/g, '_')}.jpg`);
        fs.writeFileSync(file, jpg, { mode: 0o600 });
        return {
          text: `Saved ${file} (${Math.round(jpg.length / 1024)} KB)`,
          data: {
            camera: cam.name ?? cam.id,
            path: file,
            bytes: jpg.length,
            taken: new Date().toISOString(),
            caption: `${cam.name ?? 'Camera'}, just now`,
          },
        };
      }),
    },

    get: {
      summary: 'read anything else the official API offers: bc unifi get network|protect <path>',
      access: 'allow',
      usage: '<app> <path>',
      run: run(async (ctx, i) => {
        if (!['network', 'protect'].includes(i.app)) ctx.fail('The first word is network or protect.');
        // Reading only, and only inside the API: no way out of its base path.
        if (!/^\/[\w\-./?=&%:{}]*$/.test(i.path ?? '') || i.path.includes('..')) ctx.fail('Give an API path such as /sites or /cameras.');
        const u = api(ctx);
        const p = i.path.replace('{siteId}', await siteId(ctx, u));
        const out = await u.get(i.app, p);
        const text = JSON.stringify(out, null, 2);
        return {
          text: text.length > 20_000 ? `${text.slice(0, 20_000)}\n… (cut: ${text.length} characters)` : text,
          data: { path: p, result: text.length > 60_000 ? `(too large: ${text.length} characters; ask for something narrower)` : out },
        };
      }),
    },

    restart: {
      summary: 'restart a UniFi device',
      access: 'ask',
      usage: '<device...>',
      run: run(async (ctx, i) => {
        const u = api(ctx);
        const site = await siteId(ctx, u);
        const d = pick(ctx, await u.list('network', `/sites/${site}/devices`), i.device, 'device');
        await u.post('network', `/sites/${site}/devices/${d.id}/actions`, { action: 'RESTART' });
        return `Restart requested for ${d.name ?? d.id}. It will be offline for a few minutes.`;
      }),
    },

    'port-cycle': {
      summary: 'switch the power of one PoE port off and on again (restarts whatever it powers)',
      access: 'ask',
      usage: '<port> <device...>',
      run: run(async (ctx, i) => {
        if (!/^\d+$/.test(String(i.port))) ctx.fail('Give the port number first, then the device: bc unifi port-cycle 3 "USW Pro"');
        const u = api(ctx);
        const site = await siteId(ctx, u);
        const d = pick(ctx, await u.list('network', `/sites/${site}/devices`), i.device, 'device');
        await u.post('network', `/sites/${site}/devices/${d.id}/interfaces/ports/${i.port}/actions`, { action: 'POWER_CYCLE' });
        return `Power-cycled port ${i.port} on ${d.name ?? d.id}.`;
      }),
    },
  },

  // No network call here: `bc status` must stay quick.
  // `bc selftest`: the console asked for its devices and cameras. Nothing is changed.
  selftest: (ctx) =>
    settings(ctx).host && ctx.secrets.has('key')
      ? [
          {
            name: settings(ctx).host,
            run: async () => {
              const o = await overview(ctx);
              return `answers · ${o.devices.length - o.offline.length}/${o.devices.length} devices online · ${o.clients.length} clients${o.cameras ? ` · ${o.cameras.length - o.camerasOffline.length}/${o.cameras.length} cameras` : ''}`;
            },
          },
        ]
      : [],

  status: (ctx) => {
    const s = settings(ctx);
    return s.host
      ? `connected to ${s.host}${s.network ? ` · Network ${s.network}` : ''}${s.protect && s.protect !== 'refused' ? ' · Protect' : ''}`
      : 'not set up → bc unifi setup';
  },

  settings: (ctx) => {
    const s = settings(ctx);
    return {
      console: s.host ?? 'not set',
      site: s.siteName ?? 'not set',
      'certificate remembered': s.pin ? `${s.pin.slice(0, 23)}…` : 'no',
    };
  },

  // For `bc engine check`: what the owner might say, and the command it should lead to.
  checks: (ctx) =>
    settings(ctx).host ? [{ say: 'which device used the most data on the network today', expect: /blackcat unifi usage\b/ }] : [],
  agent: {
    readDirs: () => [MEDIA],
    fill: (ctx) => {
      const s = settings(ctx);
      const cameras = !!s.host && !!s.protect && s.protect !== 'refused';
      return {
        ready: !!s.host,
        console: `${s.host}${s.network ? ` (Network ${s.network})` : ''}`,
        cameras,
        'no-cameras': !!s.host && !cameras,
      };
    },
  },
};
