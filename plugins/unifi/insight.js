// Usage and the system log, from the Network application's own interface (the one the
// UniFi app uses). The console keeps this history itself; nothing is stored here.
// Read-only: the POST requests below are queries, the way that interface takes them.
import { UnifiError } from './api.js';

const LOG_PAGE = 1000;
const LOG_MAX = 8000; // client connects and disconnects read for one answer
export const LOG_CATEGORIES = {
  SECURITY: 'security',
  INTERNET_AND_WAN: 'internet',
  UNIFI_DEVICES: 'UniFi devices',
  UNIFI_ETHERNET_PORTS: 'ports',
  POWER: 'power',
  VPN: 'VPN',
  SOFTWARE_UPDATES: 'updates',
  AUDIT: 'admin activity',
  UNKNOWN: 'other',
};

// The console names traffic by number. These are its categories; the applications inside
// them (several thousand) are only named in the app itself, so they are not shown.
const KINDS = {
  0: 'instant messaging',
  1: 'peer-to-peer',
  3: 'file transfer',
  4: 'streaming',
  5: 'mail and collaboration',
  6: 'voice and video calls',
  7: 'databases',
  8: 'games',
  9: 'network management',
  10: 'remote access',
  11: 'proxies and tunnels',
  12: 'stock market',
  13: 'web',
  14: 'security updates',
  15: 'web messaging',
  17: 'business',
  18: 'network protocols',
  19: 'network protocols',
  20: 'network protocols (encrypted web traffic)',
  23: 'private protocols',
  24: 'social networks',
  255: 'unidentified',
};

const gone = (e) =>
  e.status === 404 || e.status === 400 || e.status === 401 || e.status === 403
    ? new UnifiError(
        `This console does not give that through its own interface (${e.status}). It changes between UniFi versions, and this one may not have it or may not accept the key for it.`,
      )
    : e;
const ask = (u, method, path, body) =>
  (method === 'GET' ? u.get('internal', path) : u.post('internal', path, body)).catch((e) => {
    throw gone(e);
  });

// The site's short name in that interface ("default"), from the name shown in the app.
const keys = new Map();
async function siteKey(u, siteName) {
  if (keys.has(siteName)) return keys.get(siteName);
  const sites = (await ask(u, 'GET', '/api/self/sites'))?.data ?? [];
  const key = (sites.find((s) => s.desc === siteName) ?? sites[0])?.name ?? 'default';
  keys.set(siteName, key);
  return key;
}

export const bytes = (n) => {
  if (!n) return '0';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log10(n) / 3));
  const v = n / 1000 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
};
const label = (c, mac) => c?.name || c?.display_name || c?.hostname || (c?.oui ? `${c.oui} ${mac.slice(-5)}` : mac);

// Everything the console knows about who is who: mac → { name, ip, wired, firstSeen, lastSeen }.
async function people(u, site, hours) {
  const within = Math.max(24, Math.ceil(hours));
  const [now, seen, shown, past] = await Promise.all([
    ask(u, 'GET', `/api/s/${site}/stat/sta`),
    ask(u, 'GET', `/api/s/${site}/stat/alluser?within=${within}`),
    // The names the app shows (it makes one up from the maker when the owner gave none).
    ask(u, 'GET', `/v2/api/site/${site}/clients/active`).catch(() => []),
    ask(u, 'GET', `/v2/api/site/${site}/clients/history?withinHours=${within}`).catch(() => []),
  ]);
  const display = new Map(
    [...(Array.isArray(past) ? past : []), ...(Array.isArray(shown) ? shown : [])]
      .filter((c) => c.mac && (c.display_name || c.name))
      .map((c) => [c.mac, c.display_name || c.name]),
  );
  const out = new Map();
  for (const c of [...(seen?.data ?? []), ...(now?.data ?? [])]) {
    const prev = out.get(c.mac) ?? {};
    out.set(c.mac, {
      mac: c.mac,
      name: display.get(c.mac) ?? label({ ...prev.raw, ...c }, c.mac),
      ip: c.ip ?? c.last_ip ?? prev.ip ?? null,
      wired: !!c.is_wired,
      firstSeen: c.first_seen ?? prev.firstSeen ?? null,
      lastSeen: c.last_seen ?? prev.lastSeen ?? null,
      via: c.last_uplink_name ?? prev.via ?? null,
      connected: (now?.data ?? []).some((x) => x.mac === c.mac),
      raw: { ...prev.raw, ...c },
    });
  }
  return out;
}

