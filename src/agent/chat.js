// `bc chat`: the agent, in a terminal. The same rules, plugins and approvals as on the
// channel in use, and the same things of yours (reminders, watches). It keeps conversations
// of its own; long-term memory is shared.
//
// A conversation here is the terminal acting as a channel (channels/terminal.js): what you
// type goes to the desk like a message on any channel, so a plugin's screens (/remind,
// /watch, /ha), approvals and the quick route all work, with choices as numbered lists.
// `bc chat <one question>` asks it and leaves.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import pc from 'picocolors';
import { setQuiet } from '../log.js';
import { shellTokens } from '../plugins/access.js';
import { loadPlugins, loaded, makeCtx, mountOf } from '../plugins/registry.js';
import { CODE_DIR } from '../service/units.js';
import { logo } from '../logo.js';
import { hasBot, ownerChat } from '../owner.js';
import { fmtWhen } from '../util/when.js';
import { addRule } from './permissions.js';
import { TERMINAL, reply, resetSession, resumeConversation, setApprover, stopAll } from './brain.js';
import { installApprovals } from '../channels/approvals.js';
import { helpText } from '../channels/commands.js';
import { setCarrier, ui } from '../channels/desk.js';
import { extractFiles } from '../channels/files.js';
import { incoming, installFront } from '../channels/front.js';
import { chatHooks } from '../channels/hooks.js';
import { actions } from '../channels/kit.js';
import { installQuick } from '../channels/quick.js';
import { terminalCarrier } from '../channels/terminal.js';
import { recap } from '../conversations/store.js';

const BIN = path.join(CODE_DIR, 'bin/bc.js');
const HELP = `Here in the terminal:
  /<command>   a blackcat command, run directly without the agent: /backup now, /watch list, /bc status
  /setup       set a plugin up by answering its questions
  /new         start a fresh conversation (memories are kept)
  /resume      go back to an earlier conversation and carry on
  /exit        leave (or Ctrl+D)
  Anything else is sent to the agent. When there are choices, answer with a number.`;

// A small "thinking" indicator that can be paused while something is on screen.
function spinner(on) {
  if (!on) return { start() {}, stop() {} };
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let timer = null;
  let i = 0;
  return {
    start() {
      if (timer) return;
      timer = setInterval(() => process.stderr.write(`\r${pc.magenta(frames[i++ % frames.length])} ${pc.dim('thinking')}`), 90);
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
      process.stderr.write('\r\x1b[K');
    },
  };
}

// Where an earlier conversation had got to, for a screen that shows nothing of it.
function recapText(r) {
  const c = r.conversation;
  const before = recap(c.id, 2);
  return [
    pc.dim(
      `Continuing "${c.title}" (${c.turns} turn${c.turns === 1 ? '' : 's'}, last used ${fmtWhen(c.last_ts)})${r.how === 'from the record' ? `, from what was kept of it${r.summarised ? ' (the latest part as it was said, the earlier part as a summary)' : ''}` : ''}.`,
    ),
    ...(c.turns > before.length
      ? [
          pc.dim(
            `  … ${c.turns - before.length} earlier exchange${c.turns - before.length === 1 ? '' : 's'}: bc conversations show ${c.id}`,
          ),
        ]
      : []),
    ...before.map((t) => pc.dim(`  you › ${t.you}\n  blackcat › ${t.reply ?? '(this was not answered)'}`)),
  ].join('\n');
}

export async function chat(words, opts) {
  setQuiet(true);
  const interactive = !!(process.stdin.isTTY && process.stdout.isTTY);
  if (words.length) return oneQuestion(words.join(' '), opts, interactive);
  if (!interactive) {
    console.error('`bc chat` with no message is a conversation, so it needs a terminal. To ask one thing: bc chat <message>');
    process.exit(1);
  }
  await conversation({ input: process.stdin, output: process.stdout, opts, tty: true });
  // the agent gets a moment to save the conversation before we go.
  setTimeout(() => process.exit(0), 1500);
  return undefined;
}

