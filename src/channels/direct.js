import { ui } from './desk.js';
import { actions } from './kit.js';
import { esc } from '../util/format.js';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { log } from '../log.js';
import { levelOf, shellTokens, stripJson } from '../plugins/access.js';
import { startSetup } from './setup.js';
import { findCommand, loaded, mountOf } from '../plugins/registry.js';
import { CODE_DIR } from '../service/units.js';

// Direct commands: the owner types a blackcat command in the chat (`/backup now`,
// `/watch show 2`, `/bc plugin list`) and the bot runs it as-is and replies with what it
// printed. the agent is not involved, and nothing here is reachable by it: these are incoming
// messages from the owner, which the bot's middleware has already checked.
//
// The command runs as the owner, exactly as it would in a terminal. One that changes
// something outside blackcat (the same test the agent's policy uses) first asks for a
// confirming tap, because a typo is easy to make on a phone.

const BIN = path.join(CODE_DIR, 'bin/bc.js');
const TIMEOUT_MS = 15 * 60_000;

// Not from a chat: they need a terminal, or they would take the bot down under itself.
const TERMINAL_ONLY = [
  [/^chat\b/, 'that is the terminal chat'],
  [/^tg bot\b/, "the bot can't re-pair or unpair itself"],
  [/^(stop|start)\b/, 'stopping the agent from here would leave nothing to start it again'],
  [/^service\b/, 'it asks questions as it goes'],
  [/^engine use\b/, 'which engine runs the model is changed in a terminal, where it is checked first and you decide'],
];

// (`started`: handed the running command, for whoever may want to stop it.)
const run = (argv, chatId, { started } = {}) =>
  new Promise((resolve) => {
    const env = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', BLACKCAT_CHAT_ID: String(chatId) };
    delete env.BLACKCAT_CALLER; // the owner typed it
    const child = spawn(process.execPath, [BIN, ...argv], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    started?.(child);
    let out = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS);
    const add = (d) => (out = (out + d).slice(-60_000));
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    child.on('error', (e) => resolve({ code: 1, out: e.message }));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out });
    });
  });

// A command that fetches a file for the owner (`sends: true`: a camera picture, a night's
// star trails) is asked for its result as data, and the file is sent with its caption.
async function runAndSend(c, argv) {
  log(`← ${c.who} ran: bc ${argv.join(' ')}`);
  const typing = setInterval(() => c.working().catch(() => {}), 4000);
  c.working().catch(() => {});
  const r = await run([...argv, '--json'], c.chat);
  clearInterval(typing);
  let d = null;
  try {
    d = JSON.parse(r.out.slice(r.out.indexOf('{')));
  } catch {}
  if (r.code !== 0 || !d?.path)
    return c.reply(`😿 ${d?.error ?? (r.out.trim().slice(-600) || `It failed (exit ${r.code}) without saying why.`)}`);
  return c.sendFile(String(d.path), d.caption ? String(d.caption).slice(0, 900) : undefined);
}

async function runAndReply(c, argv) {
  log(`← ${c.who} ran: bc ${argv.join(' ')}`);
  const typing = setInterval(() => c.working().catch(() => {}), 4000);
  c.working().catch(() => {});
  const r = await run(argv, c.chat);
  clearInterval(typing);
  // Terminal output: strip colour codes and cursor movement, keep the layout.
  const text =
    r.out
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\r/g, '')
      .trim() || (r.code === 0 ? 'Done.' : `It failed (exit ${r.code}) without saying why.`);
  for (let i = 0; i < text.length; i += 3800) await c.reply(`<pre>${esc(text.slice(i, i + 3800))}</pre>`, { html: true, preview: false });
}

const usageOf = (p, name) => {
  const def = p.manifest.commands[name];
  return `/${mountOf(p.manifest).join(' ')} ${name}${def.usage ? ` ${def.usage}` : def.raw ? ' …' : ''}`;
};

// `/backup` on its own: what it can do. Commands that need nothing more get a button.
function menu(c, plugins, first) {
  const kb = actions();
  const lines = [];
  let n = 0;
  for (const p of plugins) {
    for (const [name, def] of Object.entries(p.manifest.commands)) {
      if (def.hidden) continue;
      const where = def.interactive ? ' (terminal only)' : '';
      lines.push(`${esc(usageOf(p, name))}${where}\n    ${esc(def.summary)}`);
      const needsArgs = def.raw || /</.test(def.usage ?? '');
      if (!def.interactive && !needsArgs) {
        kb.add(`${mountOf(p.manifest).slice(1).concat(name).join(' ')}`, `dc:${p.name}:${name}`);
        if (++n % 3 === 0) kb.row();
      }
    }
  }
  return c.reply(
    `<b>/${esc(first)}</b>\n\n${lines.join('\n')}\n\nTap one, or type it with its arguments. /${esc(first)} help says more, with examples; add --help to any one of them for its options.`,
    { html: true, actions: kb },
  );
}

