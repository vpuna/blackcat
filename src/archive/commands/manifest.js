// The archive's own commands: searching and reading the messages every source brings in,
// by keyword and by meaning, and fetching their files on demand. Part of the framework, not
// a plugin: there is one archive and one way to ask it. It is described the way a plugin is
// (a manifest), so its commands, the agent's instructions and its index job are wired up by
// the same machinery, and it is present whenever there is something to search.
import fs from 'node:fs';
import { HELP, fileCommands, queryCommands } from './queries.js';
import { ARCHIVE_DB, load, MEDIA_DIR, semantic, source, SOURCES } from '../../internal.js';
import { withDb } from '../../db.js';
import { reading as readingNow, somethingToRead } from '../reading.js';
import { plural } from '../../util/format.js';

// (Nothing to listen with, nothing is waiting.)

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
    setup: {
      summary: 'who reads the files that come with messages: voice notes, pictures, documents',
      access: 'owner',
      form: [
        {
          type: 'note',
          message:
            'The files that come with your messages are read when they arrive, so that a search finds what they say and your watches read it. For each kind you choose who reads it: this machine (nothing leaves it), the model, or this machine first and the model only when its reading is not sure enough.',
        },
        ...[
          ['voice', 'Voice notes'],
          ['pictures', 'Pictures (the text in them)'],
          ['documents', 'Documents (PDFs, Word and text files)'],
        ].map(([id, label]) => ({
          id,
          type: 'select',
          sticky: true,
          message: label,
          help: `${label.toLowerCase()}: off, local, model or both`,
          default: () => readingNow(id).mode,
          options: [
            { value: 'both', label: 'This machine first, the model when unsure' },
            { value: 'local', label: 'This machine only' },
            { value: 'model', label: 'The model only' },
            { value: 'off', label: 'Not read' },
          ],
        })),
        ...[
          [
            'pictureLevel',
            'pictures',
            'Pictures: under what score (0 to 100) is this machine not sure enough, so that the model is asked?',
          ],
          ['documentLevel', 'documents', 'Documents: and for a page that is a picture?'],
        ].map(([id, kind, message]) => ({
          id,
          type: 'text',
          sticky: true,
          message,
          help: `${kind}: the level under which the model is asked, 0 to 100`,
          default: () => String(readingNow(kind).level),
          when: (a) => (a[kind] ?? readingNow(kind).mode) === 'both',
          validate: (v) => (/^\d{1,3}$/.test(String(v).trim()) && Number(v) <= 100 ? undefined : 'A whole number from 0 to 100'),
        })),
      ],
      run: async (_ctx, a) => {
        const R = await import('../reading.js');
        for (const kind of ['voice', 'pictures', 'documents']) if (a[kind] != null) R.setReading(kind, { mode: a[kind] });
        if (a.pictureLevel != null && a.pictureLevel !== '') R.setReading('pictures', { level: Number(a.pictureLevel) });
        if (a.documentLevel != null && a.documentLevel !== '') R.setReading('documents', { level: Number(a.documentLevel) });
        const say = {
          both: 'this machine first, the model when unsure',
          local: 'this machine only',
          model: 'the model only',
          off: 'not read',
        };
        return `Voice notes: ${say[R.reading('voice').mode]}. Pictures: ${say[R.reading('pictures').mode]}. Documents: ${say[R.reading('documents').mode]}.\nHow it stands, and what is waiting: bc msg reading`;
      },
    },
    reading: {
      summary:
        'the files that come with messages (voice notes, pictures, documents) are read as they arrive, so that a search finds what they say and whatever reads a chat sees it: say how that stands, choose what reads each kind, read what is waiting now, or show how one was read',
      access: 'owner',
      options: [
        ['--voice <mode>', 'voice notes: off, local (on this machine), model, or both (this machine, and the model when unsure)'],
        ['--pictures <mode>', 'pictures: off, local, model, or both'],
        [
          '--picture-level <n>',
          'with both: a picture this machine is less sure of than this, 0 to 100, is given to the model (60 unless set)',
        ],
        ['--documents <mode>', 'PDFs, Word and text files: off, local, model, or both'],
        [
          '--document-level <n>',
          'with both: a page that is a picture, read less surely than this, 0 to 100, is given to the model (90 unless set)',
        ],
        ['--now', 'read what is waiting, without waiting for the next minute'],
        ['--show <message-id>', "how one message's file was read: by what, how sure, and what came of it"],
        [
          '--stats',
          'how reading has gone: how many were read by what, how sure this machine was, what the model used, and what another level would do',
        ],
        ['--since <time>', 'with --stats: how far back, e.g. 24h, 7d or 2026-10-01 (7d unless given)'],
      ],
      run: async (ctx, i) => {
        const R = await import('../reading.js');
        for (const kind of ['voice', 'pictures', 'documents']) {
          if (i[kind] == null) continue;
          if (!R.MODES.includes(i[kind])) ctx.fail(`--${kind} is one of: ${R.MODES.join(', ')}.`);
          R.setReading(kind, { mode: i[kind] });
        }
        for (const [flag, kind] of [
          ['pictureLevel', 'pictures'],
          ['documentLevel', 'documents'],
        ]) {
          if (i[flag] == null) continue;
          const n = Number(i[flag]);
          if (!Number.isInteger(n) || n < 0 || n > 100)
            ctx.fail(`--${kind === 'pictures' ? 'picture' : 'document'}-level is a whole number from 0 to 100.`);
          R.setReading(kind, { level: n });
        }
        if (i.stats) {
          const { parseTime } = await import('../query.js');
          let from;
          try {
            from = parseTime(String(i.since ?? '7d'));
          } catch (e) {
            ctx.fail(e.message);
          }
          const st = R.readingStats(from);
          return { text: R.statsText(st, i.since ? `since ${i.since}` : 'the last 7 days'), data: st };
        }
        if (i.show) {
          const { noteFor, openNotesDb } = await import('../attachments.js');
          const n = withDb(openNotesDb, (db) => noteFor(db, i.show));
          const raw = withDb(openNotesDb, (db) =>
            db
              .prepare(
                'SELECT status, attempts, created_ts, by, score, kind, level, local_ms, model_ms, local_note FROM attachment_notes WHERE msg_id = ?',
              )
              .get(i.show),
          );
          if (!raw)
            return {
              text: `Nothing has been read for ${i.show} (it has no file, the file is of a kind that is not read, or it is still waiting).`,
              data: { read: false },
            };
          const how =
            raw.status === 'ok'
              ? 'read'
              : raw.status === 'empty'
                ? 'read: nothing in it to read'
                : raw.status === 'unreadable'
                  ? 'could not be read'
                  : `failed (tried ${plural(raw.attempts, 'time')})`;
          const by = { local: 'on this machine', model: 'by the model', both: 'by the model, after this machine was not sure enough' }[
            raw.by
          ];
          const sure = raw.score != null ? ` · this machine was sure to ${raw.score} of 100` : '';
          const against = raw.score != null && raw.level != null ? ` (the level was ${raw.level})` : '';
          const took = [
            raw.local_ms != null ? `${(raw.local_ms / 1000).toFixed(1)} s here` : null,
            raw.model_ms != null ? `${(raw.model_ms / 1000).toFixed(1)} s by the model` : null,
          ]
            .filter(Boolean)
            .join(', ');
          const here = raw.local_note ? `\n\nWhat this machine read:\n${raw.local_note}` : '';
          return {
            text: `${i.show}: ${how}${by ? ` · ${by}` : ''}${sure}${against}${took ? ` · ${took}` : ''}\n${n?.note ?? ''}${here}`.trim(),
            data: { read: raw.status === 'ok', ...raw, note: n?.note ?? null },
          };
        }
        let did = '';
        if (i.now) {
          const tally = {};
          const r = await R.readNow({ tally });
          const said = r.off ? '' : R.tallyText(tally, r.left) || 'Nothing was waiting';
          did = said ? `${said[0].toUpperCase()}${said.slice(1)}.\n` : '';
        }
        const count = fs.existsSync(DB) ? R.waitingCount() : { voice: 0, pictures: 0, documents: 0 };
        const left = (n) => (n ? `${n} waiting.` : 'None is waiting.');
        const state = (kind) => ({ ...R.reading(kind), ...R.ways(kind), can: { local: !!R.localReader(kind), model: R.modelTakes(kind) } });
        const v = state('voice');
        const voice =
          v.mode === 'off'
            ? 'not read (switched off). Switch it on: bc msg reading --voice both'
            : v.mode === 'model' && !v.can.model
              ? 'set to be read by the model, but the model in use cannot take audio, so they are not read. On this machine: bc msg reading --voice local'
              : !v.can.local && !v.model
                ? 'would be listened to, but nothing here can listen: switch the voice plugin on (bc plugin enable voice)'
                : `listened to as they arrive, on this machine${v.mode === 'both' && !v.can.model ? ' (the model in use cannot take audio, so one that was hard to make out stays as it was heard)' : ''}. ${left(count.voice)}`;
        const p = state('pictures');
        const pictures =
          p.mode === 'off'
            ? 'not read (switched off). Switch it on: bc msg reading --pictures both'
            : p.mode === 'model'
              ? p.can.model
                ? `every one is read by the model. ${left(count.pictures)}`
                : 'set to be read by the model, but the model in use cannot take pictures, so they are not read'
              : !p.can.local
                ? 'would be read on this machine, but nothing here can read them: install Tesseract (sudo apt install tesseract-ocr), or have the model read every one (bc msg reading --pictures model)'
                : p.mode === 'local'
                  ? `the text in them is read as they arrive, on this machine only. ${left(count.pictures)}`
                  : p.can.model
                    ? `the text in them is read as they arrive, on this machine; one it is sure of to less than ${p.level} of 100 is given to the model. ${left(count.pictures)}`
                    : `the text in them is read as they arrive, on this machine (the model in use cannot take pictures, so an unsure one stays as it was read). ${left(count.pictures)}`;
        const d = state('documents');
        const scans = !p.can.local
          ? ' A page that is a picture is not read: nothing here reads pictures.'
          : d.mode === 'both' && p.can.model
            ? ` A page that is a picture is read as pictures are; one read less surely than ${d.level} of 100 is given to the model. A document too long to be shown whole is noted by the model.`
            : ' A page that is a picture is read as pictures are, on this machine.';
        const documents =
          d.mode === 'off'
            ? 'not read (switched off). Switch it on: bc msg reading --documents both'
            : d.mode === 'model'
              ? d.can.model
                ? `every one is given to the model whole. ${left(count.documents)}`
                : 'set to be read by the model, but the model in use cannot take documents, so they are not read'
              : !d.can.local
                ? 'would be read on this machine, but nothing here can read them: switch the docs plugin on (bc plugin enable docs)'
                : `their text is taken out as they arrive, on this machine${d.mode === 'local' ? ' only' : ''}.${scans} ${left(count.documents)}`;
        return {
          text: `${did}Voice notes: ${voice}\nPictures: ${pictures}\nDocuments: ${documents}`,
          data: {
            voice: { ...v, waiting: count.voice },
            pictures: { ...p, waiting: count.pictures },
            documents: { ...d, waiting: count.documents },
          },
        };
      },
    },
  },

  jobs: [
    {
      id: 'read',
      cron: '* * * * *', // every minute
      summary:
        'read the files that have just arrived with messages (voice notes are written down, the text in pictures and documents is read)',
      // (Asked every few seconds, in the agent's own process: a few short reads, and nearly
      // always no. Only when a file is waiting is anything started.)
      when: () => fs.existsSync(DB) && somethingToRead(),
      run: async () => {
        const R = await import('../reading.js');
        const tally = {};
        const r = await R.readNow({ tally });
        const did = r.off ? '' : R.tallyText(tally, r.left);
        return did ? { did } : { idle: true };
      },
    },
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
          ? { did: `${plural(r.embedded, 'conversation')} indexed${r.left ? `, ${r.left} left for the next run` : ''}` }
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
  trials: [
    { say: 'did maya say anything about dinner this week', expect: /blackcat msg (find|search|thread)\b/ },
    { say: 'remind me about the last thing maya sent, in 2 hours', expect: /blackcat msg (thread|find|search)\b/ },
  ],
  agent: {
    // Media fetched on demand lands here. It is the only part of data/ the agent may read.
    readDirs: () => [MEDIA_DIR],
  },
};
