// The receiving half: the Telegram bot itself. It lets through only what a paired account
// writes in a private chat, keeps the files it is sent, and hands everything to blackcat.
import { errMsg, INBOX_MAX_BYTES, keepFile, log, recordActivity, size, sleep } from '../../src/api.js';

const ignored = new Map(); // account id → when it was last noted
import { API_ROOT, botOptions } from './api.js';
import { carrierFor } from './carrier.js';

const underSystemd = !!process.env.BLACKCAT_SERVICE; // (run in the background by blackcat, not in a terminal)

// Who a forwarded message came from, or null when the owner wrote it themselves.
// (via_bot: text produced by another bot's inline mode is not the owner's own either.)
function forwardedFrom(m) {
  const o = m.forward_origin;
  if (o)
    return o.sender_user
      ? [o.sender_user.first_name, o.sender_user.last_name].filter(Boolean).join(' ') || 'someone'
      : (o.sender_user_name ?? o.sender_chat?.title ?? o.chat?.title ?? 'someone else');
  if (m.forward_from || m.forward_from_chat || m.forward_sender_name || m.forward_date)
    return m.forward_from?.first_name ?? m.forward_from_chat?.title ?? m.forward_sender_name ?? 'someone else';
  if (m.via_bot) return `the bot @${m.via_bot.username ?? 'unknown'}`;
  return null;
}

// What a message carries, if anything: { fileId, name, kind, size, note }.
function attachmentOf(m) {
  if (m.photo?.length) {
    const p = m.photo.at(-1); // the largest size
    return { fileId: p.file_id, name: 'photo.jpg', kind: 'image', size: p.file_size };
  }
  if (m.document)
    return {
      fileId: m.document.file_id,
      name: m.document.file_name ?? 'document',
      kind: /^image\//.test(m.document.mime_type ?? '') ? 'image' : 'document',
      size: m.document.file_size,
    };
  if (m.voice)
    return { fileId: m.voice.file_id, name: 'voice.ogg', kind: 'voice note', size: m.voice.file_size, note: `${m.voice.duration}s` };
  if (m.audio)
    return {
      fileId: m.audio.file_id,
      name: m.audio.file_name ?? 'audio.mp3',
      kind: 'audio',
      size: m.audio.file_size,
      note: `${m.audio.duration}s`,
    };
  if (m.video)
    return {
      fileId: m.video.file_id,
      name: m.video.file_name ?? 'video.mp4',
      kind: 'video',
      size: m.video.file_size,
      note: `${m.video.duration}s`,
    };
  if (m.video_note) return { fileId: m.video_note.file_id, name: 'video-note.mp4', kind: 'video', size: m.video_note.file_size };
  if (m.animation)
    return { fileId: m.animation.file_id, name: m.animation.file_name ?? 'animation.mp4', kind: 'video', size: m.animation.file_size };
  if (m.sticker) return { fileId: m.sticker.file_id, name: 'sticker.webp', kind: 'sticker', size: m.sticker.file_size };
  return null;
}

// Fetch a message's attachment and keep it. → what was kept, or { error }.
async function receive(c, token) {
  const a = attachmentOf(c.message);
  if (a.size > INBOX_MAX_BYTES) return { error: `${a.name} is ${size(a.size)}; Telegram only lets me fetch files up to 20 MB.` };
  try {
    const info = await c.api.getFile(a.fileId);
    const res = await fetch(`${API_ROOT}/file/bot${token}/${info.file_path}`);
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    return await keepFile(a, Buffer.from(await res.arrayBuffer()), c.message.message_id);
  } catch (e) {
    log(`could not fetch a file from Telegram: ${e.message}`);
    return { error: `I couldn't fetch ${a.name} from Telegram (${e.message}).` };
  }
}

