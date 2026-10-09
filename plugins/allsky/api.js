// Talking to an Allsky camera over its own web server: the latest picture, the folder of
// each night, and what Allsky makes of a night (star trails, a keogram, a timelapse).
// Nothing here knows where Allsky is installed: only its address.
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export class AllskyError extends Error {}

const TIMEOUT_MS = 20_000;

// → { get, head, listing, download, json }
export function client({ url, user, password, timeoutMs = TIMEOUT_MS }) {
  const base = String(url ?? '').replace(/\/+$/, '');
  const headers = user ? { authorization: `Basic ${Buffer.from(`${user}:${password ?? ''}`).toString('base64')}` } : {};
  async function ask(path, { method = 'GET', ms = timeoutMs } = {}) {
    let res;
    try {
      res = await fetch(`${base}${path}`, { method, headers, signal: AbortSignal.timeout(ms), redirect: 'follow' });
    } catch (e) {
      throw new AllskyError(
        e.name === 'TimeoutError'
          ? `Allsky at ${base} did not answer in time.`
          : `Could not reach Allsky at ${base} (${e.cause?.code ?? e.message}).`,
      );
    }
    if (res.status === 401 || res.status === 403)
      throw new AllskyError(
        `Allsky at ${base} asks for a login for ${path}${user ? ', and did not accept the one that is saved' : ''}. Set it with: bc allsky setup`,
      );
    if (res.status === 404) throw Object.assign(new AllskyError(`Allsky has nothing at ${path}.`), { missing: true });
    if (!res.ok) throw new AllskyError(`Allsky answered ${res.status} for ${path}.`);
    return res;
  }
  return {
    base,
    // Is it there, how big, when was it last changed?
    async head(path, ms) {
      const r = await ask(path, { method: 'HEAD', ms });
      const m = r.headers.get('last-modified');
      return { bytes: Number(r.headers.get('content-length')) || null, modified: m ? new Date(m) : null };
    },
    // The names in a folder, as the web server lists them (folders end in "/").
    async listing(path) {
      const html = await (await ask(path.endsWith('/') ? path : `${path}/`)).text();
      const out = [];
      for (const m of html.matchAll(/href="([^"?#]+)"/g)) {
        let name;
        try {
          name = decodeURIComponent(m[1]);
        } catch {
          continue;
        }
        // Only what is in this folder: no way up, no address of somewhere else.
        if (!name || name.startsWith('.') || name.startsWith('/') || /^[a-z]+:/i.test(name) || name.slice(0, -1).includes('/')) continue;
        out.push(name);
      }
      return [...new Set(out)];
    },
    // Fetch a file to `dest`. → its size. Refused, before anything is fetched when the size is known, if it is over `maxBytes`.
    async download(path, dest, maxBytes) {
      const res = await ask(path);
      const said = Number(res.headers.get('content-length')) || null;
      if (maxBytes && said && said > maxBytes)
        throw Object.assign(new AllskyError(`It is ${mb(said)}, over the ${mb(maxBytes)} this is set to fetch (bc allsky setup).`), {
          tooBig: true,
          bytes: said,
        });
      const tmp = `${dest}.part`;
      let got = 0;
      const counted = Readable.fromWeb(res.body).on('data', (c) => {
        got += c.length;
        if (maxBytes && got > maxBytes)
          counted.destroy(
            Object.assign(new AllskyError(`It is over the ${mb(maxBytes)} this is set to fetch (bc allsky setup).`), { tooBig: true }),
          );
      });
      try {
        await pipeline(counted, fs.createWriteStream(tmp, { mode: 0o600 }));
      } catch (e) {
        fs.rmSync(tmp, { force: true });
        throw e instanceof AllskyError ? e : new AllskyError(`The download stopped part-way (${e.message}).`);
      }
      fs.renameSync(tmp, dest);
      return got;
    },
    async json(path) {
      try {
        return await (await ask(path)).json();
      } catch (e) {
        if (e instanceof AllskyError) throw e;
        throw new AllskyError(`Allsky's answer for ${path} could not be read.`);
      }
    },
  };
}

export const mb = (bytes) =>
  bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(bytes >= 10 * 1024 ** 2 ? 0 : 1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

// ---- nights ----
// Allsky keeps one folder per night, named for the day the night began: a picture taken at
// 02:00 on the 5th is in the folder of the 4th. (It files a picture under the date twelve
// hours before it was taken.) Times are the camera's, taken to be this machine's.

const pad = (n) => String(n).padStart(2, '0');
export const nightOf = (date) => {
  const d = new Date(date.getTime() - 12 * 3600_000);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
};
export const prettyNight = (n) => `${n.slice(0, 4)}-${n.slice(4, 6)}-${n.slice(6, 8)}`;
const dayOf = (n) => new Date(Number(n.slice(0, 4)), Number(n.slice(4, 6)) - 1, Number(n.slice(6, 8)));

// What the owner wrote for a night → its folder name, or null for "the most recent that has it".
// 20261004, 2026-10-04, "last" (the latest), "tonight" (the one in progress).
export function parseNight(text, now = new Date()) {
  const t = String(text ?? '')
    .trim()
    .toLowerCase();
  if (!t || t === 'last' || t === 'latest') return null;
  if (t === 'tonight' || t === 'today') return nightOf(now);
  if (t === 'yesterday') return nightOf(new Date(now.getTime() - 24 * 3600_000));
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(t);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12 || Number(m[3]) < 1 || Number(m[3]) > 31)
    throw new AllskyError(`"${text}" is not a night. Give its date (2026-10-04: the day the night began), or last, tonight, yesterday.`);
  return `${m[1]}${m[2]}${m[3]}`;
}

// "02:30" (and optionally a night) → the moment meant. Without a night: the last time it was that time.
export function parseMoment(text, night, now = new Date()) {
  const m = /^(\d{1,2})[:.]?(\d{2})$/.exec(String(text ?? '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59)
    throw new AllskyError(`"${text}" is not a time. Give it as HH:MM, like 02:30 or 21:15.`);
  const [h, min] = [Number(m[1]), Number(m[2])];
  if (night) {
    const d = dayOf(night);
    // In a night's folder, the afternoon and evening are that day; the small hours and morning, the next.
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + (h < 12 ? 1 : 0), h, min);
  }
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, min);
  return t > now ? new Date(t.getTime() - 24 * 3600_000) : t;
}

// image-20261005021530.jpg → the moment it was taken, or null.
export function takenAt(name) {
  const m = /^image-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(jpe?g|png)$/i.exec(name);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) : null;
}

