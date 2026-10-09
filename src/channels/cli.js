// `bc channel`: which channel blackcat talks to the owner through. For a terminal on this
// machine only: a channel cannot switch, pair or reconfigure itself from inside.
import { ownerDid } from '../activity/log.js';
import pc from 'picocolors';
import { loadPlugins, mountOf, findLoaded } from '../plugins/registry.js';
import { listChannels, useChannel } from './registry.js';

const refuse = () => {
  if (process.env.BLACKCAT_CALLER !== 'agent' && !process.env.BLACKCAT_CHAT_ID) return;
  console.error('Which channel is in use is changed in a terminal on this machine, not from a chat.');
  process.exit(1);
};

export async function list(opts = {}) {
  await loadPlugins();
  const all = listChannels();
  if (opts.json) return console.log(JSON.stringify({ channels: all, alwaysThere: 'the terminal (bc chat)' }, null, 2));
  if (!all.length) return console.log('No channel plugins are installed. The terminal (bc chat) is always there.');
  for (const c of all) {
    const pair = `bc ${mountOf(findLoaded(c.name).manifest).join(' ')} pair`;
    console.log(
      `${c.active ? pc.green('●') : pc.dim('○')} ${pc.bold(c.name.padEnd(12))} ${c.label}${c.active ? pc.green('  in use') : ''}${c.paired ? (c.active ? '' : pc.dim(`  set up · bc channel use ${c.name}`)) : pc.dim(`  not set up → ${pair}`)}`,
    );
  }
  console.log(
    pc.dim(
      `\nOne channel is in use at a time. The terminal (bc chat) is always there too.${all.some((c) => c.active) ? '  Use none: bc channel off' : ''}`,
    ),
  );
  return undefined;
}

export async function use(name) {
  refuse();
  ownerDid('bc channel', name ? `use ${name}` : 'off');
  try {
    const r = await useChannel(name);
    const moved = r.moved ? ` ${r.moved} reminder${r.moved === 1 ? '' : 's'} and watch${r.moved === 1 ? '' : 'es'} moved with you.` : '';
    console.log(
      name
        ? `${pc.green('●')} ${name} is now the channel in use.${moved}`
        : `No channel is in use now. Everything is still kept, and shown in bc chat.${moved}`,
    );
    if (r.from !== r.to) console.log(pc.dim('Restart the agent for it to take effect: bc restart agent'));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
