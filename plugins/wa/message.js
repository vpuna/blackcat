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

// What businesses send: a message made of parts (a heading, the text, small print) with
// buttons under it. All of it is what the message says, so it is kept as text, one part to
// a line, with what the buttons offer at the end.
const lines = (...parts) =>
  parts
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean)
    .join('\n') || null;
const offers = (labels) => {
  const l = labels.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean);
  return l.length ? `[${l.join(' · ')}]` : null;
};
const HEADER_MEDIA = { imageMessage: 'image', videoMessage: 'video', documentMessage: 'document' };
// A picture, video or file at the head of such a message is the message's own, kept like any other.
function withHead(holder, text, quoted) {
  const kind = Object.keys(HEADER_MEDIA).find((k) => holder?.[k]);
  const out = { type: kind ? HEADER_MEDIA[kind] : 'text', text, quoted, link: linkOf(null, text) };
  if (kind) out.media = mediaOf(kind, holder[kind]);
  return kind || text ? out : null;
}
const templateButton = (b) =>
  b?.quickReplyButton?.displayText ||
  (b?.urlButton && [b.urlButton.displayText, b.urlButton.url].filter(Boolean).join(': ')) ||
  (b?.callButton && [b.callButton.displayText, b.callButton.phoneNumber].filter(Boolean).join(': ')) ||
  null;
// A button of the newer kind carries its label inside a small JSON text.
const flowButton = (b) => {
  try {
    const p = JSON.parse(b?.buttonParamsJson || '{}');
    return [p.display_text, p.url || p.phone_number || p.copy_code].filter(Boolean).join(': ') || null;
  } catch {
    return null;
  }
};

// Kinds that say nothing to read: answers to them are no message of their own.
const SILENT = new Set([
  'protocolMessage',
  'reactionMessage',
  'encReactionMessage',
  'pollUpdateMessage',
  'keepInChatMessage',
  'pinInChatMessage',
  'senderKeyDistributionMessage',
  'fastRatchetKeySenderKeyDistributionMessage',
  'stickerSyncRmrMessage',
  'call',
  'encEventResponseMessage',
  'messageHistoryBundle',
  'messageHistoryNotice',
  'placeholderMessage',
  'associatedChildMessage',
  'albumMessage',
]);
// The name of a kind of message that was not kept and is not known to be nothing: for the
// log, so that something being missed can be seen. Only the name: never what it said.
export function unkept(content) {
  const c = normalizeMessageContent(content);
  const kind = c && getContentType(c);
  return kind && !SILENT.has(kind) && !describe(content) ? kind : null;
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
    case 'templateMessage': {
      const t = m.hydratedTemplate ?? m.hydratedFourRowTemplate;
      if (!t) return m.interactiveMessageTemplate ? describe({ interactiveMessage: m.interactiveMessageTemplate }) : null;
      const text = lines(
        t?.hydratedTitleText,
        t?.hydratedContentText,
        t?.hydratedFooterText,
        offers((t?.hydratedButtons ?? []).map(templateButton)),
      );
      return withHead(t, text, quoted);
    }
    case 'buttonsMessage': {
      const text = lines(m.text, m.contentText, m.footerText, offers((m.buttons ?? []).map((b) => b?.buttonText?.displayText)));
      return withHead(m, text, quoted);
    }
    case 'interactiveMessage': {
      const text = lines(
        m.header?.title,
        m.header?.subtitle,
        m.body?.text,
        m.footer?.text,
        offers((m.nativeFlowMessage?.buttons ?? []).map(flowButton)),
      );
      return withHead(m.header, text, quoted);
    }
    case 'listMessage': {
      const rows = (m.sections ?? []).flatMap((sec) => (sec.rows ?? []).map((r) => [r.title, r.description].filter(Boolean).join(': ')));
      const text = lines(m.title, m.description, m.footerText, offers(rows));
      return text ? { type: 'text', text, quoted, link: linkOf(null, text) } : null;
    }
    // What was chosen from such a message: the answer, as the words on the button.
    case 'templateButtonReplyMessage':
    case 'buttonsResponseMessage': {
      const text = m.selectedDisplayText || null;
      return text ? { type: 'text', text, quoted } : null;
    }
    case 'listResponseMessage': {
      const text = lines(m.title, m.description);
      return text ? { type: 'text', text, quoted } : null;
    }
    case 'interactiveResponseMessage': {
      const text = m.body?.text || null;
      return text ? { type: 'text', text, quoted } : null;
    }
    case 'groupInviteMessage': {
      const text = lines(m.groupName && `Invitation to the group "${m.groupName}"`, m.caption);
      return text ? { type: 'text', text, quoted } : null;
    }
    case 'productMessage': {
      const text = lines(m.product?.title, m.product?.description, m.body, m.footer);
      return text ? { type: 'text', text, quoted, link: linkOf(null, text) } : null;
    }
    case 'orderMessage': {
      const text = lines(m.orderTitle, m.message);
      return text ? { type: 'text', text, quoted } : null;
    }
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
