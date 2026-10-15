// Turn Telegram objects into the archive's rows. Kept free of network calls so it can
// be tested with plain objects. Telegram ids all start with "tg" (see wa/db.js: sourceOf).

export const chatRef = (markedId) => `tg:${markedId}`;
// Message ids are only unique within a chat on Telegram, so the chat is part of ours.
export const msgId = (markedId, id) => `tg${markedId}_${id}`;

export function kindOf(entity) {
  switch (entity?.className) {
    case 'User':
      return entity.bot ? 'bot' : 'user';
    case 'Chat':
    case 'ChatForbidden':
      return 'group';
    case 'Channel':
    case 'ChannelForbidden':
      return entity.megagroup ? 'supergroup' : 'channel';
    default:
      return 'user';
  }
}

export function displayName(e) {
  if (!e) return null;
  if (e.title) return e.title;
  return [e.firstName, e.lastName].filter(Boolean).join(' ') || e.username || null;
}

const URL_RE = /https?:\/\/[^\s<>"']+/i;
const num = (v) => (v == null ? null : Number(v.toString()));
const join = (...parts) => parts.filter(Boolean).join(' · ') || null;
const plain = (t) => (typeof t === 'string' ? t : (t?.text ?? null)); // newer layers wrap some text

// The tiny blurred preview Telegram embeds in a photo ("stripped" size), as a JPEG.
function strippedThumb(sizes, toJpg) {
  const s = (sizes ?? []).find((x) => x.className === 'PhotoStrippedSize');
  try {
    return s && toJpg ? Buffer.from(toJpg(Buffer.from(s.bytes))) : null;
  } catch {
    return null;
  }
}

function fromDocument(doc, toJpg) {
  const attr = (name) => (doc.attributes ?? []).find((a) => a.className === name);
  const audio = attr('DocumentAttributeAudio');
  const video = attr('DocumentAttributeVideo');
  const fileName = attr('DocumentAttributeFilename')?.fileName ?? null;
  let type = 'document';
  if (attr('DocumentAttributeSticker')) type = 'sticker';
  else if (attr('DocumentAttributeAnimated')) type = 'gif';
  else if (video) type = 'video';
  else if (audio) type = audio.voice ? 'voice' : 'audio';
  return {
    type,
    fileName,
    media: {
      dlType: 'tg',
      mimetype: doc.mimeType ?? null,
      size: num(doc.size),
      width: video?.w ?? attr('DocumentAttributeImageSize')?.w ?? null,
      height: video?.h ?? attr('DocumentAttributeImageSize')?.h ?? null,
      seconds: Math.round(video?.duration ?? audio?.duration ?? 0) || null,
      fileName,
      directPath: null,
      url: null,
      mediaKey: null,
      sha256: null,
      encSha256: null,
      thumb: strippedThumb(doc.thumbs, toJpg),
    },
  };
}

// → { type, text, link, media } or null for things not worth storing (service messages, empties).
export function describe(msg, { toJpg } = {}) {
  if (!msg || msg.className === 'MessageService' || msg.action) return null;
  const text = msg.message || null;
  const m = msg.media;
  let type = 'text';
  let media = null;
  let link = null;
  let body = text;

  switch (m?.className) {
    case 'MessageMediaPhoto': {
      if (!m.photo || m.photo.className !== 'Photo') break;
      const big = (m.photo.sizes ?? []).filter((s) => s.w).sort((a, b) => b.w - a.w)[0];
      type = 'image';
      media = {
        dlType: 'tg',
        mimetype: 'image/jpeg',
        size: num(big?.size ?? (big?.sizes ? Math.max(...big.sizes) : null)),
        width: big?.w ?? null,
        height: big?.h ?? null,
        seconds: null,
        fileName: null,
        directPath: null,
        url: null,
        mediaKey: null,
        sha256: null,
        encSha256: null,
        thumb: strippedThumb(m.photo.sizes, toJpg),
      };
      break;
    }
    case 'MessageMediaDocument': {
      if (!m.document || m.document.className !== 'Document') break;
      const d = fromDocument(m.document, toJpg);
      type = d.type;
      media = d.media;
      if (type === 'document') body = join(d.fileName, text);
      break;
    }
    case 'MessageMediaWebPage': {
      const w = m.webpage;
      if (w?.className === 'WebPage') link = { url: w.url, title: w.title ?? w.siteName ?? null, description: w.description ?? null };
      break;
    }
    case 'MessageMediaGeo':
    case 'MessageMediaGeoLive':
      type = 'location';
      break;
    case 'MessageMediaVenue':
      type = 'location';
      body = join(m.title, m.address, text);
      break;
    case 'MessageMediaContact':
      type = 'contact';
      body = join([m.firstName, m.lastName].filter(Boolean).join(' '), text);
      break;
    case 'MessageMediaPoll':
      type = 'poll';
      body = join(plain(m.poll?.question), ...(m.poll?.answers ?? []).map((a) => plain(a.text)));
      break;
    default:
      break;
  }
  // A link with no preview still gets its URL recorded.
  if (!link && text) {
    const url = text.match(URL_RE)?.[0];
    if (url) link = { url, title: null, description: null };
  }
  if (type === 'text' && !body) return null;
  return { type, text: body, link, media };
}
