import { can, ui } from './desk.js';
import { actions } from './kit.js';
import { esc } from '../util/format.js';
import crypto from 'node:crypto';
import { addRule, listRules, removeRule } from '../agent/permissions.js';
import { log } from '../log.js';
import { setApprover } from '../agent/brain.js';
import { errMsg } from './util.js';

const APPROVAL_MS = 5 * 60_000;

function render(req) {
  const lines = [`🐈‍⬛ <b>blackcat wants to ${esc(req.title)}</b>`];
  if (req.detail) lines.push(`<pre>${esc(req.detail)}</pre>`);
  // The reason is the agent's own wording, so it's shown as a claim, not a fact.
  if (req.why) lines.push(`Its reason: <i>${esc(req.why)}</i>`);
  // The cautions are short and set apart (italics): the command above is what is to be read.
  if (req.root) lines.push('🔴 <i>This runs as root (sudo).</i>');
  if (req.indirect)
    lines.push(
      "🟠 <i>Part of this command is only worked out when it runs, so the text above does not show everything it does. If unsure, don't allow it.</i>",
    );
  if (req.tainted)
    lines.push(
      "⚠️ <i>This conversation has read other people's messages or files. Allow this only if it is what <b>you</b> asked for.</i>",
    );
  lines.push(
    req.command
      ? '<i>Nothing runs unless you allow it. <b>Always</b> and <b>Never</b> are for this exact command (undo: /permissions). Expires in 5 minutes.</i>'
      : '<i>Nothing happens unless you allow it. Expires in 5 minutes.</i>',
  );
  return lines.join('\n\n');
}

// Wires the agent's permission requests to an Allow / Deny prompt in the owner's chat.
export function installApprovals() {
  const pending = new Map(); // id → { resolve, chatId, ref, text, timer }

  function finish(id, allow, label, note) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    // Replace the buttons with the outcome, so the chat keeps a record of what was decided.
    // (At once when the prompt is known to have been sent; an answer that arrived before that waits for it.)
    // (Where a message cannot be changed, the outcome is said on its own: the request is not shown a second time.)
    const edit = () =>
      can().edit
        ? ui.edit(p.chatId, p.ref, `${p.text}\n\n<b>${label}</b>`, { html: true })
        : ui.send(p.chatId, `<b>${label}</b>`, { html: true });
    (p.ref != null ? edit() : p.sent.then(edit)).catch((e) => log(`could not update approval message: ${errMsg(e)}`));
    p.resolve({ allow, note });
  }

  setApprover(async (req) => {
    const id = crypto.randomBytes(6).toString('hex');
    const text = render(req);
    // Shell commands can be answered for good; file changes are always asked about.
    const keyboard = req.command
      ? actions()
          .add('✅ Allow once', `ap:${id}:y`)
          .add('♾ Always allow', `ap:${id}:a`)
          .row()
          .add('❌ Not now', `ap:${id}:n`)
          .add('🚫 Never allow', `ap:${id}:v`)
      : actions().add('✅ Allow once', `ap:${id}:y`).add('❌ Not now', `ap:${id}:n`);
    // It is waiting for an answer from before the prompt is sent, not from when the channel
    // says it was: on a quick channel the owner's tap can be here first, and a tap that
    // found nothing waiting would leave the agent's turn hanging until it expired.
    return new Promise((resolve, reject) => {
      const p = { resolve, chatId: req.chatId, ref: null, text, command: req.command };
      p.timer = setTimeout(
        () => finish(id, false, '⌛ Expired, nothing was done', 'the owner did not answer within 5 minutes'),
        APPROVAL_MS,
      );
      pending.set(id, p);
      p.sent = ui.send(req.chatId, text, { html: true, actions: keyboard }).then(
        (ref) => void (p.ref = ref),
        (e) => {
          // It could not be asked: nothing waits, and whoever asked is told why.
          if (pending.delete(id)) clearTimeout(p.timer);
          reject(e);
        },
      );
    });
  });

  // The bot's middleware has already checked this is a paired account in a private chat.
  ui.action(/^ap:([0-9a-f]+):([ynav])$/, async (c) => {
    const [, id, what] = c.match;
    const p = pending.get(id);
    if (!p) return c.gone('This request is no longer waiting.');
    if (c.conversation !== p.chatId) return c.toast("This isn't your request.");
    const at = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    if ((what === 'a' || what === 'v') && !p.command) return c.toast('That choice is not available for this request.');
    if (what === 'a') addRule('allow', p.command);
    if (what === 'v') addRule('deny', p.command);
    const allow = what === 'y' || what === 'a';
    const label = {
      y: `✅ Allowed once at ${at}`,
      a: `♾ Always allowed from ${at} · undo in /permissions`,
      n: `❌ Not now (${at})`,
      v: `🚫 Never allowed from ${at} · undo in /permissions`,
    }[what];
    finish(
      id,
      allow,
      label,
      what === 'v' ? 'the owner said never to allow this exact command' : allow ? undefined : 'the owner declined this',
    );
    // (A brief acknowledgement where the channel has one; elsewhere the outcome above has said it.)
    await c.toast(can().edit ? { y: 'Allowed once', a: 'Always allowed', n: 'Not now', v: 'Never allowed' }[what] : undefined);
  });

  // /permissions: the standing answers, each with a button to take it back.
  const permissionsView = () => {
    const rules = listRules();
    if (!rules.length) return { text: 'No standing permissions. I ask you every time something needs approval.' };
    const kb = actions();
    const lines = ['🔐 <b>Standing permissions</b>', '', 'These exact commands are decided without asking you:'];
    rules.forEach((r, i) => {
      lines.push(
        '',
        `${i + 1}. ${r.effect === 'allow' ? '♾ <b>Always allow</b>' : '🚫 <b>Never allow</b>'} · since ${new Date(r.created * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`,
        `<pre>${esc(r.command.slice(0, 600))}</pre>`,
      );
      kb.add(`Remove ${i + 1}`, `pm:${r.id}`);
      if (i % 3 === 2) kb.row();
    });
    lines.push('', 'Remove one and I will ask you again next time.');
    return { text: lines.join('\n').slice(0, 4000), kb };
  };
  ui.command('permissions', (c) => {
    const v = permissionsView();
    return c.reply(v.text, { html: true, actions: v.kb });
  });
  ui.action(/^pm:(\d+)$/, async (c) => {
    const r = removeRule(c.match[1]);
    await c.toast(r ? 'Removed. I will ask again next time.' : 'Already removed.');
    const v = permissionsView();
    await c.edit(v.text, { html: true, actions: v.kb }).catch(() => {});
  });

  return {
    // /new or shutdown: anything still waiting is no longer wanted.
    cancel(chatId, label = '🚫 Cancelled, nothing was done') {
      for (const [id, p] of pending) if (chatId == null || p.chatId === chatId) finish(id, false, label, 'the request was cancelled');
    },
  };
}
