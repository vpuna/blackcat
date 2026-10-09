// The command line: every `bc …` command starts here (through bin/bc.js).
import net from 'node:net';
import { Command } from 'commander';
import { registerPlugins, runRawCommand } from './plugins/cli.js';
import { registerService } from './service/index.js';

// A server with several addresses is tried at each in turn. Node gives each a quarter of a
// second before moving on, and gives up when all have had their turn: on a slow line, or a
// network with no IPv6, a server that would have answered in half a second "timed out".
// Each address is given long enough to answer.
net.setDefaultAutoSelectFamilyAttemptTimeout?.(3000);

// Something that failed with nobody waiting for it (a Telegram send in a timer, a late
// database write) is logged and the process carries on. Without this, Node ends the process:
// for the bot that means every conversation in progress is lost. A one-off command still
// ends with a failure code.
// Data written by an earlier blackcat is refused in a sentence, wherever it was met.
const older = (e) => {
  if (e?.name !== 'OlderData') return false;
  console.error(e.message);
  process.exit(1);
};
process.on('unhandledRejection', (e) => {
  if (older(e)) return;
  console.error(`${new Date().toISOString()} unhandled: ${e?.stack ?? e}`);
  process.exitCode = 1;
});
process.on('uncaughtException', (e) => {
  if (older(e)) return;
  console.error(e?.stack ?? e);
  process.exit(1);
});

// Every command, registered. (Nothing here depends on which command is about to run, so a
// process that is kept waiting for the agent's next command builds this ahead of time.)
export async function build() {
  const program = new Command('bc')
    .description(
      'blackcat: an agent of your own that is always on. You talk to it through a chat or in a terminal, and it runs on the model you choose.',
    )
    .version('0.1.0')
    .addHelpText(
      'after',
      `
Getting started:
  bc chat               talk to the agent in this terminal: nothing else needs setting up
  bc channel            the chats it can reach you through (a Telegram bot comes with it), and how to pair one
  bc plugin list        what else there is to switch on: sources of messages, machines, devices
  bc service install    run blackcat in the background, starting at boot
  bc status             check everything is healthy
  bc logs -f            watch what it's doing

More help:
  bc <name> --help   any part or plugin: bc msg --help, bc watch --help, bc remind --help
  bc plugin list     what is a plugin and what is part of blackcat itself; docs/plugins.md explains how to write one

Files (in the folder blackcat was installed to):
  data/config.json   settings: the channel in use, the engine and model, each plugin's (private; secrets are in data/plugins/)
  agent/AGENT.md     the agent's personality and rules (handed to whichever engine runs the model)

"bc" is a shell alias for "blackcat"; scripts should call "blackcat".`,
    );

  program
    .command('chat')
    .description('talk to the agent here in the terminal (its own conversation, separate from the chat)')
    .argument('[message...]', 'ask one thing and exit; leave out for a conversation')
    .option('--new', 'start a fresh conversation (memories are kept)')
    .option('--resume [id]', 'carry on an earlier conversation: pick from a list, or give its number (bc conversations list)')
    .action(async (words, opts) => (await import('./agent/chat.js')).chat(words, opts));

  // The agent service's own process. (`bc tg bot run`, its name before channels, still works.)
  program
    .command('agent', { hidden: true })
    .description('the agent service')
    .command('run')
    .description('start the agent in this terminal (Ctrl+C to stop); the agent service runs this')
    .action(async () => (await import('./agent/run.js')).run());

  const channel = program
    .command('channel')
    .description('how blackcat talks to you: which channel is in use (one at a time; the terminal is always there too)')
    .option('--json', 'machine-readable output')
    .action(async (opts) => (await import('./channels/cli.js')).list(opts));
  channel
    .command('use')
    .description('make a channel the one in use')
    .argument('<name>', 'as shown by `bc channel`')
    .action(async (name) => (await import('./channels/cli.js')).use(name));
  channel
    .command('off')
    .description('use no channel: everything is still kept, and shown in `bc chat`')
    .action(async () => (await import('./channels/cli.js')).use(null));

  program
    .command('notify')
    .description('send yourself a message on the channel in use, from a script or another program (text as arguments, or piped in)')
    .argument('[text...]', 'what to say; left out, it is read from standard input')
    .requiredOption(
      '--from <name>',
      'who it is from, a short name of your choosing ("backup"): put before the text, and kept in the activity record',
    )
    .option('--json', 'machine-readable output')
    .addHelpText(
      'after',
      `
Examples:
  bc notify --from backup "The backup finished"
  ./build.sh && bc notify --from build "Done" || bc notify --from build "FAILED"
  df -h / | bc notify --from disk

What was sent, by whom and when (never the text itself): bc activity recent --kind sent
Exit code: 0 sent · 2 nothing to send, or no name · 3 no channel in use, or it could not be sent.
In a script or a cron job, write "blackcat notify": bc is an alias of your own shell, and is not there.`,
    )
    .action(async (words, opts) => (await import('./channels/notify.js')).notify(words, opts));

  const permissions = program
    .command('permissions')
    .description('commands you told the agent it may always, or never, run without asking: list them, remove any')
    .option('--json', 'machine-readable output')
    .action(async (opts) => (await import('./agent/permissions.js')).show(opts));
  permissions
    .command('remove')
    .description('remove one, so the agent asks again next time')
    .argument('<id>', 'as shown by `bc permissions`')
    .action(async (id) => (await import('./agent/permissions.js')).remove(id));
  permissions
    .command('clear')
    .description('remove all of them')
    .action(async () => (await import('./agent/permissions.js')).clear());

  registerService(program);
  await registerPlugins(program);
  // Searching messages is there once there are messages. Before that, asking for it says so.
  if (!program.commands.some((c) => c.name() === 'msg'))
    program
      .command('msg', { hidden: true })
      .allowUnknownOption()
      .argument('[words...]')
      .action(() => {
        console.error('There are no messages to search yet. Connect a source first: bc wa pair, bc tg account pair, or bc mail add.');
        process.exit(1);
      });
  return program;
}

// Run one command: `argv` is what followed `bc`.
export async function run(argv = process.argv.slice(2), program = null) {
  if (await runRawCommand(argv)) return;
  await (program ?? (await build())).parseAsync(argv, { from: 'user' });
}
