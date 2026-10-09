const svcArg = ['[service]', 'agent, or a plugin service such as wa or tg (default: all of them)'];
const lazy =
  (fn) =>
  async (...args) =>
    (await import('./commands.js'))[fn](...args);

export function registerService(program) {
  program
    .command('status')
    .description("overview: services, the channel, the engine, plugins, the machine's health")
    .option('--json', 'machine-readable output')
    .action(lazy('status'));

  program
    .command('selftest')
    .description(
      'ask everything that is set up whether it works right now: each machine, account, calendar and device, the chat, the engine, the databases (read-only: nothing is changed)',
    )
    .argument('[part...]', 'only these: blackcat, or a plugin by name (ssh mail)')
    .option('--json', 'machine-readable output')
    .action(async (names, opts) => (await import('../selftest.js')).command(names, opts));

  program
    .command('start')
    .description('start a service, or all of them')
    .argument(...svcArg)
    .action(lazy('start'));
  program
    .command('stop')
    .description('stop a service, or all of them, until started again')
    .argument(...svcArg)
    .action(lazy('stop'));
  program
    .command('restart')
    .description('restart a service, or everything (after an update)')
    .argument(...svcArg)
    .action(lazy('restart'));

  program
    .command('logs')
    .description('show service logs')
    .argument(...svcArg)
    .option('-f, --follow', 'keep showing new lines (Ctrl+C to stop)')
    .option('-n, --lines <n>', 'how many recent lines', '50')
    .action(lazy('logs'));

  const service = program.command('service').description('run blackcat in the background: at boot, in a container, or in this terminal');
  service
    .command('install')
    .description('start blackcat now and whenever the machine starts; with a name, put back a service that was switched off')
    .argument(...svcArg)
    .action(lazy('install'));
  service
    .command('uninstall')
    .description('stop blackcat and no longer start it at boot; with a name, stop one service and keep it stopped')
    .argument(...svcArg)
    .action(lazy('uninstall'));
  service
    .command('run')
    .description("run blackcat's services in this terminal until stopped (Ctrl+C): what the boot unit and a container run")
    .action(lazy('runAll'));
}
