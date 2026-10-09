// WhatsApp: a read-only source. It links as a companion device, stores your messages
// in the archive, and never sends anything. Searching is done with the archive's own commands (bc msg …).
import fs from 'node:fs';
import { isPaired } from './paired.js';
import { describeSelection, waSettings } from './settings.js';
import { ARCHIVE_DB, withDb } from '../../src/api.js';

const cmd = () => import('./commands.js');
const DB = ARCHIVE_DB;

export default {
  api: 1,
  name: 'wa',
  default: true,
  title: 'WhatsApp',
  // Its own, and private: the agent is kept from it by name, whether or not the plugin is switched on.
  privateData: ['wa-auth'],
  description: 'collects your WhatsApp messages into the archive, read-only (it can never send)',
  help: `Setup:
  bc wa pair      link WhatsApp (QR code or link code), pull history, pick chats
  bc wa select    change how far back to keep, and which chats

Searching and reading what it collected is done with the archive's own commands:
  bc msg find <question> --source wa · bc msg chats --source wa
`,

  commands: {
    pair: {
      summary: 'link WhatsApp, receive history, and pick chats',
      access: 'owner',
      interactive: true,
      run: async () => (await cmd()).pair(),
    },
    select: {
      summary: 'choose how many days back, and all chats or only picked ones',
      access: 'owner',
      interactive: true,
      run: async () => (await cmd()).select(),
    },
    status: {
      summary: 'link, service, what is kept, archive size',
      access: 'allow',
      untrusted: false,
      run: async (_c, i) => (await cmd()).status(i, {}),
    },
    unpair: {
      summary: 'unlink from WhatsApp (optionally delete stored messages)',
      access: 'owner',
      interactive: true,
      run: async () => (await cmd()).unpair(),
    },
    run: {
      summary: 'run the service in the foreground (the wa service runs this)',
      access: 'owner',
      hidden: true,
      run: async () => (await cmd()).run(),
    },
  },

  // WhatsApp as a source of messages in the archive. (Its ids have no prefix: it was the first.)
  source: {
    id: 'wa',
    label: 'WhatsApp',
    connected: () => isPaired(),
    // The chats you chose to keep (bc wa select).
    collects: (ref) => {
      const w = waSettings();
      return w.mode !== 'selected' || (w.chats ?? []).includes(ref);
    },
    fetchMedia: async (_ctx, { row, dest }) => (await import('./media.js')).fetchWhatsAppMedia(row, dest),
  },

  services: [
    {
      id: 'wa',
      summary: 'WhatsApp source (read-only)',
      command: 'run',
      ready: () => (isPaired() ? null : 'WhatsApp not linked → bc wa pair'),
      health: async () => {
        if (!fs.existsSync(DB)) return null;
        const { openArchive: open } = await import('../../src/api.js');
        const { archiveMeta: getMeta } = await import('../../src/api.js');
        const m = withDb(open, (db) => getMeta(db));
        if (m.state === 'logged_out') return 'WhatsApp has unlinked this device. Link it again with `bc wa pair` on this machine';
        const since = Number(m.disconnected_at) || 0;
        if (m.state === 'disconnected' && since && Date.now() / 1000 - since > 15 * 60)
          return `it has not been able to connect to WhatsApp for ${Math.round((Date.now() / 1000 - since) / 60)} minutes${m.last_error ? ` (${m.last_error})` : ''}`;
        return null;
      },
    },
  ],

  // `bc selftest`: is it linked, and what the service that reads it last said of itself. (Read from the archive: WhatsApp itself is not asked anything.)
  selftest: () => [
    {
      name: 'your WhatsApp account',
      run: async () => {
        if (!isPaired()) return { skip: 'not linked (bc wa pair)' };
        const { openArchive, archiveMeta, withDb, ago } = await import('../../src/api.js');
        const m = withDb(openArchive, (db) => archiveMeta(db));
        if (m.state !== 'connected')
          throw new Error(
            `linked, and the service says it is ${m.state ?? 'not started'}${m.last_error ? ` (${m.last_error})` : ''}: bc logs wa`,
          );
        return `linked · connected${m.last_message_at ? ` · last message stored ${ago(Number(m.last_message_at))}` : ''}`;
      },
    },
  ],

  status: () => {
    if (!isPaired())
      return fs.existsSync(DB) ? 'not linked (stored messages are still searchable) → bc wa pair' : 'not linked → bc wa pair';
    return `linked · keeping ${describeSelection()}`;
  },

  settings: async () => {
    const { waSettings } = await import('./settings.js');
    const w = waSettings();
    return {
      keep: w.days ? `the last ${w.days} days` : 'all history',
      chats: w.mode === 'selected' ? `${w.chats?.length ?? 0} chosen chats` : 'all chats',
      'change them': 'bc wa select',
    };
  },

  agent: {
    // The agent reads WhatsApp through `blackcat msg`; listing these twice would only confuse it.
    listCommands: false,
    fill: () => ({ ready: isPaired(), keeping: describeSelection() }),
  },
};
