import {
  actions,
  agoLabel,
  dateLabel,
  hm,
  ymd,
  answerReminder as answer,
  dueReminders,
  markReminderSent,
  errMsg,
  esc,
  fmtWhen,
  getReminder,
  inQuiet,
  listReminders,
  log,
  msgSource,
  oneOfEachSeries,
  openRemindersDb as openAgentDb,
  aboutReminder,
  snoozeReminder as snooze,
  whyNotMoveReminder as whyNotMove,
  SOURCES,
  stopSeries,
} from '../internal.js';
import { withDb } from '../db.js';
import { addNextRepeat, closeMissed } from './db.js';

const hhmm = () => new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

export function renderReminder(r, { late = false } = {}) {
  const lines = [`⏰ <b>${esc(r.text)}</b>`];
  if (late) lines.push(`<i>This was due ${esc(fmtWhen(r.due_ts))}. blackcat wasn't running then.</i>`);
  if (r.msg_id) {
    // Quoted WhatsApp content is shown as a quote, clearly attributed.
    const where = r.msg_chat && r.msg_chat !== r.msg_sender ? ` in ${esc(r.msg_chat)}` : '';
    lines.push(
      `💬 ${esc(r.msg_sender ?? 'Someone')}${where} on ${SOURCES[msgSource(r.msg_id)]}${r.msg_ts ? `, ${esc(fmtWhen(r.msg_ts))}` : ''}:\n<blockquote>${esc(r.msg_quote ?? '')}</blockquote>`,
    );
  }
  const tags = [];
  if (r.source === 'auto')
    tags.push(
      r.item_id
        ? `🤖 ${esc(r.note ?? 'From one of your watches')}. Done also ticks it off the list.`
        : `🤖 Picked up from your messages${r.note ? `: ${esc(r.note)}` : ''}`,
    );
  const a = aboutReminder(r);
  if (a.repeats) tags.push(`🔁 Repeats ${esc(a.repeats)}`);
  if (a.file) tags.push('📎 With a file, sent below');
  if (tags.length) lines.push(`<i>${tags.join('\n')}</i>`);
  return lines.join('\n\n');
}

// What can be done with a reminder: as it arrives, or opened from the briefing (where one not
// yet gone can also be cancelled). Moving it to later is for one that has gone; of a series,
// only to before its next time ("Tomorrow 9:00" would be a second walk on the day). One that
// repeats can be skipped this time, or stopped: no more of it.
function buttons(db, r, { opened = false } = {}) {
  const kb = actions().add('✅ Done', `rm:${r.id}:d`);
  if (r.repeat) kb.add('⏭ Skip this time', `rm:${r.id}:x`).add('🛑 Stop repeating', `rm:${r.id}:s`);
  else if (opened) kb.add('🗑 Cancel it', `rm:${r.id}:x`);
  if (r.status === 'pending' && r.due_ts > Date.now() / 1000) return kb;
  if (r.repeat || opened) kb.row();
  if (!whyNotMove(db, r, hourOn())) kb.add('⏰ 1 hour', `rm:${r.id}:h`);
  if (!r.repeat) kb.add('🌅 Tomorrow 9:00', `rm:${r.id}:t`);
  return kb;
}
const hourOn = () => Math.floor(Date.now() / 1000) + 3600;

// Quiet hours hold back automatic reminders only. One you set yourself fires when you said.

// Send every reminder that has come due. Called by the scheduler every few seconds.
export async function fireDue(ui) {
  return withDb(openAgentDb, async (db) => {
    const quiet = inQuiet();
    for (const r of dueReminders(db)) {
      if (quiet && r.source === 'auto') continue;
      const late = Date.now() / 1000 - r.due_ts > 15 * 60;
      // (Its next time first: the buttons are for the time before it.)
      addNextRepeat(db, r);
      try {
        await ui.send(r.chat_id, renderReminder(r, { late }), {
          html: true,
          actions: buttons(db, r),
          what: `${r.item_id ? 'a nudge' : 'reminder'} ${r.id}`,
          dueTs: r.due_ts,
        });
      } catch (e) {
        log(`reminder ${r.id} not sent, will retry: ${errMsg(e)}`);
        continue;
      }
      // The picture or document that goes with it. If it has gone missing, the reminder still stands.
      if (r.file)
        await ui
          .sendFile(r.chat_id, r.file, { what: `the file of reminder ${r.id}` })
          .catch((e) => log(`reminder ${r.id}: could not send its file: ${errMsg(e)}`));
      // (Unless the owner has answered it in the moment it took to send: then that stands.)
      const marked = markReminderSent(db, r);
      log(`reminder ${r.id} sent${marked ? '' : ', and already answered'}`);
      closeMissed(db, r);
    }
  });
}