// Who moved how much between two moments.
//   total     everything through the network, including between machines at home
//   internet  what went to and from the internet, by app (the console's traffic identification)
export async function usage(u, siteName, fromMs, toMs) {
  const site = await siteKey(u, siteName);
  const hours = (toMs - fromMs) / 3600_000;
  // The console keeps hourly figures for a few days and daily ones for longer.
  const kind = hours <= 72 ? 'hourly' : 'daily';
  const [who, report, traffic] = await Promise.all([
    people(u, site, hours),
    ask(u, 'POST', `/api/s/${site}/stat/report/${kind}.user`, { attrs: ['rx_bytes', 'tx_bytes', 'time'], start: fromMs, end: toMs }),
    ask(u, 'GET', `/v2/api/site/${site}/traffic?start=${fromMs}&end=${toMs}&includeUnidentified=true`).catch(() => null),
  ]);
  const rows = new Map();
  const row = (mac) =>
    rows.get(mac) ??
    rows
      .set(mac, {
        mac,
        name: who.get(mac)?.name ?? mac,
        ip: who.get(mac)?.ip ?? null,
        wired: who.get(mac)?.wired ?? null,
        total: 0,
        internet: null,
        apps: [],
        hours: [],
      })
      .get(mac);
  for (const r of report?.data ?? []) {
    const x = row(r.user);
    const n = (r.rx_bytes ?? 0) + (r.tx_bytes ?? 0);
    x.total += n;
    x.hours.push({ time: r.time, bytes: n });
  }
  for (const c of traffic?.client_usage_by_app ?? []) {
    const x = row(c.client.mac);
    if (x.name === x.mac) x.name = label(c.client, c.client.mac);
    const kinds = new Map();
    for (const a of c.usage_by_app ?? []) {
      const k = KINDS[a.category] ?? `category ${a.category}`;
      const y = kinds.get(k) ?? kinds.set(k, { kind: k, bytes: 0, down: 0, up: 0 }).get(k);
      y.bytes += a.total_bytes ?? 0;
      y.down += a.bytes_received ?? 0;
      y.up += a.bytes_transmitted ?? 0;
    }
    x.apps = [...kinds.values()].sort((a, b) => b.bytes - a.bytes);
    x.internet = x.apps.reduce((s, a) => s + a.bytes, 0);
    x.down = x.apps.reduce((s, a) => s + a.down, 0);
    x.up = x.apps.reduce((s, a) => s + a.up, 0);
  }
  return { kind, hasInternet: !!traffic, clients: [...rows.values()] };
}

const fill = (e) =>
  String(e.message_raw ?? e.title_raw ?? e.event ?? '').replace(
    /\{([A-Z_]+)\}/g,
    (all, k) => e.parameters?.[k]?.name ?? e.parameters?.[k]?.id ?? all,
  );

