// A stand-in for an Allsky camera's web server: the latest picture, a folder per night with
// a listing like lighttpd's, star trails, a keogram, a timelapse, and its settings file.
import http from 'node:http';

const pad = (n, w = 2) => String(n).padStart(w, '0');
const stamp = (d) =>
  `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const listing = (names) =>
  `<html><body><h2>Index</h2><table><tr><td><a href="../">..</a></td></tr>${names.map((n) => `<tr><td><a href="${encodeURI(n)}">${n}</a></td></tr>`).join('')}<tr><td><a href="?C=M;O=D">sort</a></td></tr><tr><td><a href="http://elsewhere.example/x.jpg">away</a></td></tr><tr><td><a href="/etc/passwd">root</a></td></tr></table></body></html>`;

// `files`: { '/path': Buffer | string }, `dirs`: { '/path/': [names] }. → { url, close, hits, set }
export async function allskyServer({ login = null } = {}) {
  const files = new Map();
  const dirs = new Map();
  const modified = new Map();
  const hits = [];
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    hits.push(`${req.method} ${p}`);
    // The settings pages always ask for a login; the pictures only when told to.
    const needs = p === '/' || p === '/index.php' || (login && !p.startsWith('/public'));
    if (needs) {
      const given = req.headers.authorization === `Basic ${Buffer.from(`${login?.user}:${login?.password}`).toString('base64')}`;
      if (!login || !given) return res.writeHead(401, { 'www-authenticate': 'Basic realm="allsky"' }).end('Unauthorized');
    }
    if (dirs.has(p)) return res.writeHead(200, { 'content-type': 'text/html' }).end(listing(dirs.get(p)));
    if (!files.has(p)) return res.writeHead(404).end('Not Found');
    const body = Buffer.from(files.get(p));
    res.writeHead(200, {
      'content-type': p.endsWith('.json') ? 'application/json' : p.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg',
      'content-length': body.length,
      'last-modified': (modified.get(p) ?? new Date()).toUTCString(),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const add = (p, body, when) => {
    files.set(p, body);
    if (when) modified.set(p, when);
  };
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    hits,
    close: () => new Promise((r) => server.close(r)),
    latest: (body, when) => add('/current/tmp/image.jpg', body, when),
    settings: (o) => add('/config/settings.json', JSON.stringify(o)),
    // A night: pictures at the given moments, and whichever products it has.
    night(name, moments, { startrails = false, keogram = false, timelapse = null } = {}) {
      const names = moments.map((m) => `image-${stamp(m)}.jpg`);
      for (const [i, n] of names.entries()) add(`/images/${name}/${n}`, `picture taken ${moments[i].toISOString()}`);
      const extra = ['thumbnails/'];
      if (startrails) {
        extra.push('startrails/');
        dirs.set(`/images/${name}/startrails/`, [`startrails-${name}.jpg`]);
        add(`/images/${name}/startrails/startrails-${name}.jpg`, `star trails of ${name}`);
      }
      if (keogram) {
        extra.push('keogram/');
        dirs.set(`/images/${name}/keogram/`, [`keogram-${name}.jpg`]);
        add(`/images/${name}/keogram/keogram-${name}.jpg`, `keogram of ${name}`);
      }
      if (timelapse != null) {
        extra.push(`allsky-${name}.mp4`);
        add(`/images/${name}/allsky-${name}.mp4`, timelapse);
      }
      dirs.set(`/images/${name}/`, [...extra, ...names, `thumbnail-${name}.jpg`]);
      dirs.set('/images/', [...new Set([...(dirs.get('/images/') ?? []), `${name}/`])].sort());
    },
  };
}