// One question, one answer: `bc chat how hot is the pi`. Approvals are asked here when
// there is a terminal to ask in; with none (a script, a pipe), anything that needs one is refused.
async function oneQuestion(text, opts, interactive) {
  const rl = interactive ? readline.promises.createInterface({ input: process.stdin, output: process.stdout }) : null;
  const spin = spinner(!!process.stderr.isTTY);
  setApprover(async (req) => {
    if (!rl) return { allow: false, note: 'there is no terminal to ask the owner in' };
    spin.stop();
    console.log(`\n${pc.yellow('●')} ${pc.bold(`blackcat wants to ${req.title}`)}${req.root ? pc.red('  (as root)') : ''}`);
    if (req.detail)
      console.log(
        req.detail
          .split('\n')
          .map((l) => `    ${l}`)
          .join('\n'),
      );
    if (req.why) console.log(pc.dim(`  why: ${req.why}`));
    if (req.tainted)
      console.log(
        pc.yellow('  This conversation has read messages or files written by other people. Only allow this if it is what you asked for.'),
      );
    // A shell command can be answered for good; undo with `bc permissions`.
    const a = (await rl.question(req.command ? '  Allow? [y] once  [a] always  [n] not now  [v] never: ' : '  Allow once? [y/N] '))
      .trim()
      .toLowerCase();
    spin.start();
    if (req.command && (a === 'a' || a === 'always')) {
      addRule('allow', req.command, { via: 'terminal' });
      return { allow: true };
    }
    if (req.command && (a === 'v' || a === 'never')) {
      addRule('deny', req.command, { via: 'terminal' });
      return { allow: false, note: 'the owner said never to allow this exact command' };
    }
    return a === 'y' || a === 'yes' ? { allow: true } : { allow: false, note: 'the owner declined this in the terminal' };
  });
  const leave = (code) => {
    rl?.close();
    stopAll();
    setTimeout(() => process.exit(code), 1500);
  };
  if (opts.new) resetSession(TERMINAL);
  if (opts.resume) {
    // Asked for one that is not there, with a question waiting to be put to it: stop, rather than ask it somewhere else.
    const r = opts.resume === true ? null : await resumeConversation(TERMINAL, opts.resume);
    if (!r) {
      console.error(
        opts.resume === true
          ? 'Say which conversation: bc chat --resume <number> <message> (see: bc conversations list --channel terminal)'
          : `There is no conversation ${opts.resume} from the terminal. See: bc conversations list --channel terminal`,
      );
      return leave(1);
    }
    console.log(`${recapText(r)}\n`);
  }
  spin.start();
  try {
    const { text: body, files } = extractFiles(await reply(TERMINAL, text));
    spin.stop();
    if (body) console.log(`\n${body}`);
    for (const f of files) console.log(pc.cyan(`  file: ${f}`));
    console.log();
    return leave(0);
  } catch (e) {
    spin.stop();
    console.error(pc.red(`\n${e.message}\n`));
    return leave(1);
  }
}

