import { ui } from './desk.js';
import { actions } from './kit.js';
import { chatHooks } from './hooks.js';
import crypto from 'node:crypto';
import { ownerDid } from '../activity/log.js';
import { log } from '../log.js';
import { loaded, makeCtx } from '../plugins/registry.js';
import { tell } from '../agent/brain.js';

// The quick route: before a message goes to the agent, each plugin gets a chance to handle
// it directly (`telegram.quick` in its manifest). A plugin takes a message only when it
// is certain what is meant; otherwise it returns null and the agent gets it as usual.
//   quick(text, { ctx }) → null | { text, note? } | { confirm: 'question', run: async () => ({ text, note? }) }

const pending = new Map(); // id → { run, chatId }

async function finish(c, r) {
  await c.reply(r.text);
  if (r.note) tell(c.conversation, r.note);
}

// → true if the message was handled here and must not go to the agent.
export async function tryQuick(c, text) {
  for (const p of loaded()) {
    const quick = chatHooks(p).quick;
    if (!quick) continue;
    const t0 = Date.now();
    let r = null;
    try {
      r = await quick(text, { ctx: makeCtx(p, { caller: 'owner', surface: 'chat' }) });
    } catch (e) {
      log(`quick route of ${p.name} failed, leaving it to the agent: ${e.message}`);
    }
    if (!r) continue;
    if (r.confirm) {
      const id = crypto.randomBytes(5).toString('hex');
      pending.set(id, { run: r.run, chatId: c.chat });
      setTimeout(() => pending.delete(id), 2 * 60_000).unref();
      await c.reply(r.confirm, { actions: actions().add('✅ Yes', `qk:${id}:y`).add('✖ No', `qk:${id}:n`) });
    } else {
      ownerDid('done directly', `${p.name}: ${r.note ?? 'answered'}`, { surface: 'chat', ms: Date.now() - t0 });
      await finish(c, r);
    }
    return true;
  }
  return false;
}

export function installQuick() {
  ui.action(/^qk:([0-9a-f]+):([yn])$/, async (c) => {
    const p = pending.get(c.match[1]);
    pending.delete(c.match[1]);
    if (!p) await c.gone('That is no longer waiting.');
    else await c.toast(c.match[2] === 'y' ? 'Doing it' : 'Not done');
    await c.clearActions().catch(() => {});
    if (p && p.chatId === c.chat && c.match[2] === 'y') await finish(c, await p.run());
  });
}
