import { ui } from './desk.js';
import { actions } from './kit.js';
import { log } from '../log.js';
import {
  applies,
  browseStart,
  check,
  defaultOf,
  folderName,
  joinPath,
  messageOf,
  optionsOf,
  parentPath,
  savedOf,
} from '../plugins/forms.js';
import { PluginError, findLoaded, loadPlugins, makeCtx } from '../plugins/registry.js';

// /setup in the bot: run a plugin's form commands as a guided conversation.
// The bot's own code asks the questions and runs the command. the agent is not involved,
// so nothing typed here (including secrets) ever enters a conversation with the agent.

const flows = new Map(); // chat id → { plugin, name, steps, i, answers, pctx }

const label = (plugin, name) => `${plugin.manifest.title}: ${plugin.manifest.commands[name].summary}`.slice(0, 60);

async function menu(c) {
  const plugins = await loadPlugins();
  const kb = actions();
  let n = 0;
  for (const p of plugins) {
    for (const [name, def] of Object.entries(p.manifest.commands)) {
      if (!def.form || def.hidden) continue;
      kb.add(label(p, name), `ps:${p.name}:${name}`).row();
      n++;
    }
  }
  if (!n)
    return c.reply(
      'Nothing to set up here yet. Plugins are enabled on this machine with `bc plugin enable <name>`; once enabled, their setup appears here.',
    );
  return c.reply('⚙️ Setup. What do you want to do?\n\nI ask the questions here. Send /cancel to stop at any point.', { actions: kb });
}

const MAX_FOLDERS = 40;

// The folder browser: where we are, and a button for each thing that can be done.
function showBrowse(c, flow) {
  const b = flow.browse;
  const step = flow.steps[flow.i];
  const kb = actions().add('✓ Use this folder', 'pb:use').row();
  if (b.dir !== '/') kb.add('↑ Go up', 'pb:up');
  if (step.create) kb.add('+ New folder', 'pb:new');
  kb.row();
  b.entries.slice(0, MAX_FOLDERS).forEach((n, i) => {
    kb.add(`📁 ${n}`.slice(0, 30), `pb:${i}`);
    if (i % 2 === 1) kb.row();
  });
  const more =
    b.entries.length > MAX_FOLDERS ? `\n(${b.entries.length - MAX_FOLDERS} more folders not shown: type the full path instead)` : '';
  return c.reply(
    `${b.message}\n\n📂 Now in: ${b.dir}${b.entries.length ? '' : '\n(no folders inside)'}${more}\n\nTap a folder to go into it, or type a full path.`,
    { actions: kb },
  );
}

async function openFolder(c, flow, dir) {
  const step = flow.steps[flow.i];
  try {
    flow.browse.entries = await step.list(dir, flow.answers, flow.pctx);
    flow.browse.dir = dir;
  } catch (e) {
    await c.reply(`Can't open ${dir}: ${e.message}`);
  }
  return showBrowse(c, flow);
}

