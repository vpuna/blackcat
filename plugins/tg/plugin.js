// Your own Telegram account: a read-only source for your chats, the same idea as
// the WhatsApp one. (The bot you talk to blackcat through is separate: bc tg bot …)
import { describeTga, isLinked, wanted } from './paired.js';
import { withDb } from '../../src/api.js';

const cmd = () => import('./commands.js');

export default {
  api: 1,
  name: 'tg',
  mount: 'tg account',
  default: true,
  title: 'Telegram account',
  // Its own, and private: the agent is kept from it by name, whether or not the plugin is switched on.
  privateData: ['tg-account'],
  description: 'collects the chats of your own Telegram account into the archive, read-only (it can never send)',
  help: `Setup:
  bc tg account pair      log in (needs api_id and api_hash from https://my.telegram.org), choose chats
  bc tg account select    change how far back to keep, and which chats

Searching and reading what it collected is done with the archive's own commands:
  bc msg find <question> --source tg · bc msg chats --source tg

blackcat's own bot is never collected. Other bots, channels and groups over 500 members
are left out unless you choose them.
`,

  commands: {
    pair: {
      summary: 'log in to your Telegram account and choose what to collect',
      access: 'owner',
      interactive: true,
      run: async () => (await cmd()).pair(),
    },
    select: {
      summary: 'choose how many days back, and which chats',
      access: 'owner',
      interactive: true,
      run: async () => (await cmd()).select(),
    },
    status: {
      summary: 'link, service, what is kept, history progress',
      access: 'allow',
      untrusted: false,
      run: async (_c, i) => (await cmd()).status(i),
    },
    unpair: {
      summary: 'log out (optionally delete stored Telegram messages)',
      access: 'owner',
      interactive: true,
      run: async () => (await cmd()).unpair(),
    },
    run: {
      summary: 'run the service in the foreground (the tg service runs this)',
      access: 'owner',
      hidden: true,
      run: async () => (await cmd()).run(),
    },
  },

  // Telegram as a source of messages in the archive.
  source: {
    id: 'tg',
    label: 'Telegram',
    connected: () => isLinked(),
    // The kinds of chat you keep (bc tg account select): bots, channels and very large groups are off unless chosen.
    collects: (ref, db) => {
      const i = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'chat_info'").get()
        ? db.prepare('SELECT kind, members FROM chat_info WHERE ref = ?').get(ref)
        : null;
      return wanted(ref, i?.kind ?? 'user', i?.members);
    },
    fetchMedia: async (_ctx, { dest, id }) => (await import('./media.js')).fetchTelegramMedia(id, dest),
  },

  services: [
    {
      id: 'tg',
      summary: 'Telegram account source (read-only)',
      command: 'run',
      ready: () => (isLinked() ? null : 'Telegram account not linked → bc tg account pair'),
      health: async () => {
        const { ARCHIVE_DB: DB_PATH, archiveMeta: getMeta } = await import('../../src/api.js');
        const fs = await import('node:fs');
        if (!fs.existsSync(DB_PATH)) return null;
        const { openArchive: open } = await import('../../src/api.js');
        const m = withDb(open, (db) => getMeta(db));
        return m.tg_state === 'logged_out' ? 'Telegram has ended this login. Log in again with `bc tg account pair` on this machine' : null;
      },
    },
  ],

  // `bc selftest`: is it linked, and what the service that reads it last said of itself. (Read from the archive: Telegram itself is not asked anything.)
  selftest: () => [
    {
      name: 'your Telegram account',
      run: async () => {
        if (!isLinked()) return { skip: 'not linked (bc tg account pair)' };
        const { openArchive, archiveMeta, withDb, ago } = await import('../../src/api.js');
        const m = withDb(openArchive, (db) => archiveMeta(db));
        if (m.tg_state !== 'connected') throw new Error(`linked, and the service says it is ${m.tg_state ?? 'not started'}: bc logs tg`);
        return `linked · connected${m.tg_last_message_at ? ` · last message stored ${ago(Number(m.tg_last_message_at))}` : ''}`;
      },
    },
  ],

  status: () => (isLinked() ? `linked · keeping ${describeTga()}` : 'not linked → bc tg account pair'),

  settings: async () => {
    const { tgaSettings } = await import('./paired.js');
    const t = tgaSettings();
    const inc = t.include ?? {};
    return {
      keep: t.days ? `the last ${t.days} days` : 'all history',
      chats: t.mode === 'selected' ? `${t.chats?.length ?? 0} chosen chats` : 'private chats and groups',
      'other bots': inc.bots ? 'yes' : 'no',
      channels: inc.channels ? 'yes' : 'no',
      'groups over 500 members': inc.big ? 'yes' : 'no',
      'change them': 'bc tg account select',
    };
  },

  agent: {
    // The agent reads Telegram through `blackcat msg`; listing these twice would only confuse it.
    listCommands: false,
    fill: () => ({ ready: isLinked(), keeping: describeTga() }),
  },
};
