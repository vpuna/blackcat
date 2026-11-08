// `bc learned list|forget`, and /learned in the chat: one line for each wording, with a button
// to forget it.
import { forget, listLearned } from '../channels/learned.js';
import { actions, esc } from '../internal.js';
import { loaded } from '../plugins/registry.js';
import { plural } from '../util/format.js';
import { fmtWhen } from '../util/when.js';

// What a wording does, as said to the owner: "Home Assistant: turn on kitchen light".
const doing = (l) => `${loaded().find((p) => p.name === l.plugin)?.manifest.title ?? l.plugin}: ${l.words}`;
const used = (l) => (l.uses ? `used ${plural(l.uses, 'time')}, last ${fmtWhen(l.used)}` : 'not used yet');
const line = (l) => `${l.id}. “${l.wording}” → ${doing(l)} · ${used(l)} · learned ${fmtWhen(l.made)}`;

export function list() {
  const all = listLearned();
  return {
    text: all.length
      ? `${all.map(line).join('\n')}\n\nForget one: bc learned forget <number>`
      : 'Nothing learned yet. When the agent switches one thing or runs one shortcut for what you said, those words are learned.',
    data: { learned: all.map((l) => ({ ...l, does: doing(l) })) },
  };
}

export function forgetCmd(i, fail) {
  const all = listLearned();
  const ids = i.all ? all.map((l) => l.id) : (i.number ?? []).map(Number);
  if (!ids.length) fail('Say which, by its number (bc learned list), or --all.');
  const gone = ids.filter((id) => forget(id));
  const missing = ids.filter((id) => !gone.includes(id));
  if (!gone.length) fail(`Nothing learned has the number ${missing.join(', ')}. See: bc learned list`);
  return {
    text: `Forgotten: ${plural(gone.length, 'wording')}. The agent has them again next time.${missing.length ? ` (No ${missing.join(', ')}.)` : ''}`,
    data: { forgotten: gone },
  };
}

function screen() {
  const all = listLearned();
  if (!all.length)
    return {
      text: '🧠 Nothing learned yet. When the agent switches one thing or runs one shortcut for what you said, those words are learned.',
    };
  const kb = actions();
  all.forEach((l, n) => {
    kb.add(`✖ ${l.id}`, `lf:${l.id}`);
    if (n % 4 === 3) kb.row();
  });
  return {
    text: `🧠 <b>Learned words</b>: done at once, without the agent\n\n${all.map((l) => esc(line(l))).join('\n')}\n\nTap a number to forget it.`.slice(
      0,
      4000,
    ),
    actions: kb,
  };
}

export const showScreen = (c) => {
  const s = screen();
  return c.reply(s.text, { html: true, ...(s.actions ? { actions: s.actions } : {}) });
};

export function installChat(ui) {
  ui.action(/^lf:(\d+)$/, async (c) => {
    const ok = forget(Number(c.match[1]));
    await c.toast(ok ? 'Forgotten' : 'Already gone');
    const s = screen();
    return c.edit(s.text, { html: true, ...(s.actions ? { actions: s.actions } : {}) }).catch(() => {});
  });
}