// Ask the next question that applies, or finish.
async function advance(c, flow) {
  for (; flow.i < flow.steps.length; flow.i++) {
    const step = flow.steps[flow.i];
    if (!applies(step, flow.answers, flow.pctx)) continue;
    const message = messageOf(step, flow.answers, flow.pctx);
    if (step.type === 'note') {
      await c.reply(message);
      continue;
    }
    if (step.type === 'browse') {
      try {
        flow.browse = { ...(await browseStart(step, flow.answers, flow.pctx)), message, naming: false };
      } catch (e) {
        flows.delete(c.chat);
        return c.reply(`😿 ${e.message}`);
      }
      return showBrowse(c, flow);
    }
    const def = defaultOf(step, flow.answers, flow.pctx);
    if (step.type === 'select') {
      const opts = optionsOf(step, flow.answers, flow.pctx);
      if (!opts.length) {
        flows.delete(c.chat);
        return c.reply('There is nothing to choose from, so there is nothing to do.');
      }
      const kb = actions();
      opts.forEach((o, n) => kb.add(`${o.label ?? o.value}${String(o.value) === String(def) ? ' ✓' : ''}`.slice(0, 60), `pf:${n}`).row());
      const hints = opts
        .filter((o) => o.hint)
        .map((o) => `• ${o.label ?? o.value}: ${o.hint}`)
        .join('\n');
      return c.reply(`${message}${hints ? `\n\n${hints}` : ''}`, { actions: kb });
    }
    if (step.type === 'confirm') {
      // (What it is set to now is marked, as for a choice.)
      return c.reply(message, {
        actions: actions()
          .add(`Yes${def === true ? ' ✓' : ''}`, 'pf:y')
          .add(`No${def === false ? ' ✓' : ''}`, 'pf:n'),
      });
    }
    const saved = savedOf(step, flow.answers, flow.pctx);
    const kb =
      def != null && step.type === 'text'
        ? actions().add(`Use ${def}`, 'pf:d')
        : saved
          ? actions().add('Keep the saved one', 'pf:k')
          : undefined;
    return c.reply(
      `${message}${step.type === 'secret' ? `\n\n🔒 ${saved ? 'One is saved. Keep it, or type a new one here' : 'Type it here'}. I delete your message as soon as I have read it.` : ''}`,
      kb ? { actions: kb } : {},
    );
  }
  return finish(c, flow);
}

async function finish(c, flow) {
  flows.delete(c.chat);
  const def = flow.plugin.manifest.commands[flow.name];
  // Say that something is happening: a setup that signs in somewhere or fetches things can
  // take a minute. Quick ones (under a second and a half) finish before this is sent.
  let waiting = null;
  const slow = setTimeout(() => {
    waiting = c.reply(`⏳ ${def.working ?? 'Working on it. This can take a minute…'}`).catch(() => null);
  }, 1500);
  const typing = setInterval(() => c.working().catch(() => {}), 4500);
  c.working().catch(() => {});
  const settle = async () => {
    clearTimeout(slow);
    clearInterval(typing);
    const sent = await waiting;
    if (sent != null) await ui.remove(c.chat, sent).catch(() => {});
  };
  try {
    const result = await def.run(flow.pctx, flow.answers);
    await settle();
    const text = result == null ? 'Done.' : typeof result === 'string' ? result : (result.text ?? 'Done.');
    for (let i = 0; i < text.length; i += 4000) await c.reply(text.slice(i, i + 4000), { preview: false });
  } catch (e) {
    await settle();
    if (!(e instanceof PluginError)) log(`setup ${flow.plugin.name}/${flow.name} failed: ${e.stack ?? e.message}`);
    await c.reply(`😿 ${e.message}`);
  }
}

async function answer(c, flow, raw) {
  const step = flow.steps[flow.i];
  const r = check(step, raw, flow.answers, flow.pctx);
  if (r.error) return c.reply(`${r.error} Try again, or /cancel.`);
  flow.answers[step.id] = r.value;
  flow.i++;
  return advance(c, flow);
}

// Begin a setup: ask the command's questions one at a time. (Also used by `/backup setup` typed directly.)
export async function startSetup(c, plugin, name) {
  const flow = {
    plugin,
    name,
    steps: plugin.manifest.commands[name].form,
    i: 0,
    answers: {},
    pctx: makeCtx(plugin, { caller: 'owner', surface: 'chat' }),
  };
  flows.set(c.chat, flow);
  await c.reply(`${label(plugin, name)}\n(/cancel stops it.)`);
  return advance(c, flow);
}

