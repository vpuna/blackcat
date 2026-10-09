// The archive's own commands: searching and reading the messages every source brings in,
// by keyword and by meaning, and fetching their files on demand. Part of the framework, not
// a plugin: there is one archive and one way to ask it. It is described the way a plugin is
// (a manifest), so its commands, the agent's instructions and its index job are wired up by
// the same machinery, and it is present whenever there is something to search.
import fs from 'node:fs';
import { HELP, fileCommands, queryCommands } from './queries.js';
import { ARCHIVE_DB, load, MEDIA_DIR, semantic, source, SOURCES } from '../../internal.js';
import { withDb } from '../../db.js';

const DB = ARCHIVE_DB;

export default {
  api: 1,
  name: 'msg',
  // Present when the archive holds anything, or a source is set up to fill it. With neither
  // (blackcat used only for a home or a server, say) its commands and the agent's
  // instructions for them are simply not there.
  when: () => fs.existsSync(DB) || Object.keys(SOURCES).some((id) => source(id)?.connected?.()),
  title: 'Messages',
  description: 'search and read your message archive, across every source that is connected, by keyword or by meaning',
  help: `Examples:
  bc msg find when did we decide on the holiday --also "trip booking flights"
  bc msg search visa --chat Mum --since 30d
  bc msg thread Family --around <message-id>
  bc msg media <message-id>

${HELP}`,

  commands: {
    ...queryCommands(),
    ...fileCommands,
    index: {
      summary:
        'update the meaning-based search index (done automatically every 15 minutes, and before a search when new messages have arrived)',
      access: 'owner',
      options: [
        ['--rebuild', 'throw the index away and build it again (needed after changing the embedding model)'],
        ['--quiet', 'no output'],
      ],
      run: async (_ctx, i) => (await import('./commands.js')).index(i, {}),
    },
  },

  jobs: [
    {
      id: 'index',
      cron: '*/15 * * * *', // every fifteen minutes
      summary: 'keep the meaning-based search index up to date',
      when: () => fs.existsSync(DB),
      // Nearly every run finds nothing new and ends at once, before anything large is loaded.
      run: async () => {
        const r = await (await semantic()).index({ quiet: true, ifNeeded: true });
        if (!r || r.upToDate) return { idle: true };
        // (Cutting a chat into windows again with nothing new to work out is not worth a line.)
        return r.embedded
          ? { did: `${r.embedded} conversation${r.embedded === 1 ? '' : 's'} indexed${r.left ? `, ${r.left} left for the next run` : ''}` }
          : { idle: true };
      },
    },
  ],

  status: async () => {
    const { howToConnect } = await import('../sources.js');
    if (!fs.existsSync(DB)) return `no messages yet: connect ${howToConnect().join(' or ') || 'a source of messages (bc plugin list)'}`;
    const { openArchive: open, archiveStats: stats } = await import('../../internal.js');
    const { indexStats } = await semantic();
    // Each source that has anything, by what it is called.
    const counts = withDb(open, (db) =>
      Object.entries(SOURCES)
        .map(([id, label]) => [label, stats(db, id).messages])
        .filter(([, n]) => n > 0),
    );
    const ix = indexStats();
    return `${counts.length ? counts.map(([label, n]) => `${n} ${label}`).join(' + ') : 'no'} messages${ix?.model ? ` · search index ${ix.embedded}/${ix.windows} conversations` : ' · search index not built yet'}`;
  },

  settings: () => {
    const e = load().archive?.embedder ?? {};
    return { 'search model': e.model ?? 'Xenova/bge-small-en-v1.5', 'runs on': 'this machine' };
  },

  // For `bc engine check`: what the owner might say, and the command it should lead to.
  checks: [
    { say: 'did maya say anything about dinner this week', expect: /blackcat msg (find|search|thread)\b/ },
    { say: 'remind me about the last thing maya sent, in 2 hours', expect: /blackcat msg (thread|find|search)\b/ },
  ],
  agent: {
    // Media fetched on demand lands here. It is the only part of data/ the agent may read.
    readDirs: () => [MEDIA_DIR],
  },
};
