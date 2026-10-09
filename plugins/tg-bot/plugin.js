// The Telegram bot: one of the ways blackcat talks to you (a channel). It carries what you
// write and tap to blackcat, and what blackcat says back to you; it decides nothing itself.
// Separate from the `tg` plugin, which reads your own Telegram account into the archive.
import { explainErrors } from '../../src/api.js';

const bot = () => import('./bot.js');
const carrier = () => import('./carrier.js');

const paired = (ctx) => ctx.secrets.has('token') && (ctx.config.get().allow ?? []).length > 0;

// Telegram's own errors, in a sentence. (Recognised by name, so the library is not loaded just to describe one.)
explainErrors((e) => {
  if (e?.name !== 'GrammyError') return null;
  if (e.error_code === 401) return 'Telegram rejected the token (401 Unauthorized).';
  if (e.error_code === 409)
    return 'Another program is already reading this bot (is `bc tg bot run` or another Telegram program using the same bot running?). Stop it and try again.';
  return `Telegram error ${e.error_code}: ${e.description}`;
});

export default {
  api: 1,
  name: 'tg-bot',
  mount: 'tg bot',
  title: 'Telegram bot',
  description: 'talk to blackcat through a Telegram bot of your own: messages, buttons, files and voice notes',
  default: true,
  help: `Examples:
  bc tg bot pair        connect a bot from @BotFather and pair your Telegram account (scan a QR code)
  bc tg bot test        check the bot token and list paired accounts
  bc tg bot unpair      choose paired accounts to remove
  bc channel            which channel blackcat talks to you through`,

  commands: {
    pair: {
      summary: 'connect a @BotFather token and pair your Telegram account (scan a QR code)',
      access: 'owner',
      interactive: true,
      run: async (ctx) => (await import('./pair.js')).pair(ctx),
    },
    unpair: {
      summary: 'choose paired accounts to remove',
      access: 'owner',
      interactive: true,
      run: async (ctx) => (await import('./manage.js')).unpair(ctx),
    },
    test: {
      summary: 'test the bot token and list paired accounts',
      access: 'owner',
      interactive: true,
      run: async (ctx) => (await import('./manage.js')).status(ctx),
    },
    // (What the agent service ran before channels: `bc tg bot run`. Kept so a service
    // installed then still starts. It starts the agent, with whichever channel is in use.)
    run: {
      summary: 'start the agent in this terminal (the same as: bc agent run)',
      access: 'owner',
      hidden: true,
      run: async (ctx) => ctx.api.runAgent(),
    },
  },

  channel: {
    label: 'Telegram',
    can: { buttons: true, edit: true, files: true, voice: true, html: true, maxChars: 4000, maxFileBytes: 50 * 1024 ** 2 },
    paired,
    // The bot, as the owner's own Telegram account sees it: that chat is never collected.
    self: (ctx) => (ctx.config.get().botId ? [`tg:${ctx.config.get().botId}`] : []),
    open: async (ctx) => (await carrier()).open(ctx.secrets.get('token')),
    start: async (ctx, host) => (await bot()).start(ctx, host),
  },

  // `bc selftest`: Telegram asked who the bot is, which says the token is good. Nothing is sent.
  selftest: (ctx) => [
    {
      name: ctx.config.get().bot ? `@${ctx.config.get().bot}` : 'the bot',
      run: async () => {
        const token = ctx.secrets.get('token');
        if (!token) return { skip: 'no bot is paired (bc tg bot pair)' };
        const { Bot } = await import('grammy');
        const { botOptions } = await import('./api.js');
        const me = await new Bot(token, botOptions()).api.getMe();
        const paired = (ctx.config.get().allow ?? []).length;
        if (!paired) throw new Error(`@${me.username} answers, and no account is paired with it (bc tg bot pair)`);
        return `@${me.username} answers · the token is good · paired with ${paired} account${paired === 1 ? '' : 's'}`;
      },
    },
  ],

  status: (ctx) => {
    const c = ctx.config.get();
    if (!ctx.secrets.has('token')) return 'not set up → bc tg bot pair';
    const n = (c.allow ?? []).length;
    return `@${c.bot ?? 'bot'} · ${n ? `${n} paired` : 'nobody paired yet → bc tg bot pair'}`;
  },
  settings: (ctx) => {
    const c = ctx.config.get();
    return { bot: c.bot ? `@${c.bot}` : 'not connected', 'paired accounts': (c.allow ?? []).map((u) => u.name).join(', ') || 'none' };
  },
};