export function installSetup() {
  ui.command('setup', menu);
  ui.command('cancel', (c) => c.reply(flows.delete(c.chat) ? 'Cancelled. Nothing was changed.' : 'Nothing to cancel.'));

  // Start a flow from the menu. (The bot's middleware has already checked this is the owner.)
  ui.action(/^ps:([a-z0-9-]+):([a-z0-9-]+)$/, async (c) => {
    await loadPlugins();
    const plugin = findLoaded(c.match[1]);
    const def = plugin?.manifest.commands[c.match[2]];
    if (!def?.form) return c.toast('That is no longer available.');
    await c.toast();
    return startSetup(c, plugin, c.match[2]);
  });

  // The folder browser's buttons.
  ui.action(/^pb:(use|up|new|\d+)$/, async (c) => {
    const flow = flows.get(c.chat);
    const step = flow?.steps[flow.i];
    if (step?.type !== 'browse' || !flow.browse) return c.toast('That question is no longer open.');
    const v = c.match[1];
    const b = flow.browse;
    await c.toast();
    await c.clearActions().catch(() => {});
    if (v === 'use') {
      await c.reply(`Using ${b.dir}`);
      return answer(c, flow, b.dir);
    }
    if (v === 'up') return openFolder(c, flow, parentPath(b.dir));
    if (v === 'new') {
      if (!step.create) return showBrowse(c, flow);
      b.naming = true;
      return c.reply(`Name of the new folder in ${b.dir}? (/cancel stops the setup)`);
    }
    const name = b.entries[Number(v)];
    return name ? openFolder(c, flow, joinPath(b.dir, name)) : showBrowse(c, flow);
  });

  // A button answer: an option number, yes/no, or "use the default".
  ui.action(/^pf:(\d+|y|n|d|k)$/, async (c) => {
    const flow = flows.get(c.chat);
    const step = flow?.steps[flow.i];
    if (!step) return c.toast('That question is no longer open.');
    const v = c.match[1];
    let raw;
    if (step.type === 'confirm' && (v === 'y' || v === 'n')) raw = v === 'y';
    else if (step.type === 'select' && /^\d+$/.test(v)) raw = optionsOf(step, flow.answers, flow.pctx)[Number(v)]?.value;
    else if (step.type === 'text' && v === 'd') raw = defaultOf(step, flow.answers, flow.pctx);
    else if (step.type === 'secret' && v === 'k' && savedOf(step, flow.answers, flow.pctx)) raw = '';
    else return c.toast('That button does not fit this question.');
    await c.toast();
    await c.clearActions().catch(() => {}); // the buttons have done their job
    return answer(c, flow, raw);
  });
}

// Called for every text message before it goes to the agent. Returns true if the message
// was an answer to a setup question, and so must not be passed on.
export async function handleSetupText(c) {
  const flow = flows.get(c.chat);
  const step = flow?.steps[flow.i];
  if (step?.type === 'browse' && flow.browse) {
    const text = c.text.trim();
    if (flow.browse.naming) {
      // The name of a new folder.
      const bad = folderName(text);
      if (bad) return (await c.reply(`${bad}. Try again, or /cancel.`), true);
      flow.browse.naming = false;
      const dir = joinPath(flow.browse.dir, text);
      try {
        await step.create(dir, flow.answers, flow.pctx);
      } catch (e) {
        await c.reply(`Could not make it: ${e.message}`);
        await showBrowse(c, flow);
        return true;
      }
      await openFolder(c, flow, dir);
      return true;
    }
    // A typed path jumps straight there.
    if (text.startsWith('/')) await openFolder(c, flow, text.replace(/(.)\/+$/, '$1'));
    else await c.reply('Tap a folder, or type a full path starting with /.');
    return true;
  }
  if (!step || (step.type !== 'text' && step.type !== 'secret')) return false;
  const text = c.text;
  if (step.type === 'secret') {
    // Remove it from the chat straight away. It is never logged and never reaches the agent.
    await c.remove().catch(() => c.reply("I couldn't delete that message. Please delete it yourself."));
  }
  await answer(c, flow, text);
  return true;
}

export const inSetup = (chatId) => flows.has(chatId);
