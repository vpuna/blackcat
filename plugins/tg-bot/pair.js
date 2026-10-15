import { botOptions } from './api.js';
import crypto from 'node:crypto';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import qrcode from 'qrcode-terminal';
import { Bot } from 'grammy';
import { errMsg, prompts, useChannelIfNone } from '../../src/api.js';

// (The prompt library is loaded only by commands that ask questions in a terminal.)
const { orExit } = await prompts();

const who = (u) => [u.first_name, u.last_name].filter(Boolean).join(' ') + (u.username ? ` (@${u.username})` : '');

const TOKEN_RE = /^\d+:[A-Za-z0-9_-]{30,}$/;
const PAIR_TIMEOUT_MS = 5 * 60_000;

// Keep `owner` (who the core sends to) in step with the paired accounts: the first of them.
export const ownerOf = (allow) => (allow?.[0] ? { chat: allow[0].id, name: allow[0].name } : null);

export async function pair(ctx) {
  p.intro(pc.bgMagenta(pc.black(' blackcat · telegram pairing ')));

  let token = ctx.secrets.get('token');
  if (token && !orExit(await p.confirm({ message: `Use the saved bot token (…${token.slice(-4)})?` }))) {
    token = undefined;
  }
  if (!token) {
    p.note('In Telegram, open @BotFather → /newbot → copy the token it gives you.', 'Need a bot token');
    token = orExit(
      await p.password({
        message: 'Bot token',
        validate: (v) => (TOKEN_RE.test(v?.trim() ?? '') ? undefined : "That doesn't look like a bot token"),
      }),
    ).trim();
  }

  const bot = new Bot(token, botOptions());
  const s = p.spinner();
  s.start('Checking token');
  let me;
  try {
    me = await bot.api.getMe();
  } catch (e) {
    s.error('Token check failed');
    p.cancel(errMsg(e));
    process.exit(1);
  }
  s.stop(`Bot is ${pc.cyan('@' + me.username)}`);
  ctx.secrets.set('token', token);
  ctx.config.set({ bot: me.username, botId: me.id });

  const code = crypto.randomInt(100000, 1000000).toString();
  const link = `https://t.me/${me.username}?start=${code}`;
  qrcode.generate(link, { small: true }, (qr) => {
    p.note(`${qr}\nScan with your phone, or open ${pc.cyan(link)}\nor send ${pc.bold(code)} to @${me.username}`, 'Pair your phone');
  });

  s.start('Waiting for your message (5 min)');
  let from, chatId;
  try {
    ({ from, chatId } = await waitForCode(bot, code));
  } catch (e) {
    s.error('Pairing failed');
    p.cancel(errMsg(e));
    process.exit(1);
  }
  s.stop(`Code received from ${pc.cyan(who(from))}`);

  const ok = await p.confirm({ message: `Allow ${who(from)} (id ${from.id}) to talk to blackcat?` });
  if (p.isCancel(ok) || !ok) {
    await bot.api.sendMessage(chatId, 'Pairing was declined.').catch(() => {});
    p.cancel('Not paired');
    process.exit(1);
  }

  const allow = (ctx.config.get().allow ?? [])
    .filter((u) => u.id !== from.id)
    .concat({ id: from.id, name: who(from), pairedAt: new Date().toISOString() });
  ctx.config.set({ allow, owner: ownerOf(allow) });
  // With no channel in use yet, this becomes it. (Another one in use is left alone: bc channel use tg-bot.)
  const made = await useChannelIfNone('tg-bot');

  await bot.api.sendMessage(chatId, '🐈‍⬛ Paired! blackcat will answer you here.');
  p.outro(
    made
      ? `Paired, and Telegram is now how blackcat talks to you. Start it with ${pc.cyan('bc service install')} (or, if it is installed, ${pc.cyan('bc restart agent')}).`
      : `Paired. Another channel is in use: make Telegram the one with ${pc.cyan('bc channel use tg-bot')}.`,
  );
}

// Long-poll directly rather than via bot.start() so we can stop cleanly
// on the first matching message. Messages that don't carry the code get
// no reply, so strangers can't probe the bot.
async function waitForCode(bot, code) {
  await bot.api.deleteWebhook();

  // Skip anything sent to the bot before pairing started.
  let offset = 0;
  const old = await bot.api.getUpdates({ offset: -1, timeout: 0 });
  if (old.length) offset = old.at(-1).update_id + 1;

  const deadline = Date.now() + PAIR_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const updates = await bot.api.getUpdates({ offset, timeout: 25, allowed_updates: ['message'] });
    for (const u of updates) {
      offset = u.update_id + 1;
      const m = u.message;
      if (!m?.text || m.chat.type !== 'private') continue;
      const text = m.text.trim();
      if (text === code || text === `/start ${code}`) {
        // Acknowledge so the update isn't redelivered to `bc tg bot run`.
        await bot.api.getUpdates({ offset, timeout: 0 });
        return { from: m.from, chatId: m.chat.id };
      }
    }
  }
  throw new Error('Timed out — no code received.');
}
