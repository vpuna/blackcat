// The agent service: the scheduler, the process kept ready for the agent's commands, and
// the channel in use, with everything the owner can do through it wired to the desk.
// `bc agent run` (and, from before channels, `bc tg bot run`).
import { load } from '../config.js';
import { log } from '../log.js';
import { modelState } from '../engines/registry.js';
import { supervisorState } from '../service/units.js';
import { loadPlugins, loaded, makeCtx } from '../plugins/registry.js';
import { installApprovals } from '../channels/approvals.js';
import { chatCommands, directCommands } from '../channels/commands.js';
import { desk, setCarrier, ui } from '../channels/desk.js';
import { installDirect } from '../channels/direct.js';
import { incoming, installFront } from '../channels/front.js';
import { chatHooks } from '../channels/hooks.js';
import { tidyInbox } from '../channels/inbox.js';
import { installQuick } from '../channels/quick.js';
import { activeChannel } from '../channels/registry.js';
import { installSetup } from '../channels/setup.js';
import { errMsg } from '../channels/util.js';
import { prepare, stopAll } from './brain.js';
import { owner } from '../owner.js';
import { startScheduler } from './scheduler.js';
import { startWarm } from './warm.js';

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

// No channel in use: everything scheduled still happens (watches look for new messages,
// the search index is kept up to date), and what would have been sent is kept for
// `bc chat`. Returns once a channel is in use.
async function runWithoutChannel() {
  log(
    'no channel is in use: running the scheduler only. Reminders and reports are kept for `bc chat`. To be reached somewhere, pair a channel: `bc channel` lists them.',
  );
  const local = startScheduler(null);
  const warm = startWarm();
  const stop = () => {
    local.stop();
    warm.stop();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await new Promise((resolve) => {
    const timer = setInterval(async () => {
      await loadPlugins();
      if (!activeChannel()) return;
      clearInterval(timer);
      resolve();
    }, 30_000);
  });
  local.stop();
  warm.stop();
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
  log('a channel is now in use: starting it');
}

export async function run() {
  // Started by hand while blackcat is already running one: two would answer every message twice.
  if (!process.env.BLACKCAT_SERVICE && supervisorState()?.services?.agent?.state === 'running') {
    fail('The agent is already running in the background. Use `bc logs agent -f` to watch it, or `bc stop agent` first.');
  }
  await loadPlugins();
  // A plugin that was not loaded (it took another's name, or its file is at fault) is on the record, each time blackcat starts.
  try {
    const { refused } = await import('../plugins/registry.js');
    const { record } = await import('../activity/log.js');
    for (const r of refused())
      record({ kind: 'event', category: 'plugin', ok: false, summary: `"${r.name}" was not loaded: ${String(r.why).slice(0, 160)}` });
  } catch {}
  const channel = activeChannel();
  if (!channel) {
    await runWithoutChannel();
    return run(); // a channel has been set up meanwhile
  }

  // Start the channel. What it receives from the owner comes to the desk.
  let carrier;
  try {
    carrier = await channel.def.start(channel.ctx, { incoming: (ev) => incoming(ev), action: (ev) => desk.action(ev), log });
  } catch (e) {
    return fail(errMsg(e));
  }
  setCarrier(carrier);

  // Everything the owner can do in the chat, on whichever channel this is.
  const approvals = installApprovals();
  installSetup();
  // Plugins add their own screens and commands (reminders, watches, …).
  for (const p of loaded()) {
    try {
      await chatHooks(p).install?.(ui, { ctx: makeCtx(p, { caller: 'owner', surface: 'chat' }) });
    } catch (e) {
      log(`plugin ${p.name} could not set up its part of the chat: ${e.message}`);
    }
  }
  // blackcat's own commands, typed directly: /backup now, /watch list, /bc …
  installDirect();
  installQuick();
  installFront({ approvals });

  // (Set further down, once the channel is up; `stop` above may be called before that.)
  // eslint-disable-next-line prefer-const
  let scheduler;
  // A loaded process kept waiting, so the agent's commands start at once.
  const warm = startWarm();
  const stop = () => {
    scheduler?.stop();
    warm.stop();
    approvals.cancel(null, '🚫 blackcat restarted, nothing was done');
    stopAll();
    for (const p of loaded()) Promise.resolve(chatHooks(p).stop?.()).catch(() => {});
    carrier.stop();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  // Gives every plugin its turn: scheduled jobs, and work that needs the chat (reminders, reports).
  scheduler = startScheduler(ui);

  // Files sent in the chat are kept for a month, or for as long as something still carries
  // them: each part says which (`inboxKeeps`). If one cannot say, nothing is removed this time.
  try {
    const keep = new Set();
    for (const p of loaded())
      if (p.manifest.inboxKeeps)
        for (const f of (await p.manifest.inboxKeeps(makeCtx(p, { caller: 'job', surface: 'job' }))) ?? [])
          if (typeof f === 'string') keep.add(f);
    tidyInbox(keep);
  } catch (e) {
    log(`could not tidy the inbox: ${e.message}`);
  }

  // Have the agent started and waiting for the owner's first message.
  if (owner()?.chat != null) prepare(owner().chat).catch((e) => log(`could not get the agent ready: ${e.message}`));
  // Said once at the start when there is no model, so that the log answers "why does it not
  // reply in words?". (Only said: whether a turn is tried is decided by trying it.)
  modelState('chat')
    .then((st) => st.ok || log(`no model: ${st.why}. Running without one: commands, shortcuts, reminders and checks work.`))
    .catch(() => {});

  // Fills the channel's own menu of commands, where it has one. Not critical.
  await ui.setMenu([...chatCommands(), ...directCommands({ all: false })]).catch(() => log('could not set the command menu'));
  (await import('../activity/log.js')).serviceConnected(); // ready for the owner: how long after it was started

  try {
    await carrier.run();
  } catch (e) {
    fail(errMsg(e));
  }
  log('stopped');
  void load;
}
