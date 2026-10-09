// How blackcat's messages become Telegram's: the sending half of the channel. Used by the
// running bot, and by any command or job that has something to tell the owner.
import fs from 'node:fs';
import path from 'node:path';
import { botOptions } from './api.js';

const MAX_PHOTO_BYTES = 10 * 1024 ** 2; // larger images must go as documents

export const CAN = { buttons: true, edit: true, files: true, voice: true, html: true, maxChars: 4000, maxFileBytes: 50 * 1024 ** 2 };

// Rows of actions → Telegram's inline keyboard.
const keyboard = (rows) =>
  rows ? { inline_keyboard: rows.map((r) => r.map((a) => ({ text: a.label, callback_data: a.id }))) } : undefined;
// A message → the options Telegram takes with its text. Only what is set is sent.
const options = (m) => ({
  ...(m.html ? { parse_mode: 'HTML' } : {}),
  ...(m.actions ? { reply_markup: keyboard(m.actions) } : {}),
  ...(m.preview ? {} : { link_preview_options: { is_disabled: true } }),
});
const ACTION = { typing: 'typing', file: 'upload_document', photo: 'upload_photo' };

// `api`: grammY's Api for the bot.
export function carrierFor(api) {
  return {
    label: 'Telegram',
    can: CAN,
    send: async (chat, m) => (await api.sendMessage(chat, m.text, options(m))).message_id,
    edit: async (chat, ref, m) => void (await api.editMessageText(chat, ref, m.text, options(m))),
    setActions: async (chat, ref, rows) => void (await api.editMessageReplyMarkup(chat, ref, { reply_markup: keyboard(rows) })),
    remove: async (chat, ref) => void (await api.deleteMessage(chat, ref)),
    // A tap is acknowledged with the id Telegram gave it.
    toast: async (ev, text) => void (await api.answerCallbackQuery(ev.token, text ? { text } : undefined)),
    working: async (chat, kind) => void (await api.sendChatAction(chat, ACTION[kind] ?? kind ?? 'typing')),
    async sendFile(chat, file, { caption } = {}) {
      const { InputFile } = await import('grammy');
      const { size } = fs.statSync(file);
      const input = new InputFile(file);
      const ext = path.extname(file).toLowerCase();
      const opts = caption ? { caption } : {};
      if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext) && size <= MAX_PHOTO_BYTES) await api.sendPhoto(chat, input, opts);
      else if (['.mp4', '.mov'].includes(ext)) await api.sendVideo(chat, input, opts);
      else await api.sendDocument(chat, input, opts);
    },
    setMenu: async (commands) => void (await api.setMyCommands(commands)),
  };
}

// For sending only: no polling, nothing received.
export async function open(token) {
  const { Bot } = await import('grammy');
  const bot = new Bot(token, botOptions());
  return { ...carrierFor(bot.api), native: bot };
}