// What the console logged between two moments, boiled down:
//   notable   everything that is not a client joining or leaving, in full
//   clients   per client: how often it joined and left (a device that keeps dropping stands out)
//   fresh     clients the console had never seen before this period
export async function events(u, siteName, fromMs, toMs) {
  const site = await siteKey(u, siteName);
  const page = (categories, n) =>
    ask(u, 'POST', `/v2/api/site/${site}/system-log/all`, {
      timestampFrom: fromMs,
      timestampTo: toMs,
      pageNumber: n,
      pageSize: LOG_PAGE,
      categories,
    });
  const [who, other, first, admin, ips] = await Promise.all([
    people(u, site, (toMs - fromMs) / 3600_000),
    page(Object.keys(LOG_CATEGORIES), 0),
    page(['CLIENT_DEVICES'], 0),
    // Who opened the console's own pages, and from where. (Kept apart from the rest of the log.)
    ask(u, 'POST', `/v2/api/site/${site}/system-log/admin-activity`, {
      timestampFrom: fromMs,
      timestampTo: toMs,
      pageNumber: 0,
      pageSize: 200,
    }).catch(() => null),
    // Whether the console is looking for threats at all. Only these few fields are read.
    ask(u, 'GET', `/api/s/${site}/get/setting/ips`).catch(() => null),
  ]);
  const guard = ips?.data?.[0];
  const joins = [...(first?.data ?? [])];
  for (let n = 1; n < (first?.total_page_count ?? 1) && joins.length < LOG_MAX; n++)
    joins.push(...((await page(['CLIENT_DEVICES'], n))?.data ?? []));

  const per = new Map();
  for (const e of joins) {
    const c = e.parameters?.CLIENT ?? {};
    const mac = c.id ?? 'unknown';
    const x =
      per.get(mac) ??
      per
        .set(mac, {
          mac,
          name: c.name || c.hostname || who.get(mac)?.name || mac,
          joined: 0,
          left: 0,
          roamed: 0,
          other: 0,
          last: 0,
          via: null,
          signal: null,
        })
        .get(mac);
    if (/DISCONNECTED/.test(e.event)) x.left++;
    else if (/ROAM/.test(e.event)) x.roamed++;
    else if (/CONNECTED/.test(e.event)) x.joined++;
    else x.other++;
    if (e.timestamp > x.last)
      ((x.last = e.timestamp), (x.via = e.parameters?.DEVICE?.name ?? x.via), (x.signal = e.parameters?.SIGNAL_STRENGTH?.name ?? x.signal));
  }
  const from = fromMs / 1000;
  return {
    total: (first?.total_element_count ?? 0) + (other?.total_element_count ?? 0),
    truncated: joins.length < (first?.total_element_count ?? 0),
    // (Sign-ins to the console are counted separately below, grouped, rather than listed one by one.)
    notable: (other?.data ?? [])
      .filter((e) => !(admin && /^ADMIN_ACCESS/.test(e.key ?? e.event ?? '')))
      .map((e) => ({
        time: e.timestamp,
        category: LOG_CATEGORIES[e.category] ?? e.category,
        severity: e.severity,
        event: e.event,
        text: fill(e),
      })),
    notableTotal: (other?.data ?? []).filter((e) => !(admin && /^ADMIN_ACCESS/.test(e.key ?? e.event ?? ''))).length,
    clients: [...per.values()].sort((a, b) => b.joined + b.left - (a.joined + a.left)),
    admin: (admin?.data ?? []).map((e) => ({
      time: e.timestamp,
      who: e.admin?.name ?? 'someone',
      how: String(e.platform ?? '').toLowerCase() || null,
      ip: e.ip ?? null,
      what:
        e.key === 'ADMIN_ACCESS'
          ? 'opened the console'
          : fill({
              message_raw: e.message,
              parameters: { ADMIN: { name: e.admin?.name }, PLATFORM: { name: e.platform }, IP: { name: e.ip } },
            }),
    })),
    adminTotal: admin?.total_element_count ?? 0,
    // null when the console would not say.
    protection: guard
      ? {
          intrusion: guard.ips_mode && guard.ips_mode !== 'disabled' ? guard.ips_mode : null,
          dnsFiltering: !!guard.dns_filtering,
          adBlocking: !!guard.ad_blocking_enabled,
          honeypot: !!guard.honeypot_enabled,
        }
      : null,
    fresh: [...who.values()].filter((c) => c.firstSeen && c.firstSeen >= from).map(({ raw, ...c }) => c),
  };
}
