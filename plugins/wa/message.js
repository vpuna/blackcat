import { getContentType, normalizeMessageContent, proto } from 'baileys';

const { REVOKE, MESSAGE_EDIT } = proto.Message.ProtocolMessage.Type;

export const toNum = (v) => (v == null ? null : typeof v === 'number' ? v : Number(v.toString()));

const join = (...parts) => parts.filter(Boolean).join(' · ') || null;
const URL_RE = /https?:\/\/[^\s<>"']+/i;

// Link preview the sender's phone embedded (title, description, small JPEG), or
// just the first URL in the text when there's no preview.
function linkOf(m, text) {
  const url = m?.matchedText || text?.match(URL_RE)?.[0] || null;
  if (!url) return null;
  const thumb = m?.jpegThumbnail?.length ? Buffer.from(m.jpegThumbnail) : null;
  return {
    url,
    title: m?.title || null,
    description: m?.description || null,
    thumb,
    width: m?.thumbnailWidth ?? null,
    height: m?.thumbnailHeight ?? null,
  };
}

// Baileys' download type per message kind (it selects the decryption key derivation).
const DL_TYPE = {
  imageMessage: 'image',
  videoMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'document',
  stickerMessage: 'sticker',
};
const buf = (b) => (b?.length ? Buffer.from(b) : null);

// Everything needed to describe a media file and fetch it later: where it sits on
// WhatsApp's servers, the key to decrypt it, and the small thumbnail embedded in the message.
function mediaOf(kind, m) {
  return {
    dlType: kind === 'audioMessage' && m.ptt ? 'ptt' : kind === 'videoMessage' && m.gifPlayback ? 'gif' : DL_TYPE[kind],
    mimetype: m.mimetype || null,
    size: toNum(m.fileLength),
    width: m.width ?? null,
    height: m.height ?? null,
    seconds: m.seconds ?? null,
    fileName: m.fileName || m.title || null,
    directPath: m.directPath || null,
    url: m.url || null,
    mediaKey: buf(m.mediaKey),
    sha256: buf(m.fileSha256),
    encSha256: buf(m.fileEncSha256),
    thumb: buf(m.jpegThumbnail) ?? buf(m.pngThumbnail),
  };
}

// Turn message content into { type, text, quoted, link, media }, or null for things not worth
// storing (reactions, receipts, key exchanges, poll votes, pins…).
export function describe(content) {
  const c = normalizeMessageContent(content);
  if (!c) return null;
  const kind = getContentType(c);
  const m = c[kind];
  const quoted = m?.contextInfo?.stanzaId ?? null;

  switch (kind) {
    case 'conversation':
      return { type: 'text', text: c.conversation, quoted: null, link: linkOf(null, c.conversation) };
    case 'extendedTextMessage':
      return { type: 'text', text: m.text, quoted, link: linkOf(m, m.text) };
    case 'imageMessage':
      return { type: 'image', text: m.caption || null, quoted, link: linkOf(null, m.caption), media: mediaOf(kind, m) };
    case 'videoMessage':
      return {
        type: m.gifPlayback ? 'gif' : 'video',
        text: m.caption || null,
        quoted,
        link: linkOf(null, m.caption),
        media: mediaOf(kind, m),
      };
    case 'audioMessage':
      return { type: m.ptt ? 'voice' : 'audio', text: null, quoted, media: mediaOf(kind, m) };
    case 'documentMessage':
      return { type: 'document', text: join(m.fileName, m.caption), quoted, media: mediaOf(kind, m) };
    case 'stickerMessage':
      return { type: 'sticker', text: null, quoted, media: mediaOf(kind, m) };
    case 'locationMessage':
    case 'liveLocationMessage':
      return { type: 'location', text: join(m.name, m.address, m.caption), quoted };
    case 'contactMessage':
      return { type: 'contact', text: m.displayName || null, quoted };
    case 'contactsArrayMessage':
      return { type: 'contact', text: join(m.displayName, ...(m.contacts ?? []).map((x) => x.displayName)), quoted };
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3':
      return { type: 'poll', text: join(m.name, ...(m.options ?? []).map((o) => o.optionName)), quoted };
    case 'eventMessage':
      return { type: 'event', text: join(m.name, m.description, m.location?.name), quoted };
    default:
      return null;
  }
}

// Edits and deletions arrive as protocol messages pointing at an earlier message.
export function protocolChange(content) {
  const pm = normalizeMessageContent(content)?.protocolMessage;
  if (!pm?.key?.id) return null;
  if (pm.type === REVOKE) return { kind: 'delete', id: pm.key.id };
  if (pm.type === MESSAGE_EDIT) {
    const edited = describe(pm.editedMessage);
    return edited ? { kind: 'edit', id: pm.key.id, text: edited.text, link: edited.link } : null;
  }
  return null;
}