// Of a night's pictures, the one taken closest to a moment. → { name, at, offMs } or null
export function closest(names, moment) {
  let best = null;
  for (const name of names) {
    const at = takenAt(name);
    if (!at) continue;
    const offMs = Math.abs(at - moment);
    if (!best || offMs < best.offMs) best = { name, at, offMs };
  }
  return best;
}

// The nights the camera has, oldest first.
export const nights = async (c) =>
  (await c.listing('/images/'))
    .filter((n) => /^\d{8}\/$/.test(n))
    .map((n) => n.slice(0, 8))
    .sort();

// What Allsky makes of a night, and where it puts it.
export const PRODUCTS = {
  startrails: {
    label: 'star trails',
    find: async (c, n) =>
      (await c.listing(`/images/${n}/startrails/`)).filter((f) => /\.(jpe?g|png)$/i.test(f)).map((f) => `/images/${n}/startrails/${f}`)[0],
  },
  keogram: {
    label: 'keogram',
    find: async (c, n) =>
      (await c.listing(`/images/${n}/keogram/`)).filter((f) => /\.(jpe?g|png)$/i.test(f)).map((f) => `/images/${n}/keogram/${f}`)[0],
  },
  timelapse: {
    label: 'timelapse',
    find: async (c, n) =>
      (await c.listing(`/images/${n}/`)).filter((f) => /^allsky-.*\.(mp4|webm)$/i.test(f)).map((f) => `/images/${n}/${f}`)[0],
  },
};

// Where a night's product is, looking back from the latest night when none is named.
// → { night, path } or null
export async function findProduct(c, kind, night, lookBack = 7) {
  const p = PRODUCTS[kind];
  const tryNight = async (n) => {
    try {
      return (await p.find(c, n)) ?? null;
    } catch (e) {
      if (e.missing) return null;
      throw e;
    }
  };
  if (night) {
    const path = await tryNight(night);
    return path ? { night, path } : null;
  }
  for (const n of (await nights(c)).reverse().slice(0, lookBack)) {
    const path = await tryNight(n);
    if (path) return { night: n, path };
  }
  return null;
}