export function installDirect() {
  const pending = new Map(); // id → argv waiting for a confirming tap
  const running = new Map(); // id → a long command that is still going, which can be stopped
  const stopped = new Set(); // ids of those the owner stopped

  // A command that takes minutes (`long: true` in its manifest: the engine check). The chat is
  // not kept waiting for it: it is started, the owner carries on, and what it printed is sent
  // when it ends. Until then it can be stopped.
  async function runLong(c, argv) {
    log(`← ${c.who} started: bc ${argv.join(' ')}`);
    const id = crypto.randomBytes(5).toString('hex');
    const chat = c.chat;
    await c.reply(
      `⏳ Started:\n<pre>bc ${esc(argv.join(' '))}</pre>\nIt takes a few minutes. Carry on meanwhile: I will send what it finds when it is done.`,
      { html: true, actions: actions().add('✖ Stop it', `dl:${id}`) },
    );
    run(argv, chat, { started: (child) => running.set(id, child) }).then(async (r) => {
      running.delete(id);
      const text =
        r.out
          .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
          .replace(/\r/g, '')
          .trim() || (stopped.delete(id) ? 'Stopped.' : r.code === 0 ? 'Done.' : `It failed (exit ${r.code}) without saying why.`);
      stopped.delete(id);
      for (let i = 0; i < text.length; i += 3800)
        await ui
          .send(chat, `<pre>${esc(text.slice(i, i + 3800))}</pre>`, { html: true, preview: false })
          .catch((e) => log(`could not send the result of bc ${argv[0]}: ${e.message}`));
    });
  }

  async function handle(c, words) {
    const line = words.join(' ');
    const blocked = TERMINAL_ONLY.find(([re]) => re.test(line));
    if (blocked) return c.reply(`That one is for a terminal on this machine: ${blocked[1]}.\n\nbc ${line}`);

    // Restarting the agent restarts this bot, so the answer has to come first.
    if (/^restart\b/.test(line)) {
      await c.reply(`Restarting${words[1] ? ` ${words[1]}` : ''}. I'll be back in a few seconds.`);
      spawn(process.execPath, [BIN, ...words], { detached: true, stdio: 'ignore' }).unref();
      return undefined;
    }

    const found = findCommand(words);
    if (found) {
      const { plugin, command, rest } = found;
      const def = plugin.manifest.commands[command];
      // "help" after any of them (or --help): everything it does, as `bc … help` prints it. And
      // "help <command>": that command's options.
      if (!def && ['help', '--help', '-h'].includes(command)) return runAndReply(c, words);
      if (!command || !def)
        return menu(
          c,
          loaded().filter(
            (p) => mountOf(p.manifest)[0] === words[0] && mountOf(p.manifest).every((w, i) => words[i] === undefined || words[i] === w),
          ),
          words.slice(0, mountOf(plugin.manifest).length).join(' '),
        );
      const wantsHelp = rest.includes('--help') || rest.includes('-h');
      if (def.interactive && !wantsHelp)
        return c.reply(
          `"${command}" shows things step by step (a QR code, a list to tick), so it needs a terminal on this machine:\n\nbc ${line}`,
        );
      // A setup with questions and no answers given: ask them here, with buttons.
      if (def.form && !rest.length) return startSetup(c, plugin, command);
      // Would the agent have had to ask? Then so do we, once.
      const level = wantsHelp ? 'allow' : levelOf(plugin, command, stripJson(rest).tokens, 'owner').level;
      if (level === 'ask' || level === 'never') {
        const id = crypto.randomBytes(5).toString('hex');
        pending.set(id, words);
        setTimeout(() => pending.delete(id), 5 * 60_000).unref();
        return c.reply(`This changes something:\n<pre>bc ${esc(line)}</pre>`, {
          html: true,
          actions: actions().add('▶️ Run it', `dr:${id}:y`).add('✖ Cancel', `dr:${id}:n`),
        });
      }
    }
    const def = found?.command ? found.plugin.manifest.commands[found.command] : null;
    if (def?.long && !found.rest.includes('--help') && !found.rest.includes('-h')) return runLong(c, words);
    if (def?.sends && !found.rest.includes('--help') && !found.rest.includes('-h') && !found.rest.includes('--json'))
      return runAndSend(c, words);
    return runAndReply(c, words);
  }

  const onCommand = (first) => async (c) => {
    const rest = shellTokens(String(c.match ?? ''));
    if (!rest)
      return c.reply(
        "I couldn't read that. Put an argument that contains spaces or symbols in single quotes, and leave out ; | & < > $ ( ).",
      );
    return handle(c, first ? [first, ...rest] : rest);
  };

  // /bc <anything>: the whole command line. `/bc` alone lists what there is.
  ui.command('bc', async (c) => {
    if (!String(c.match ?? '').trim()) return runAndReply(c, ['--help']);
    return onCommand(null)(c);
  });
  // /backup …, /watch …, /unifi …: one per plugin, the same words as on this machine.
  for (const first of new Set(loaded().map((p) => mountOf(p.manifest)[0]))) ui.command(first, onCommand(first));

  ui.action(/^dc:([a-z0-9-]+):([a-z0-9-]+)$/, async (c) => {
    const p = loaded().find((x) => x.name === c.match[1]);
    if (!p?.manifest.commands[c.match[2]]) return c.toast('That is no longer available.');
    await c.toast();
    return handle(c, [...mountOf(p.manifest), c.match[2]]);
  });
  ui.action(/^dr:([0-9a-f]+):([yn])$/, async (c) => {
    const words = pending.get(c.match[1]);
    pending.delete(c.match[1]);
    await c.toast(!words ? 'That is no longer waiting.' : c.match[2] === 'y' ? 'Running' : 'Cancelled');
    await c.clearActions().catch(() => {});
    if (words && c.match[2] === 'y') return runAndReply(c, words);
    return undefined;
  });
  // "Stop it" under a long command: it is told to end, tidies up after itself, and says so.
  ui.action(/^dl:([0-9a-f]+)$/, async (c) => {
    const child = running.get(c.match[1]);
    await c.toast(child ? 'Stopping it…' : 'That has already finished.');
    await c.clearActions().catch(() => {});
    if (child) (stopped.add(c.match[1]), child.kill('SIGTERM'));
    return undefined;
  });
}
