// A small client for Home Assistant's REST API (the same one its own apps use), with a
// long-lived access token.
export class HaError extends Error {}

const TIMEOUT_MS = 15_000;

export function client({ url, token }) {
  async function request(method, path, body) {
    if (!url || !token) throw new HaError('Home Assistant is not set up yet. Run `bc ha setup` on this machine, or /setup in the bot.');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`${url}${path}`, {
        method,
        signal: ctl.signal,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body == null ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new HaError(
        `Can't reach Home Assistant at ${url}: ${e.name === 'AbortError' ? 'no answer in 15 seconds' : (e.cause?.code ?? e.message)}`,
      );
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    if (res.status === 401 || res.status === 403)
      throw new HaError(
        'Home Assistant refused the access token. Create a new one (your profile → Security → Long-lived access tokens) and run `bc ha setup` again.',
      );
    if (res.status === 404) throw Object.assign(new HaError(`Home Assistant has no ${path}`), { status: 404 });
    if (!res.ok) throw new HaError(`Home Assistant answered ${res.status}: ${text.slice(0, 200)}`);
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return text; // /api/template answers with plain text
    }
  }
  // Home Assistant's registries (which room a thing is in, whether it is a setting or a
  // diagnostic, whether it is hidden) are only available over its WebSocket API.
  function registries() {
    return new Promise((resolve, reject) => {
      const want = { 1: 'config/area_registry/list', 2: 'config/device_registry/list', 3: 'config/entity_registry/list' };
      const got = {};
      let ws;
      try {
        ws = new WebSocket(`${url.replace(/^http/, 'ws')}/api/websocket`);
      } catch (e) {
        return reject(new HaError(`no WebSocket: ${e.message}`));
      }
      const timer = setTimeout(() => (ws.close(), reject(new HaError('the registries did not arrive in 20 seconds'))), 20_000);
      const done = (fn, v) => (clearTimeout(timer), ws.close(), fn(v));
      ws.onerror = () => done(reject, new HaError('the WebSocket connection failed'));
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: token }));
        else if (m.type === 'auth_invalid') done(reject, new HaError('the token was refused'));
        else if (m.type === 'auth_ok') for (const [id, type] of Object.entries(want)) ws.send(JSON.stringify({ id: Number(id), type }));
        else if (m.type === 'result') {
          if (!m.success) return done(reject, new HaError(m.error?.message ?? 'a registry could not be read'));
          got[m.id] = m.result;
          if (Object.keys(got).length === 3) done(resolve, { areas: got[1], devices: got[2], entities: got[3] });
        }
      };
    });
  }
  return {
    registries,
    config: () => request('GET', '/api/config'),
    states: () => request('GET', '/api/states'),
    state: (id) => request('GET', `/api/states/${id}`),
    call: (domain, service, data) => request('POST', `/api/services/${domain}/${service}`, data),
    // What a media player can be asked to play, one folder at a time. It only lists: nothing is played.
    browse: async (entityId, id) => {
      const d = await request('POST', '/api/services/media_player/browse_media?return_response', {
        entity_id: entityId,
        ...(id ? { media_content_id: id, media_content_type: 'app' } : {}),
      });
      return d?.service_response?.[entityId] ?? null;
    },
    template: (template) => request('POST', '/api/template', { template }),
    history: (id, sinceIso) => request('GET', `/api/history/period/${sinceIso}?filter_entity_id=${id}&minimal_response&no_attributes`),
  };
}
