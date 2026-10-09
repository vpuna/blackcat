import { chatHooks } from './hooks.js';
import os from 'node:os';
import path from 'node:path';
import { HOME } from '../config.js';
import { loaded, makeCtx, mountOf } from '../plugins/registry.js';
import { readDirs } from './files.js';
import { activeName, labelOf } from './registry.js';
import { notesOf } from '../plugins/notes.js';
import { log } from '../log.js';

// The chat's own commands. Plugins add theirs (`chat.commands` in the manifest).
// chatCommands() feeds /help, the channel's command menu and the prompt
// the agent gets, so they can't drift apart.
export const CHAT_COMMANDS = [
  { command: 'help', description: 'What I can do, and these commands' },
  { command: 'setup', description: 'Set up plugins by answering questions here' },
  { command: 'cancel', description: 'Stop a /setup that is in progress' },
  { command: 'permissions', description: 'What I may always or never do without asking; remove any' },
  { command: 'status', description: 'Health of the machine I run on: uptime, temperature, load, memory' },
  { command: 'new', description: 'Start a fresh conversation (memories are kept)' },
  { command: 'resume', description: 'Go back to an earlier conversation and carry on' },
  { command: 'ping', description: 'Check that I am alive' },
];

// `own: false` leaves out commands that plugins compute from their settings (shortcuts).
export function chatCommands({ own = true } = {}) {
  const [help, ...rest] = CHAT_COMMANDS;
  const fromPlugins = loaded().flatMap((p) => {
    const c = chatHooks(p).commands ?? [];
    if (typeof c !== 'function') return c;
    try {
      return own ? c(makeCtx(p)) : [];
    } catch {
      return [];
    }
  });
  return [help, ...fromPlugins, ...rest];
}

// Tell the channel what to show in its menu of commands. Called when the list changes (a
// shortcut added); the agent service does it at start-up. → false if there is no channel.
export async function refreshMenu() {
  const { ui } = await import('./desk.js');
  const { ensureCarrier } = await import('./registry.js');
  if (!(await ensureCarrier().catch(() => false))) return false;
  return ui.setMenu([...chatCommands(), ...directCommands({ all: false })]).then(
    () => true,
    () => false,
  );
}

// blackcat's own commands, which the owner can type in the chat to run them directly
// (the agent is not involved): one per plugin, e.g. /backup now. See tg/direct.js.
// (`all: false` leaves out a name that is already listed with a screen of its own, like /watch:
// one line for it in the menu, not two.)
export function directCommands({ all = true } = {}) {
  const seen = new Map();
  const listed = all ? new Set() : new Set(chatCommands().map((c) => c.command));
  for (const p of loaded()) {
    const mount = mountOf(p.manifest);
    // A chat command is letters, digits and _ only. A plugin called anything else (my-plugin) is
    // still reached with /bc my-plugin …; one such name must not cost the owner the whole menu.
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(mount[0])) continue;
    if (listed.has(mount[0])) continue;
    const example = Object.keys(p.manifest.commands).find(
      (n) =>
        !p.manifest.commands[n].interactive &&
        !p.manifest.commands[n].form &&
        !/</.test(p.manifest.commands[n].usage ?? '') &&
        !p.manifest.commands[n].raw,
    );
    if (!seen.has(mount[0]))
      seen.set(mount[0], {
        command: mount[0],
        description: `${p.manifest.title} commands, e.g. /${mount.join(' ')} ${example ?? ''}`.trim(),
      });
  }
  return [...seen.values(), { command: 'bc', description: 'Any blackcat command, e.g. /bc plugin list' }];
}

const tilde = (p) => p.replace(os.homedir(), '~');
const folders = () => [tilde(path.join(HOME, 'agent')), ...readDirs().map(tilde)].join(', ');

// A section of the agent's instructions per enabled plugin, generated from its manifest:
// its commands, what the agent may do with each, and the plugin's own notes.
function pluginNotes(surface) {
  const plugins = loaded();
  if (!plugins.length) return [];
  const out = [
    '',
    '# Plugins',
    '',
    'What you can do beyond chatting and reading files comes from these plugins, which the owner has enabled. Run their commands exactly as shown, one plain command at a time (nothing chained, piped or redirected; put any arguments in quotes), with `--json` added: you get a structured answer.',
    // Said once, so that it need not be said for every command of every plugin.
    'Each section below gives the words that follow `blackcat` and then its commands, grouped by what happens when you run one: **Run** (it runs), **Asks first** (the owner is asked to approve it, and it runs if they do), **Depends** (which of those depends on the arguments: the notes say), and **Owner only** (you cannot run these: the owner does, with `bc <those words> <command>` on this machine, or /setup in the chat for the ones that are a setup).',
    'Every section also has `status` (how it is doing right now) and `settings` (how it is set up; secrets are named, never shown), which run.',
  ];
  for (const p of plugins) {
    const m = p.manifest;
    const at = mountOf(m).join(' ');
    out.push('', `## ${m.title} (\`blackcat ${at} …\`)`, m.description);
    const groups = { run: [], ask: [], depends: [] };
    const ownerOnly = [];
    // `agent.listCommands: false`: the notes say what the agent needs (see the sources),
    // so only the commands it can't run are named.
    const listed = m.agent?.listCommands !== false;
    for (const [name, c] of Object.entries(m.commands)) {
      if (c.hidden) continue;
      const group = c.interactive
        ? null
        : typeof c.access === 'function'
          ? 'depends'
          : c.access === 'allow'
            ? 'run'
            : c.access === 'ask'
              ? 'ask'
              : null;
      if (!group) ownerOnly.push(name);
      // (The two every section has are said once, above; a plugin's own version of one is listed like any other.)
      else if (listed && !(c.standard && (name === 'status' || name === 'settings')))
        groups[group].push(`- \`${name}${c.usage ? ` ${c.usage}` : c.raw ? ' …' : ''}\`: ${c.summary}`);
    }
    for (const [key, title] of [
      ['run', 'Run:'],
      ['ask', 'Asks first:'],
      ['depends', 'Depends:'],
    ])
      if (groups[key].length) out.push(title, ...groups[key]);
    if (ownerOnly.length) out.push(`Owner only: ${ownerOnly.join(', ')}.`);
    // Its notes: the file beside it (agent.md), with what the plugin fills in.
    let notes = null;
    try {
      notes = notesOf(p, makeCtx(p, { caller: 'agent', surface }));
    } catch (e) {
      log(`the notes of ${p.name} were left out: ${e.message}`);
    }
    if (notes) out.push('', notes);
  }
  return out;
}

