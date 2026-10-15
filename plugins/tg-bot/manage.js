import { botOptions } from './api.js';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { Bot } from 'grammy';
import { errMsg, prompts } from '../../src/api.js';

// (The prompt library is loaded only by commands that ask questions in a terminal.)
const { orExit } = await prompts();
import { ownerOf } from './pair.js';

export async function status(ctx) {
  const tg = { ...ctx.config.get(), token: ctx.secrets.get('token') };
  p.intro(pc.bgMagenta(pc.black(' blackcat · telegram ')));
  if (!tg.token) {
    p.outro(`No bot configured. Run ${pc.cyan('bc tg bot pair')}.`);
    return;
  }

  const s = p.spinner();
  s.start('Checking bot');
  try {
    const me = await new Bot(tg.token, botOptions()).api.getMe();
    s.stop(`Bot ${pc.cyan('@' + me.username)} ${pc.green('● token valid')}`);
  } catch (e) {
    s.error(`Bot @${tg.bot} ${pc.red('● ' + errMsg(e))}`);
  }

  const users = tg.allow ?? [];
  p.note(
    users.length
      ? users.map((u) => `${pc.green('●')} ${u.name}  ${pc.dim(`id ${u.id} · paired ${u.pairedAt.slice(0, 10)}`)}`).join('\n')
      : pc.yellow('Nobody paired yet'),
    'Paired accounts',
  );
  p.outro('');
}

export async function unpair(ctx) {
  const users = ctx.config.get().allow ?? [];
  p.intro(pc.bgMagenta(pc.black(' blackcat · unpair ')));
  if (!users.length) {
    p.outro('Nobody is paired.');
    return;
  }

  const remove = orExit(
    await p.multiselect({
      message: 'Remove which accounts?',
      options: users.map((u) => ({ value: u.id, label: u.name, hint: `id ${u.id}` })),
      required: false,
    }),
  );
  if (!remove.length) {
    p.outro('Nothing changed.');
    return;
  }

  const allow = users.filter((u) => !remove.includes(u.id));
  ctx.config.set({ allow, owner: ownerOf(allow) });
  p.outro(`Removed ${remove.length}. The running bot picks this up straight away.`);
}
