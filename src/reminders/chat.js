import {
  actions,
  addReminder,
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
  nextRepeat,
  openRemindersDb as openAgentDb,
  repeatText,
  rescheduleReminder as reschedule,
  setReminderStatus as setStatus,
  SOURCES,
} from '../internal.js';
import { withDb } from '../db.js';

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
  if (r.repeat) tags.push(`🔁 Repeats ${esc(repeatText(r.repeat))}`);
  if (r.file) tags.push('📎 With a file, sent below');
  if (tags.length) lines.push(`<i>${tags.join('\n')}</i>`);
  return lines.join('\n\n');
}

const buttons = (id) => actions().add('✅ Done', `rm:${id}:d`).add('⏰ 1 hour', `rm:${id}:h`).add('🌅 Tomorrow 9:00', `rm:${id}:t`);
// Opened from the briefing, before it is due: it can also simply be cancelled.
const openButtons = (id) =>
  actions()
    .add('✅ Done', `rm:${id}:d`)
    .add('🗑 Cancel it', `rm:${id}:x`)
    .row()
    .add('⏰ In 1 hour', `rm:${id}:h`)
    .add('🌅 Tomorrow 9:00', `rm:${id}:t`);

// Quiet hours hold back automatic reminders only. One you set yourself fires when you said.
const inQuietHours = inQuiet;

// Send every reminder that has come due. Called by the scheduler every few seconds.
export async function fireDue(ui) {
  return withDb(openAgentDb, async (db) => {
    const quiet = inQuietHours();
    for (const r of dueReminders(db)) {
      if (quiet && r.source === 'auto') continue;
      const late = Date.now() / 1000 - r.due_ts > 15 * 60;
      try {
        await ui.send(r.chat_id, renderReminder(r, { late }), {
          html: true,
          actions: buttons(r.id),
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
      const next = nextRepeat(r.due_ts, r.repeat);
      if (next) {
        addReminder(db, {
          chatId: r.chat_id,
          text: r.text,
          dueTs: Math.max(next, Math.floor(Date.now() / 1000) + 60),
          source: 'user',
          repeat: r.repeat,
          file: r.file,
          msgId: r.msg_id,
          msgChat: r.msg_chat,
          msgSender: r.msg_sender,
          msgQuote: r.msg_quote,
          msgTs: r.msg_ts,
        });
      }
    }
  });
}

export function upcomingText(chatId) {
  const rows = withDb(openAgentDb, (db) => listReminders(db, { chatId }));
  if (!rows.length) return 'No upcoming reminders. Ask me to set one, e.g. "remind me in 2 days to call the bank".';
  return [
    '⏰ Reminders',
    '',
    ...rows.map(
      (r) =>
        `${r.id}. ${fmtWhen(r.due_ts)} · ${r.text}${r.status === 'sent' ? ' (sent, not done)' : ''}${r.source === 'auto' ? ' 🤖' : ''}${r.repeat ? ' 🔁' : ''}`,
    ),
    '',
    'Tell me to move, cancel or finish one, e.g. "cancel reminder 3".',
  ].join('\n');
}

export function installReminders(ui) {
  // (The channel has already made sure this is the owner.)
  ui.action(/^rm:(\d+):([dhtxo])$/, async (c) => {
    const [, id, what] = c.match;
    return withDb(openAgentDb, async (db) => {
      const r = getReminder(db, Number(id));
      if (!r || r.chat_id !== c.chat) return c.gone('That reminder no longer exists.');
      let label;
      if (what === 'o') {
        // From a numbered line in the briefing: show the reminder with its buttons.
        await c.toast();
        if (!['pending', 'sent'].includes(r.status)) return c.reply(`That reminder is already ${r.status}: ${r.text}`);
        await c.reply(`${renderReminder(r)}\n\n<i>Due ${esc(fmtWhen(r.due_ts))}</i>`, { html: true, actions: openButtons(r.id) });
        if (r.file) await ui.sendFile(r.chat_id, r.file).catch(() => {});
        return undefined;
      }
      if (what === 'd') {
        setStatus(db, r.id, 'done');
        label = `✅ Done at ${hhmm()}`;
      } else if (what === 'x') {
        setStatus(db, r.id, 'cancelled');
        label = '🗑 Cancelled';
      } else {
        let due;
        if (what === 'h') due = Math.floor(Date.now() / 1000) + 3600;
        else {
          const d = new Date();
          d.setDate(d.getDate() + 1);
          d.setHours(9, 0, 0, 0);
          due = Math.floor(d.getTime() / 1000);
        }
        reschedule(db, r.id, due);
        label = `⏰ Snoozed to ${fmtWhen(due)}`;
      }
      await c.toast(label);
      // Replace the buttons with the outcome.
      await c.edit(`${renderReminder(r)}\n\n<b>${esc(label)}</b>`, { html: true }).catch(() => {});
    });
  });
}
