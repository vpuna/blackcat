import https from 'node:https';
import tls from 'node:tls';

// A small client for the official UniFi APIs served by a UniFi console (a Dream Router,
// Cloud Gateway, …): Network at /proxy/network/integration/v1 and Protect at
// /proxy/protect/integration/v1, both with an API key in the X-API-Key header.
//
// Consoles use a self-signed certificate, so the usual check can't be used. Instead the
// certificate's fingerprint is remembered at setup and must be the same on every later
// connection, before the key is sent.

// `internal` is the Network application's own interface, the one its app uses. It is not
// documented or promised to stay the same, so it is used only for what the official one
// lacks: usage history and the system log (see insight.js).
const BASE = { network: '/proxy/network/integration/v1', protect: '/proxy/protect/integration/v1', internal: '/proxy/network' };
const TIMEOUT_MS = 15_000;
// "192.168.1.1" or "192.168.1.1:11443" (a self-hosted console on another port).
const addr = (host) => {
  const [name, port] = String(host).split(':');
  return { name, port: Number(port) || 443 };
};

export class UnifiError extends Error {}

// The SHA-256 fingerprint of the certificate the console presents.
export const fingerprint = (host) =>
  new Promise((resolve, reject) => {
    const { name, port } = addr(host);
    const sock = tls.connect({ host: name, port, rejectUnauthorized: false, timeout: TIMEOUT_MS }, () => {
      const fp = sock.getPeerCertificate()?.fingerprint256;
      sock.end();
      fp ? resolve(fp) : reject(new UnifiError(`${host} did not present a certificate`));
    });
    sock.on('timeout', () => sock.destroy(new Error('timed out')));
    sock.on('error', (e) => reject(new UnifiError(`Can't reach ${host}: ${e.message}`)));
  });

// The console's certificate, as text, once it has been matched against the fingerprint
// remembered at setup. It is then the ONLY certificate a request will accept: every
// connection that carries the API key is verified against it during the TLS handshake,
// before any of the request is sent. (Consoles sign their own certificate, so the usual
// check against public authorities can't be used.)
const trusted = new Map(); // host → PEM
function certificate(host, pin) {
  if (trusted.has(host)) return Promise.resolve(trusted.get(host));
  return new Promise((resolve, reject) => {
    const { name, port } = addr(host);
    const sock = tls.connect({ host: name, port, rejectUnauthorized: false, timeout: TIMEOUT_MS }, () => {
      const cert = sock.getPeerCertificate();
      sock.end();
      if (!cert?.raw) return reject(new UnifiError(`${host} did not present a certificate`));
      if (pin && cert.fingerprint256 !== pin) {
        return reject(
          new UnifiError(
            `The certificate of ${host} has changed since setup, so the API key was not sent. If you updated or reset the console, run \`bc unifi setup\` again to accept the new one. If you did not, something else may be answering at that address.`,
          ),
        );
      }
      const pem = `-----BEGIN CERTIFICATE-----\n${cert.raw
        .toString('base64')
        .match(/.{1,64}/g)
        .join('\n')}\n-----END CERTIFICATE-----\n`;
      trusted.set(host, pem);
      resolve(pem);
    });
    sock.on('timeout', () => sock.destroy(new Error('timed out')));
    sock.on('error', (e) => reject(new UnifiError(`Can't reach ${host}: ${e.message}`)));
  });
}

export function client({ host, key, pin }) {
  async function request(app, method, path, { body, binary = false } = {}) {
    if (!host || !key) throw new UnifiError('UniFi is not set up yet. Run `bc unifi setup` on this machine, or /setup in the bot.');
    // Without a remembered certificate there is nothing to tell the console from an impostor, so the key stays here.
    if (!pin)
      throw new UnifiError(`The certificate of ${host} was never recorded, so the API key was not sent. Run \`bc unifi setup\` again.`);
    const ca = await certificate(host, pin);
    const data = body == null ? null : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          host: addr(host).name,
          port: addr(host).port,
          method,
          path: `${BASE[app]}${path}`,
          timeout: TIMEOUT_MS,
          // Verified: only that exact certificate is accepted (its name is not checked: it is
          // issued to "unifi.local" or similar, not to the address it is reached by).
          ca,
          rejectUnauthorized: true,
          checkServerIdentity: (_name, cert) =>
            pin && cert.fingerprint256 !== pin ? new Error('the console presented a different certificate') : undefined,
          headers: {
            'X-API-Key': key,
            Accept: binary ? 'image/jpeg' : 'application/json',
            ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              if (binary) return resolve(buf);
              try {
                return resolve(buf.length ? JSON.parse(buf.toString('utf8')) : null);
              } catch {
                return reject(new UnifiError(`${host} answered ${method} ${path} with something that is not JSON`));
              }
            }
            let detail = '';
            try {
              const j = JSON.parse(buf.toString('utf8'));
              detail = j.message ?? j.error ?? '';
            } catch {}
            const hint =
              res.statusCode === 401 || res.statusCode === 403
                ? ' The API key was refused: check it, or create a new one (Settings → Control Plane → Integrations).'
                : res.statusCode === 404
                  ? ' This console does not offer that (an older version, or the application is not installed).'
                  : '';
            reject(
              Object.assign(new UnifiError(`${app} ${method} ${path} → ${res.statusCode}${detail ? ` ${detail}` : ''}.${hint}`), {
                status: res.statusCode,
              }),
            );
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', (e) =>
        reject(
          new UnifiError(
            /certificate|self.signed|unable to verify/i.test(e.message)
              ? `The certificate of ${host} is not the one remembered at setup, so the API key was not sent (${e.message}). If you updated or reset the console, run \`bc unifi setup\` again.`
              : `Can't reach ${host}: ${e.message}`,
          ),
        ),
      );
      req.end(data ?? undefined);
    });
  }

  // Lists come in pages: { offset, limit, count, totalCount, data }. Some (Protect) are plain arrays.
  async function list(app, path, max = 2000) {
    const out = [];
    for (let offset = 0; out.length < max;) {
      const page = await request(app, 'GET', `${path}${path.includes('?') ? '&' : '?'}offset=${offset}&limit=200`);
      if (Array.isArray(page)) return page;
      const rows = page?.data ?? [];
      out.push(...rows);
      offset += rows.length;
      if (!rows.length || offset >= (page.totalCount ?? 0)) break;
    }
    return out;
  }

  return {
    request,
    list,
    get: (app, path) => request(app, 'GET', path),
    post: (app, path, body) => request(app, 'POST', path, { body }),
    image: (app, path) => request(app, 'GET', path, { binary: true }),
  };
}
