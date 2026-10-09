// A stand-in for Home Assistant, for the media commands: it lists a media folder, and notes
// every service that is called (nothing here plays anything).
import http from 'node:http';

const file = (title, folder = 'local') => ({
  title,
  media_class: 'music',
  media_content_type: 'audio/mpeg',
  media_content_id: `media-source://media_source/${folder}/${title}`,
  can_play: true,
  can_expand: false,
});
const dir = (title, id) => ({
  title,
  media_class: 'directory',
  media_content_type: 'app',
  media_content_id: id,
  can_play: false,
  can_expand: true,
});

export async function haServer({ token = 'TOKEN' } = {}) {
  const calls = []; // [service, data]
  const state = { volume: 0.6, playing: null, refuseVolumeWhenOff: false, cannotBrowse: [] };
  const tree = {
    'media-source://media_source': [
      file('10 Hours Rain & Thunder ｜ Rainstorm Sounds for Sleep, Studying or Relaxation ｜ Nature White Noise.mp3'),
      file('Ocean Waves Relaxation 10 Hours ｜ Soothing Waves Crashing on Beach ｜ White Noise for Sleep.mp3'),
      file('Cozy Cabin Ambience - Rain and Fireplace Sounds at Night 8 Hours.mp3'),
      dir('Music', 'media-source://media_source/local/Music'),
      // the cover picture that sits beside a sound, as in a real folder
      {
        title: '10 Hours Rain & Thunder ｜ Rainstorm Sounds for Sleep, Studying or Relaxation ｜ Nature White Noise.webp',
        media_content_type: 'image/webp',
        media_content_id: 'media-source://media_source/local/10 Hours Rain & Thunder.webp',
        can_play: true,
        can_expand: false,
      },
      // something a hostile or odd server might list: an address of somewhere else
      {
        title: 'A stream from elsewhere',
        media_content_type: 'audio/mpeg',
        media_content_id: 'http://elsewhere.example/stream.mp3',
        can_play: true,
        can_expand: false,
      },
    ],
    'media-source://media_source/local/Music': [file('Creep (cover).mp3', 'local/Music')],
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const send = (code, o) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(o));
      if (req.headers.authorization !== `Bearer ${token}`) return send(401, {});
      const url = req.url;
      const data = body ? JSON.parse(body) : {};
      const m = /^\/api\/services\/([a-z_]+)\/([a-z_]+)(\?return_response)?$/.exec(url);
      if (req.method === 'POST' && m) {
        const service = `${m[1]}.${m[2]}`;
        if (service === 'media_player.browse_media') {
          if (state.cannotBrowse.includes(data.entity_id)) return send(500, { message: 'this player cannot browse media' });
          const children =
            tree[data.media_content_id ?? 'top'] ?? (data.media_content_id ? null : [dir('My media', 'media-source://media_source')]);
          if (!children) return send(500, { message: 'no such folder' });
          return send(200, { service_response: { [data.entity_id]: { title: 'media', children } } });
        }
        calls.push([service, data]);
        if (service === 'media_player.volume_set') {
          if (state.refuseVolumeWhenOff && !state.playing) return send(500, { message: 'the player is off' });
          state.volume = data.volume_level;
        }
        if (service === 'media_player.play_media') state.playing = data.media_content_id;
        if (service === 'media_player.media_play') state.playing ??= 'whatever was playing';
        if (['media_player.media_pause', 'media_player.media_stop'].includes(service)) state.playing = null;
        return send(200, []);
      }
      const s = /^\/api\/states\/(.+)$/.exec(url);
      if (req.method === 'GET' && s)
        return send(200, {
          entity_id: s[1],
          state: state.playing ? 'playing' : 'off',
          attributes: {
            volume_level: state.volume,
            ...(state.playing ? { media_title: decodeURIComponent(String(state.playing).split('/').pop()) } : {}),
          },
        });
      return send(404, {});
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, token, calls, state, close: () => new Promise((r) => server.close(r)) };
}