// A conversation: the terminal as a channel. Resolves when the owner leaves.
//   input, output: where to read and write (the terminal; streams in a test)
//   tty: it is a real terminal (a prompt, a spinner, commands run with the screen to themselves)
export async function conversation({ input, output, opts = {}, tty = false }) {
  const rl = readline.createInterface({ input, output, terminal: tty, prompt: pc.magenta('you › ') });
  const spin = spinner(tty && !!process.stderr.isTTY);
  // Something to show, whenever it comes: over the prompt, which is then put back.
  // (At a terminal a blank line is left before the prompt, so that an answer and what is
  // typed next are apart; two things said one after the other still have one line between them.)
  let gap = false;
  const write = (text) => {
    if (tty) output.write('\r\x1b[K');
    if (tty && gap) text = text.replace(/^\n/, '');
    output.write(text.endsWith('\n') ? text : `${text}\n`);
    if (tty) {
      output.write('\n');
      gap = true;
      rl.prompt(true);
    }
  };
  await loadPlugins();
  setCarrier(terminalCarrier({ write, busy: (on) => (on ? spin.start() : spin.stop()) }));

  // ---- what the owner can do here: the same as on any channel, plus what a terminal adds ----
  const approvals = installApprovals();

  // A blackcat command typed with a slash runs directly, with the terminal to itself (so
  // ones that ask questions or draw a QR code work here, unlike in a chat window).
  const run = (words) => {
    spin.stop();
    if (tty) {
      rl.pause();
      spawnSync(process.execPath, [BIN, ...words], { stdio: 'inherit', env: { ...process.env, BLACKCAT_CALLER: '' } });
      rl.resume();
      output.write('\n');
      rl.prompt();
    } else {
      const r = spawnSync(process.execPath, [BIN, ...words], {
        encoding: 'utf8',
        env: { ...process.env, BLACKCAT_CALLER: '', NO_COLOR: '1' },
      });
      write(`${r.stdout}${r.stderr}`.trimEnd());
    }
  };
  const typed = (first) => (c) => {
    const rest = shellTokens(c.args);
    if (!rest) return c.reply("I couldn't read that. Put an argument that contains spaces or symbols in single quotes.");
    if (first === 'chat' || rest[0] === 'chat') return c.reply('You are in it.');
    return run(first ? [first, ...rest] : rest);
  };

  // /setup: the plugins' setup commands, each run as it would be from the command line
  // (questions asked properly, a password not shown as it is typed).
  ui.command('setup', (c) => {
    const kb = actions();
    for (const p of loaded())
      for (const [name, def] of Object.entries(p.manifest.commands))
        if (def.form) kb.add(`${p.manifest.title}: ${def.summary}`.slice(0, 70), `tsetup:${p.name}:${name}`).row();
    return kb.list.length
      ? c.reply('⚙️ Setup. What do you want to do?', { actions: kb })
      : c.reply('Nothing to set up here yet. Enable a plugin first: bc plugin list');
  });
  ui.action(/^tsetup:([a-z0-9-]+):([a-z0-9-]+)$/, (c) => {
    const p = loaded().find((x) => x.name === c.match[1]);
    return p ? run([...mountOf(p.manifest), c.match[2]]) : c.reply('That is no longer available.');
  });
  ui.command('help', (c) => c.reply(`${helpText()}\n\n${HELP}`));
  ui.command('cancel', (c) => c.reply('Nothing to cancel.'));

  // Plugins add their own screens and commands (reminders, watches, …).
  for (const p of loaded()) {
    try {
      await chatHooks(p).install?.(ui, { ctx: makeCtx(p, { caller: 'owner', surface: 'terminal' }) });
    } catch (e) {
      write(pc.red(`plugin ${p.name} could not set up its part of the chat: ${e.message}`));
    }
  }
  ui.command('bc', (c) => (c.args.trim() ? typed(null)(c) : run(['--help'])));
  for (const first of new Set([
    ...loaded().map((p) => mountOf(p.manifest)[0]),
    'status',
    'logs',
    'plugin',
    'memory',
    'permissions',
    'restart',
    'start',
    'stop',
    'service',
    'channel',
  ]))
    ui.command(first, typed(first));
  // A shortcut of the owner's (/door) is taken by the shortcut plugin, as on any channel.
  installQuick();
  installFront({ approvals });

  // ---- begin ----
  output.write(`\n${logo('in this terminal · /help · /exit')}\n\n`);
  // With no channel in use, this is where what was waiting for the owner arrives: each part
  // that had something to send, and nowhere to send it, hands it over now (`waiting`).
  if (!hasBot()) {
    for (const p of loaded()) {
      if (!p.manifest.waiting) continue;
      try {
        const w = await p.manifest.waiting(makeCtx(p, { caller: 'owner', surface: 'terminal' }));
        if (!w?.lines?.length) continue;
        output.write(`${pc.yellow(w.heading ?? `${p.manifest.title}:`)}\n`);
        for (const l of w.lines) output.write(`   ${l.text}${l.note ? `  ${pc.dim(`· ${l.note}`)}` : ''}\n`);
        output.write('\n');
      } catch (e) {
        output.write(pc.dim(`(${p.manifest.title} could not say what was waiting: ${e.message})\n`));
      }
    }
  }
  if (opts.new) resetSession(TERMINAL);
  const say = (text) =>
    incoming({ chat: ownerChat(), conversation: TERMINAL, who: 'you', ref: null, text }).catch((e) => write(pc.red(`😿 ${e.message}`)));
  if (opts.resume && opts.resume !== true) {
    const r = await resumeConversation(TERMINAL, opts.resume);
    output.write(r ? `${recapText(r)}\n\n` : pc.red(`There is no conversation ${opts.resume} from the terminal.\n\n`));
  } else if (opts.resume) await say('/resume');

  return new Promise((resolve) => {
    let left = false;
    const leave = () => {
      if (left) return;
      left = true;
      spin.stop();
      approvals.cancel(null, '🚫 Left the terminal, nothing was done');
      for (const p of loaded()) Promise.resolve(chatHooks(p).stop?.()).catch(() => {});
      stopAll();
      rl.close();
      resolve();
    };
    rl.on('line', (raw) => {
      gap = false;
      const line = raw.trim();
      if (line === '/exit' || line === '/quit') return leave();
      if (!line) return void (tty && rl.prompt());
      return void say(line);
    });
    rl.on('close', leave); // Ctrl+D or Ctrl+C
    if (tty) rl.prompt();
  });
}
