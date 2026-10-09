// Everything the parts of blackcat itself use from one another: what a plugin may use
// (src/api.js) and what it may not. The parts of the core that are written with a manifest
// (watches, reminders, checks, backup, the archive's commands) import from here.
//
// A plugin never imports this (a test holds that). What is here and not in src/api.js is
// what would let one plugin reach another's settings and secrets, change what the agent is
// allowed, or read and write blackcat's own files.
export * from './api.js';

// ---- where things are, and the whole settings file
export { CONFIG_FILE, DATA, HOME, load, save, update } from './config.js';
export { CODE_DIR, services } from './service/units.js';

// ---- every plugin that is loaded, and a context for any of them
export { loaded, makeCtx, PluginError, pluginSettings, setPluginSettings } from './plugins/registry.js';

// ---- blackcat's own database
export { getMeta as agentMeta, openAgentDb, setMeta as setAgentMeta } from './agentdb.js';

// ---- what the agent is allowed: standing permissions
export { addRule, removeRule, ruleFor } from './agent/permissions.js';

// ---- times and schedules, beyond what plugins need
export { latestSlot, pad, todayAt } from './util/time.js';
export { REPEAT_WORDS, daysText, nextRepeat, parseDays, parseWhen, repeatCron, repeatText } from './util/when.js';
export {
  asText as scheduleText,
  asTimes,
  daysOf,
  isSchedule,
  nextRun,
  parseWhenText,
  shortestGap,
  summary as scheduleSummary,
  toSchedule,
} from './util/schedule.js';
export { docxText } from './util/run.js';

// ---- the owner, and what the agent may read
export { adopt, LOCAL, owner, ownerChat } from './owner.js';
export { readDirs } from './channels/files.js';
export { INBOX } from './channels/inbox.js';

// ---- the archive, beyond reading and writing messages
export { CHAT_NAME, SENDER_NAME } from './archive/db.js';
export { resolveChats } from './archive/query.js';
export { SOURCES, inSourceSql, msgSource, notOptInSql, optIn, source, sourceOf } from './archive/sources.js';
export { fetchMedia, findMedia } from './archive/media.js';
export {
  AUDIO_SQL,
  NOTE_CHARS,
  READABLE_SQL,
  canHear,
  doneHearing,
  hearable,
  noteFor,
  openNotesDb,
  readAttachment,
  readable,
} from './archive/attachments.js';

// ---- the reminder queue and quiet hours
export {
  addReminder,
  dueReminders,
  getReminder,
  listReminders,
  openRemindersDb,
  markSent as markReminderSent,
  reschedule as rescheduleReminder,
  setStatus as setReminderStatus,
} from './reminders/db.js';
export { QUIET_CHOICES, describeQuiet, inQuiet, outOfQuiet, quiet, setQuiet } from './quiet.js';

// ---- models with no tools, the readers, and what the owner said about themself
export { askModelAbout, parseJsonList } from './agent/oneshot.js';
export { ReaderError, askReader, readerModel } from './readers.js';
export { aboutOwner } from './memory/store.js';

// ---- the activity record, read
export { recent as recentActivity, totals as activityTotals } from './activity/log.js';

// ---- the chat, from the inside
export { ui, can as channelCan, nativeOf as nativeChannel } from './channels/desk.js';
export { ensureCarrier, activeName as activeChannelName } from './channels/registry.js';
export { tellChat } from './channels/send.js';