export function upcomingText(chatId) {
  const rows = withDb(openAgentDb, (db) => oneOfEachSeries(listReminders(db, { chatId })));
  if (!rows.length) return 'No upcoming reminders. Ask me to set one, e.g. "remind me in 2 days to call the bank".';
  return [
    '⏰ Reminders',
    '',
    ...rows.map((r) => {
      const a = aboutReminder(r);
      return `${r.id}. ${fmtWhen(r.due_ts)} · ${a.text}${a.state ? ` (${a.state})` : ''}${a.auto ? ' 🤖' : ''}${a.repeats ? ` · 🔁 ${a.repeats}` : ''}${a.file ? ' 📎' : ''}`;
    }),
    '',
    'Tell me to move, cancel or finish one, e.g. "cancel reminder 3".',
  ].join('\n');
}

// For the briefing: the reminders you set yourself (nudges are shown through their items),
// each placed on its day, with its line and what its number opens. One that was sent and never
// marked done stays on its day, which the briefing shows as past due once it has gone; one
// that repeats is there once.
// → { entries: [{ day, line, action, kind, id, title }] }
export function forBriefing({ chatId, terminal = false } = {}) {
  const today = ymd(Date.now());
  const tomorrow = ymd(Date.now() + 86400000);
  const rows = withDb(openAgentDb, (db) => oneOfEachSeries(listReminders(db, { chatId }).filter((r) => !r.item_id)));
  return {
    entries: rows.map((r) => {
      const a = aboutReminder(r);
      const due = ymd(r.due_ts * 1000);
      const when = a.state
        ? `${due < today ? `due ${agoLabel(due)}` : hm(r.due_ts)}, ${a.state}`
        : due > tomorrow
          ? `${dateLabel(due)}, ${hm(r.due_ts)}`
          : hm(r.due_ts);
      return {
        day: due,
        line: `⏰ <b>${esc(a.text)}</b> · <i>${esc(when)}</i>${a.repeats ? ` · 🔁 <i>${esc(a.repeats)}</i>` : ''}${a.file ? ' 📎' : ''}${terminal ? ` [reminder ${r.id}]` : ''}`,
        action: `rm:${r.id}:o`,
        kind: 'reminder',
        id: r.id,
        title: r.text,
      };
    }),
  };
}

export function installReminders(ui) {
  // (The channel has already made sure this is the owner.)
  ui.action(/^rm:(\d+):([dhtxos])$/, async (c) => {
    const [, id, what] = c.match;
    return withDb(openAgentDb, async (db) => {
      const r = getReminder(db, Number(id));
      if (!r || r.chat_id !== c.chat) return c.gone('That reminder no longer exists.');
      let label;
      if (what === 'o') {
        // From a numbered line in the briefing: show the reminder with its buttons.
        await c.toast();
        if (!['pending', 'sent'].includes(r.status)) return c.reply(`That reminder is already ${r.status}: ${r.text}`);
        await c.reply(`${renderReminder(r)}\n\n<i>Due ${esc(fmtWhen(r.due_ts))}</i>`, {
          html: true,
          actions: buttons(db, r, { opened: true }),
        });
        if (r.file) await ui.sendFile(r.chat_id, r.file).catch((e) => log(`reminder ${r.id}: its file was not sent: ${e.message}`));
        return undefined;
      }
      // (A tap on an old message, for one answered since: said, and nothing changed.)
      if (what !== 's' && !['pending', 'sent'].includes(r.status)) return c.gone(`That reminder is already ${r.status}.`);
      if (what === 'd') {
        answer(db, r, 'done');
        label = `✅ Done at ${hhmm()}`;
      } else if (what === 'x') {
        answer(db, r, 'cancelled');
        label = r.repeat ? '⏭ Skipped this time' : '🗑 Cancelled';
      } else if (what === 's') {
        stopSeries(db, r);
        label = '🛑 Stopped: it will not come again';
      } else {
        let due;
        if (what === 'h') due = hourOn();
        else {
          const d = new Date();
          d.setDate(d.getDate() + 1);
          d.setHours(9, 0, 0, 0);
          due = Math.floor(d.getTime() / 1000);
        }
        const why = snooze(db, r, due);
        if (why) return c.toast(`Not moved: ${why}.`);
        label = `⏰ Snoozed to ${fmtWhen(due)}`;
      }
      await c.toast(label);
      // Replace the buttons with the outcome.
      await c.edit(`${renderReminder(r)}\n\n<b>${esc(label)}</b>`, { html: true }).catch(() => {});
    });
  });
}
