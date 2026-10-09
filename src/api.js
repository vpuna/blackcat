// What a plugin may use from blackcat. A plugin imports from this file and from nowhere
// else in src/ (a test enforces it), so everything here is a promise: it keeps working the
// same way while the plugin `api` number in a manifest stays the same. Everything that
// depends on which plugin is asking (its settings, secrets, store, private folder,
// logging, the owner's chat) is on the `ctx` each command is given instead.
//
// What is NOT here, on purpose: any way to reach another plugin's settings, secrets or
// context, the whole settings file, blackcat's own database, the agent's standing
// permissions, or the path of the data folder as such. A plugin uses another through its
// commands (`ctx.command`, with `uses` in the manifest), and offers what the core or other
// plugins need by declaring it in its manifest. The core's own parts have more:
// src/internal.js, which a plugin may not import. (A plugin is still code you chose to
// run, as yourself: this keeps plugins from depending on each other's insides or
// trampling each other by mistake. It is not a wall against one written to do harm.)
//
// Kept light on purpose: importing this loads no large library. The parts that need one
// are functions that load it when called: `await semantic()`, `await prompts()`,
// `await serviceCommands()`.

// ---- your own settings and folders, for code that has no ctx in hand (pass import.meta.url)
export { dataPath, ownDataDir, settingsChangedAt, settingsFor } from './plugins/own.js';

// ---- logging, and the services you declare
export { log } from './log.js';
// (controlService('stop' | 'start' | 'restart', id): for a plugin that must have its service out of the way while an account is linked.)
export { controlService, isInstalled, service, show } from './service/units.js';

// ---- whose address is this: names that plugins know for addresses
export { nameOf, personLabel } from './plugins/people.js';

// ---- small helpers: times, sizes, text, running a command
export { ago, agoShort, clock, hm, isoLocal, now, ymd } from './util/time.js';
export { TimeError, fmtWhen, parseAt, parseDuration } from './util/when.js';
// Repeating schedules are cron everywhere. schedule() checks one, describeSchedule() says it in English, nextRuns() and scheduleDue() work out when.
export {
  ScheduleError,
  describe as describeSchedule,
  due as scheduleDue,
  fromEvery,
  fromTimes,
  nextRuns,
  schedule,
  storedSchedule,
} from './util/schedule.js';
export { errMsg, esc, explainErrors, size } from './util/format.js';
// Waiting (`await sleep(ms)`), and a path as a person writes it (`~/notes`).
export { sleep } from './util/wait.js';
export { expandHome, resolveHome } from './util/paths.js';
export { shell } from './util/run.js';
export { duration } from './system.js';
// Is this shell command one that only looks? → 'read' | 'sensitive' | 'change'
export { classify } from './util/readonly.js';
// Would this command show blackcat's own private files? (for a plugin that runs commands the agent gives it)
export { touchesSecrets } from './agent/policy.js';

// ---- the owner's chat: is there one, what may be sent, and its commands
export { hasBot } from './owner.js';
export { sendable } from './channels/files.js';
export { chatCommands, directCommands, refreshMenu } from './channels/commands.js';
export { actions, chunks, plain } from './channels/kit.js';
export { notifyOwner } from './channels/send.js';

// ---- the message archive: reading
export { DB_PATH as ARCHIVE_DB, getMeta as archiveMeta, setMeta as setArchiveMeta } from './archive/db.js';
export {
  QueryError,
  countChats,
  formatMessage,
  listChats,
  open as openArchive,
  parseTime,
  search as searchMessages,
  stats as archiveStats,
  thread as readThread,
} from './archive/query.js';
export { sourceSql } from './archive/sources.js';
export { MEDIA_DIR, downloadedPath, mediaPaths } from './archive/media.js';
// Search by meaning, and the index behind it (loads the embedding library): const { find, index, indexStats } = await semantic();
export const semantic = () => import('./archive/semantic.js');

// ---- the message archive: writing (for a plugin that declares a `source`)
export { openWrite as openArchiveForWriting } from './archive/db.js';
export { archiveStatements, mediaRow, messageRow } from './archive/writer.js';
// The chats that are blackcat itself (its bot, as your account sees it): never collected, never offered.
export { ownRefs } from './channels/registry.js';

// ---- a database of your own: open it, bring its shape up to date with an ordered list of
// steps (each run once), and be sure it is closed. See src/db.js. (A value or two that
// change with use need none of this: ctx.store.)
export { addColumns, hasColumn, hasTable, openSqlite, upgrade, withDb } from './db.js';

// ---- asking a model with no tools (for reading content written by other people); ctx.ask and ctx.reader are the same, with your plugin's name on them
export { askModel } from './agent/oneshot.js';

// ---- loaded when called
// Questions asked in a terminal: const { askDays, orExit } = await prompts();
export const prompts = () => import('./util/prompts.js');
// Installing and removing blackcat's services: const { installServices, removeServices, otherHome } = await serviceCommands();
export const serviceCommands = () => import('./service/commands.js');

// The activity record: add an entry of your own with
// recordActivity({ kind: 'event', category: 'my-plugin', summary: 'what happened' }). Never put message content in one.
export { record as recordActivity, serviceConnected } from './activity/log.js';

// ---- for a channel plugin: keeping a file the owner sent, running the agent, and becoming
// the channel in use
export { INBOX_MAX_BYTES, keep as keepFile } from './channels/inbox.js';
export const runAgent = async () => (await import('./agent/run.js')).run();
// Make a channel the one in use if none is yet (a channel plugin calls this when it is first paired).
export async function useChannelIfNone(name) {
  const { activeName, useChannel } = await import('./channels/registry.js');
  if (activeName()) return activeName() === name;
  await useChannel(name);
  return true;
}
