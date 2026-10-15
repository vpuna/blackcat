// Everything the parts of blackcat itself use from one another: what a plugin may use
// (src/api.js) and what it may not. The parts of the core that are written with a manifest
// (watches, reminders, checks, backup, the archive's commands) import from here.
//
// A plugin never imports this (a test holds that). What is here and not in src/api.js is
// what would let one plugin reach another's settings and secrets, change what the agent is
// allowed, or read and write blackcat's own files.
export * from './api.js';

// ---- where things are, and the whole settings file
export { DATA, HOME, load, update } from './config.js';
export { services } from './service/units.js';

// ---- every plugin that is loaded, and a context for any of them
export { loaded, makeCtx, PluginError, pluginSettings, setPluginSettings } from './plugins/registry.js';

// ---- blackcat's own database
export { openAgentDb } from './agentdb.js';

// ---- what the agent is allowed: standing permissions
export { addRule, removeRule, ruleFor } from './agent/permissions.js';

// ---- times and schedules, beyond what plugins need
export { todayAt } from './util/time.js';
export { REPEAT_WORDS, nextRepeat, parseWhen, repeatCron, repeatText } from './util/when.js';
export { asText as scheduleText, nextRun, parseWhenText, shortestGap, summary as scheduleSummary } from './util/schedule.js';

// ---- the owner, and what the agent may read
export { adopt, owner, ownerChat } from './owner.js';
export { INBOX } from './channels/inbox.js';

// ---- the archive, beyond reading and writing messages
export { CHAT_NAME, SENDER_LABEL, SENDER_NAME } from './archive/db.js';
export { messageById, resolveChats } from './archive/query.js';
export { SOURCES, inSourceSql, msgSource, notOptInSql, optIn, source, sourceOf } from './archive/sources.js';
export { fetchMedia, findMedia } from './archive/media.js';
export {
  AUDIO_SQL,
  PICTURE_SQL,
  DOCUMENT_SQL,
  isPicture,
  isDocument,
  NOTE_CHARS,
  hearable,
  noteFor,
  openNotesDb,
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
export { askReader, readerInstructions, readerModel } from './readers.js';
export { aboutOwner } from './memory/store.js';

// ---- the chat, from the inside
export { ui } from './channels/desk.js';
export { ensureCarrier } from './channels/registry.js';
export { tellChat } from './channels/send.js';
// ---- is it kept already? (a list entry, a reminder: by its words, no model)
export { keptAlike, keptLine, notAddedText } from './plugins/same.js';