// Start the bot. `host` is blackcat: host.incoming(event) for what the owner wrote or sent,
// host.action(event) for a button tapped. → the carrier, with run() (until stopped) and stop().
export async function start(ctx, host) {
  const { Bot, GrammyError } = await import('grammy');
  const token = ctx.secrets.get('token');
  const bot = new Bot(token, botOptions());

  // Only paired accounts in private chats get through; everyone else is silently ignored.
  // The list is re-read each time, so `bc tg bot unpair` applies without a restart.
  bot.use(async (c, next) => {
    const allowed = ctx.config.get().allow ?? [];
    if (c.chat?.type === 'private' && allowed.some((u) => u.id === c.from?.id)) return next();
    log(`ignored update from ${c.from?.id ?? 'unknown'}`);
    // On the record too, once an hour for each account: someone who is not paired wrote to the bot.
    const who = String(c.from?.id ?? 'unknown');
    if (Date.now() - (ignored.get(who) ?? 0) > 3600_000) {
      ignored.set(who, Date.now());
      if (ignored.size > 500) ignored.clear();
      recordActivity({ kind: 'event', category: 'channel', ok: false, summary: `ignored an account that is not paired (id ${who})` });
    }
    return undefined;
  });

  // A message the owner FORWARDED was written by someone else: it must never reach a
  // command handler below as if they had typed it. Text goes straight to blackcat, marked;
  // a forwarded file is handled with the other files, marked the same way.
  bot.use(async (c, next) => {
    const m = c.message;
    const from = m && forwardedFrom(m);
    if (!from) return next();
    c.forwardedFrom = from;
    if (m.text == null) return next();
    return host.incoming({ chat: c.chat.id, who: c.from.first_name, ref: m.message_id, text: m.text, forwardedFrom: from, at: m.date });
  });

  // Plugins written for the Telegram bot itself (`telegram.install(bot)` in their manifest)
  // set their screens up here, before blackcat's own, as they always have.

  bot.on('callback_query:data', (c) =>
    host.action({
      chat: c.chat?.id ?? c.from.id,
      who: c.from.first_name,
      id: c.callbackQuery.data,
      // (What the button said, for the record of what the owner did.)
      label:
        (c.callbackQuery.message?.reply_markup?.inline_keyboard ?? []).flat().find((b) => b.callback_data === c.callbackQuery.data)?.text ??
        null,
      ref: c.callbackQuery.message?.message_id ?? null,
      token: c.callbackQuery.id,
    }),
  );
  bot.on('message:text', (c) =>
    host.incoming({ chat: c.chat.id, who: c.from.first_name, ref: c.message.message_id, text: c.message.text, at: c.message.date }),
  );

  // Photos, PDFs and other files: kept, and blackcat is told where they are. Several sent
  // together (an album) arrive as separate messages, so they are gathered for a moment
  // and passed on as one.
  const albums = new Map(); // media group id → { files, text, errors, timer }
  bot.on('message', async (c) => {
    const ev = {
      chat: c.chat.id,
      who: c.from.first_name,
      ref: c.message.message_id,
      at: c.message.date,
      ...(c.forwardedFrom ? { forwardedFrom: c.forwardedFrom } : {}),
    };
    if (!attachmentOf(c.message)) return host.incoming({ ...ev, unsupported: true });
    const got = await receive(c, token);
    const key = c.message.media_group_id ?? `single:${c.message.message_id}`;
    const g = albums.get(key) ?? { files: [], errors: [], text: '' };
    if (got.error) g.errors.push(got.error);
    else g.files.push(got);
    if (c.message.caption) g.text = c.message.caption;
    clearTimeout(g.timer);
    albums.set(key, g);
    g.timer = setTimeout(
      () => {
        albums.delete(key);
        Promise.resolve(host.incoming({ ...ev, text: g.text, files: g.files, errors: g.errors })).catch((e) => log(`error: ${errMsg(e)}`));
      },
      c.message.media_group_id ? 1500 : 0,
    );
    return undefined;
  });

  bot.catch((err) => log(`error: ${errMsg(err.error)}`));

  // At boot the network may not be up yet. Keep trying rather than giving up, except on a
  // bad token, which retrying can't fix.
  for (let delay = 5; ; delay = Math.min(delay * 2, 60)) {
    try {
      await bot.init();
      break;
    } catch (e) {
      if (e instanceof GrammyError && e.error_code === 401) throw new Error(errMsg(e));
      log(`can't reach Telegram (${errMsg(e)}), retrying in ${delay}s`);
      await sleep(delay * 1000);
    }
  }

  return {
    ...carrierFor(bot.api),
    native: bot, // for plugins that still draw their screens with the Telegram bot itself
    // Receive until stopped.
    run: () =>
      bot.start({
        allowed_updates: ['message', 'callback_query'],
        onStart: (me) =>
          log(
            `@${me.username} running · paired: ${(ctx.config.get().allow ?? []).map((u) => u.name).join(', ')}${underSystemd ? '' : ' · Ctrl+C to stop'}`,
          ),
      }),
    stop: () => bot.stop(),
  };
}