export function helpText() {
  return [
    '🐈‍⬛ blackcat, your home agent on this machine',
    '',
    "Just type to talk to me. I'm an AI model running for you on this machine, and I remember our conversation.",
    '',
    'Commands',
    ...chatCommands().map((c) => `/${c.command} – ${c.description}`),
    '',
    'Run a command directly (no AI involved; the same commands as `bc …` on this machine)',
    ...directCommands({ all: false }).map((c) => `/${c.command} – ${c.description}`),
    'Type one on its own (e.g. /backup) to see what it can do, or with help after it (/backup help) for everything, with examples.',
    '',
    'What I can do',
    '• Chat and answer questions',
    `• Read and look at files in ${folders()}`,
    '• Remember things you tell me, even after /new',
    '• Look at photos, PDFs and documents you send me here',
    '• Listen: send a voice note instead of typing (it is transcribed on this machine, nothing is sent elsewhere)',
    // One line per enabled plugin, in its own words.
    ...loaded().map((p) => `• ${p.manifest.title}: ${p.manifest.description}`),
    '',
    'With your approval',
    '• Run commands or change files: I send you the exact action and nothing happens until you allow it. For a command you can also answer Always or Never; /permissions shows those and lets you take them back',
    '',
    "What I can't do",
    '• Read passwords, keys or my own config, or change my own code and rules',
    '• Use the web, or send messages or email as you, on any service',
    '• Watch videos you send me',
  ].join('\n');
}

// Appended to the agent's instructions on every start, so its idea of the chat's
// commands and its readable folders always matches the running config.
// Where the owner's chat is, in a word: the channel in use, by what it calls itself.
const terminalNote = (chat) => [
  '',
  '# This conversation is in a terminal',
  `The owner is talking to you through \`bc chat\`, in a terminal on this machine, not in ${chat ?? 'a chat'}. Only the owner can do that, so treat what they type here exactly as you would their messages in the chat. Differences:`,
  '- The slash commands above work here too: the owner types them in the terminal, and they are handled without you.',
  '- `[[send: path]]` shows the owner the path instead of delivering the file. Say where the file is.',
  '- Approvals are asked here in the terminal, not with buttons.',
  ...(chat
    ? [
        `- What blackcat sends by itself (reminders, reports, alerts) still goes to ${chat}.`,
        `- This is a separate conversation from the one in ${chat}. You share long-term memory with it, but not what was said there.`,
      ]
    : []),
  '- Write plain text for a terminal: no emoji-heavy formatting, and short lines of commands are fine.',
];

export function runtimePrompt({ surface = 'chat' } = {}) {
  const chat = activeName() ? labelOf(activeName()) : null;
  return [
    '# blackcat runtime (generated by blackcat)',
    '',
    chat
      ? `The owner's chat with you is on ${chat}.`
      : 'No chat is set up: the owner talks to you in a terminal only, and nothing can be pushed to them.',
    'Commands the owner can type there. They are handled directly; they never reach you:',
    ...chatCommands().map((c) => `- /${c.command}: ${c.description}`),
    `- ${directCommands()
      .map((c) => `/${c.command}`)
      .join(
        ', ',
      )}: followed by a blackcat command ("/backup now"), these run it directly as the owner, without you. If the owner asks how to do something without waiting for you, this is how.`,
    '',
    `You are running on the machine called "${os.hostname()}" (${os.type()}, ${os.arch()}).`,
    `Folders you can read, and send files from: ${folders()}`,
    '',
    ...pluginNotes(surface),
    '',
    surface === 'terminal'
      ? 'If the owner asks what you can do, answer briefly.'
      : 'If the owner asks what you can do, answer briefly and mention /help for the full list.',
    ...(surface === 'terminal' ? terminalNote(chat) : []),
  ].join('\n');
}
