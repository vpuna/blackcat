import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA, HOME as BC_HOME } from '../config.js';
import { pluginAccess, shellTokens } from '../plugins/access.js';
import { readDirs } from '../channels/files.js';
import { everyKnown, loaded, makeCtx, mountOf } from '../plugins/registry.js';
import { ruleFor } from './permissions.js';
import { CODE_DIR } from '../service/units.js';
import { resolveHome } from '../util/paths.js';

// What happens when the agent wants to do something Claude Code doesn't already
// allow: ask the owner in Telegram, or refuse without asking.
//
// Refusing without asking covers things that should never be approved from a chat
// window, whatever the reason given: reading secrets, and changing blackcat's own
// code, rules, services or links. Those are done by the owner in a terminal.
//
// The Bash checks are pattern matches on the command text, so they are a backstop,
// not a guarantee. The real control is that the owner sees the exact command
// before anything runs.

const home = os.homedir();
const under = (p, dir) => p === dir || p.startsWith(dir + path.sep);
const resolve = resolveHome;

// Never readable: credentials and the raw archive (the agent uses `blackcat wa …` instead).
const SECRET_PATHS = [
  path.join(DATA, 'config.json'),
  path.join(DATA, 'plugins'),
  path.join(home, '.ssh'),
  path.join(home, '.gnupg'),
  path.join(home, '.claude.json'),
  path.join(home, '.claude', '.credentials.json'),
  '/etc/shadow',
  '/etc/sudoers',
  '/etc/sudoers.d',
];
// Inside blackcat's data folder only these are for the agent to read: files the owner sent,
// media fetched on request, camera snapshots and what shortcuts fetched. Everything else
// there (settings, logins, databases, plugin secrets, backups in progress) is private.
// The exceptions: folders of files the agent may look at and send. The core's own, and one
// per plugin that asks for it, which can only ever be `data/<the plugin's name>-media`: a
// plugin cannot open any other part of the data folder (its secrets, another plugin's) by
// declaring it.
const CORE_OPEN = ['inbox', 'archive-media', 'shortcut-files'];
export function openDataFolders() {
  const names = [...CORE_OPEN];
  for (const p of loaded()) {
    const mine = `${p.name}-media`;
    try {
      const dirs = p.manifest.agent?.readDirs?.(makeCtx(p, { caller: 'agent' })) ?? [];
      if (dirs.some((d) => path.resolve(String(d)) === path.join(DATA, mine))) names.push(mine);
    } catch {}
  }
  return names;
}
const dataReadable = () => openDataFolders().map((d) => path.join(DATA, d));
export const isSecret = (p) => SECRET_PATHS.some((s) => under(p, s)) || (under(p, DATA) && !dataReadable().some((d) => under(p, d)));

// Never writable by the agent: blackcat itself and how Claude Code is configured.
const SELF_PATHS = [
  // All of blackcat: code, rules, the readers' prompts, tests, data.
  CODE_DIR,
  DATA,
  // Its rules, wherever this installation keeps them (the same place as the code, normally).
  path.join(BC_HOME, 'agent'),
  // How Claude Code is set up and instructed.
  ...['settings.json', 'settings.local.json', 'CLAUDE.md', 'commands', 'agents', 'skills', 'hooks', 'plugins'].map((f) =>
    path.join(home, '.claude', f),
  ),
  // Anything that runs by itself when the owner logs in or opens a shell.
  ...[
    '.bashrc',
    '.bash_profile',
    '.bash_login',
    '.bash_aliases',
    '.bash_logout',
    '.profile',
    '.zshrc',
    '.zprofile',
    '.zshenv',
    '.zlogin',
    '.inputrc',
    '.pam_environment',
    '.xprofile',
    '.xinitrc',
  ].map((f) => path.join(home, f)),
  path.join(home, '.config', 'systemd'),
  path.join(home, '.config', 'autostart'),
  path.join(home, '.config', 'environment.d'),
  path.join(home, '.local', 'bin'),
  path.join(home, 'bin'),
];
const isSelf = (p) => SELF_PATHS.some((s) => under(p, s));

// Bash commands refused on sight. Each pattern is tried on the command as written and on
// the command with quotes and backslashes taken out, so `da''ta` or 'blackcat-ag'ent hides nothing.
const BLACKCAT = String.raw`(blackcat|bc|bc\.js)`;
const START = String.raw`(^|[\s;&|(` + '`' + String.raw`$/])`; // also after a "/", so /usr/local/bin/blackcat and bin/bc.js count
const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BASH_NEVER = [
  // Managing blackcat. (What is the owner's alone among the plugins' commands is in ownersRules() below.)
  [
    new RegExp(`${START}${BLACKCAT}\\s+(service\\b|chat\\b|channel\\b|notify\\b|permissions\\b|start\\b|stop\\b|restart\\b)`),
    'managing blackcat itself is done from a terminal, not through the agent',
  ],
  [new RegExp(`${START}${BLACKCAT}\\s+plugin\\b`), 'plugins are enabled and disabled by the owner'],
  [/blackcat-[a-z0-9-]+\.service\b|blackcat-agent\b/, "blackcat's own services are managed from a terminal"],
  [
    /\b(pkill|killall|kill|systemctl|loginctl)\b[^|;&]*\b(bc\.js|blackcat|claude)\b/,
    "blackcat's own processes are managed from a terminal",
  ],
  // Who a command runs as is decided by blackcat, not by the command.
  [/BLACKCAT_(CALLER|HOME|CHAT_ID)/, "the agent can't change how a blackcat command is run"],
  // Its code and private data, by any path: absolute, or relative to the folder the agent runs in.
  [
    /blackcat\/(src|bin|agent|plugins|user-plugins|prompts|test|node_modules|\.git)\b/,
    "blackcat's own code and rules are off-limits to the agent",
  ],
  [
    /(^|[\s/'"=<>(])data\/(config\.json|permissions\.json|plugins|backup-tmp|[\w.-]*\.db)\b/,
    "blackcat's private data is off-limits to the agent",
  ],
  [
    /(^|[\s'"=<>(])\.\.\/(src|bin|plugins|user-plugins|prompts|test|node_modules|\.git)\b/,
    "blackcat's own code and private data are off-limits to the agent",
  ],
  // The names of the private files themselves, however the path to them is put together
  // (a variable, a cd first, a wildcard for the folder).
  [
    /(^|[^\w.-])(config\.json(\.[\w.]*)?|permissions\.json|secrets\.json|(archive|archive-index|wa|wa-index|agent)\.db(-wal|-shm)?)($|[^\w.-])/,
    "blackcat's private files are off-limits to the agent",
  ],
  // Text that is decoded or built and then run can't be read by the owner at approval, so it is never offered for approval.
  [
    /\bbase64\b[^|;&]*\s(-d|-D|--decode)\b|\bxxd\b[^|;&]*\s-r\b|\bopenssl\s+(enc|base64)\b[^|;&]*\s-d\b|(^|[\s;&|(])eval\s|\bfromCharCode\b|\bchr\(\d|\\x[0-9a-fA-F]{2}|\$'[^']*\\/,
    "a command that decodes or builds its own text when it runs can't be reviewed, so it is not run",
  ],
  [
    /(^|[\s/'"=])(\.ssh|\.gnupg|id_(rsa|ed25519|ecdsa)|\.credentials\.json|\.claude\.json|authorized_keys)\b|\/etc\/(shadow|sudoers)/,
    'credentials and keys are off-limits to the agent',
  ],
  // A wildcard inside a hidden folder of the home directory (~/.s*/id_*) could be any of the above.
  [
    /(~|\$HOME|\$\{HOME\}|\/home\/[\w.-]+)\/\.[^\s'"]*[*?[]/,
    'wildcards in hidden folders of the home directory are not allowed: name the file',
  ],
  [
    /\.claude\/(settings(\.local)?\.json|CLAUDE\.md|commands|agents|skills|hooks)\b/,
    "Claude Code's settings and instructions are changed from a terminal",
  ],
  [
    /(^|[\s/'"=>])\.(bashrc|bash_profile|bash_login|bash_aliases|bash_logout|profile|zshrc|zprofile|zshenv|zlogin|pam_environment|xprofile|xinitrc)\b|\.config\/(autostart|systemd|environment\.d)\b/,
    'files that run by themselves at login are changed from a terminal',
  ],
];
// Its data folder, by a path relative to where it runs or named in full: off-limits, but for
// the folders of files it may send (which depend on the plugins that are on, so these two
// are made when asked).
// What plugins declare, held for every plugin blackcat knows of, in use or not: a login it
// left in the data folder is as private with the plugin switched off.
//   - its private folders at the top of the data folder (`privateData`), by name, however
//     the path to them is put together;
//   - its services, which are managed from a terminal;
//   - its commands that are the owner's alone (pairing, unlinking, running a service), caught
//     inside a longer command too.
function declaredRules() {
  const out = [];
  const names = everyKnown()
    .flatMap((p) => p.manifest.privateData ?? [])
    .map((n) => `${esc(n)}${n.endsWith('.db') ? '(-wal|-shm)?' : ''}`);
  if (names.length) {
    out.push([new RegExp(`(^|[\\s/'"=<>(])data\\/(${names.join('|')})\\b`), "blackcat's private data is off-limits to the agent"]);
    out.push([new RegExp(`(^|[^\\w.-])(${names.join('|')})($|[^\\w.-])`), "blackcat's private files are off-limits to the agent"]);
  }
  const services = everyKnown()
    .flatMap((p) => (p.manifest.services ?? []).map((sv) => sv.id))
    .map(esc);
  if (services.length) out.push([new RegExp(`blackcat-(${services.join('|')})\\b`), "blackcat's own services are managed from a terminal"]);
  const owners = [];
  for (const p of everyKnown()) {
    const mount = mountOf(p.manifest).map(esc).join('\\s+');
    const mine = Object.entries(p.manifest.commands)
      .filter(([, c]) => c.interactive || (c.access === 'owner' && !c.form))
      .map(([n]) => esc(n));
    if (mine.length) owners.push(`${mount}\\s+(${mine.join('|')})\\b`);
  }
  if (owners.length)
    out.push([
      new RegExp(`${START}${BLACKCAT}\\s+(${owners.join('|')})`),
      'managing blackcat itself is done from a terminal, not through the agent',
    ]);
  return out;
}
function dataRules() {
  const open = openDataFolders().map(esc).join('|');
  return [
    [new RegExp(`(^|[\\s'"=<>(])\\.\\.\\/data(?!\\/(${open})\\b)\\b`), "blackcat's own code and private data are off-limits to the agent"],
    [new RegExp(`${esc(DATA)}/(?!(${open})(/|$|[\\s'"]))`), "blackcat's private data is off-limits to the agent"],
  ];
}
// ---- what needs nobody's say ----
// blackcat carries out the agent's tool calls itself, so these are its own rules, not an
// engine's: what the agent may look at, write and run without the owner being asked.

// A path with every link followed, so that a link cannot point around a rule. (A file that
// is not there yet is judged by the folder it would be made in.)
function realOf(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(p)), path.basename(p));
    } catch {
      return p;
    }
  }
}
// Its own folders: where its rules are, what the owner sent it and what plugins fetched for
// it. It may look in these freely. (What it remembers is not a folder: `blackcat memory …`.)
const AGENT_DIR = path.join(BC_HOME, 'agent');
const ownFolders = () => [AGENT_DIR, ...readDirs()].map(realOf);

// A command that only says something about the moment or the machine, and can do nothing
// else: one program from a short list, alone on the line (no pipe, no redirection, no
// variable, no substitution: `shellTokens` gives up on any of those), with only the options
// listed. Kept short on purpose: anything not here is put to the owner, as it always was.
const WHEN = /^[\w :+/.,@-]*$/;
const LOOKS = {
  date: (a) =>
    a.every(
      (x, i) =>
        /^(-u|--utc|-R|--rfc-email|-I(date|hours|minutes|seconds|ns)?|--iso-8601(=(date|hours|minutes|seconds|ns))?|--date=[\w :+/.,@-]*|\+[\w%:/ .,@-]*)$/.test(
          x,
        ) ||
        (x === '-d' && i < a.length - 1) ||
        (a[i - 1] === '-d' && WHEN.test(x)),
    ),
  pwd: (a) => !a.length,
  whoami: (a) => !a.length,
  true: (a) => !a.length,
  hostname: (a) => a.every((x) => /^-[fsIiAd]$/.test(x)),
  uname: (a) => a.every((x) => /^-[asnrvmpio]+$/.test(x)),
  uptime: (a) => a.every((x) => /^-[ps]$/.test(x)),
  id: (a) => a.every((x) => /^-[ugGnr]+$/.test(x)),
};
export function plainLook(cmd) {
  const words = shellTokens(String(cmd ?? ''));
  return !!words?.length && Object.hasOwn(LOOKS, words[0]) && LOOKS[words[0]](words.slice(1));
}

const plainOf = (cmd) => cmd.replace(/['"\\]/g, '');
// A blackcat command is only accepted on its own, as `blackcat <plugin> <command> …`: not
// behind env, sudo, sh -c, xargs or a path, where it could be run as someone else or
// escape the checks its plugin asks for.
const wrapped = (plain) => {
  const first = plain.trim().split(/\s+/)[0];
  if (/\bbc\.js\b|\/bin\/blackcat\b/.test(plain)) return true;
  return first !== 'blackcat' && /(^|[\s;&|(`$=])blackcat(\s|$)/.test(plain);
};

// Does it ask to run as root? (`sudo` at the start of a command, of a part of one, or of one given in quotes to a plugin.)
const ASKS_ROOT = /(^|[\s;&|('"])(sudo|doas)\b|\bsu\s+-c\b/;
export const MAX_SHOWN = 3000; // a command longer than this can't be reviewed properly on a phone

function summarise(tool, input) {
  if (tool === 'Bash') {
    const cmd = String(input.command ?? '');
    // Parts that are worked out only when it runs: the text shown is then not the whole story.
    const indirect = /\$\(|`|\$\{?[A-Za-z_]\w*|\b(python3?|node|perl|ruby|php)\s+(-c|-e)\b|\bsh\s+-c\b|\bbash\s+-c\b|\bxargs\b/.test(cmd);
    return { title: 'run a command', detail: cmd, why: input.description ?? null, root: ASKS_ROOT.test(cmd), indirect };
  }
  if (tool === 'Write') return { title: `write the file ${input.file_path}`, detail: String(input.content ?? ''), why: null };
  if (tool === 'Edit')
    return { title: `edit the file ${input.file_path}`, detail: `- ${input.old_string ?? ''}\n+ ${input.new_string ?? ''}`, why: null };
  if (tool === 'Read') return { title: `read the file ${input.file_path}`, detail: '', why: null };
  if (tool === 'Glob' || tool === 'Grep')
    return { title: `search files in ${input.path ?? 'a folder outside its own'}`, detail: String(input.pattern ?? ''), why: null };
  return { title: `use ${tool}`, detail: JSON.stringify(input), why: null };
}

// A standing answer from the owner for this exact command. Only consulted for commands that
// would otherwise be asked about: what the policy refuses outright stays refused.
function standing(cmd) {
  const rule = ruleFor(cmd);
  if (!rule) return null;
  if (rule.effect === 'allow') return { action: 'allow', rule: rule.id };
  return {
    action: 'deny',
    rule: rule.id,
    reason:
      "Not run: the owner has said never to allow this exact command. Don't retry it or try another way to do the same thing. Tell the owner it wasn't done; only they can lift this, with /permissions.",
  };
}

// → { action: 'allow' } | { action: 'deny', reason } | { action: 'ask', title, detail, why, root }
export function decide(tool, input = {}) {
  const deny = (reason) => ({
    action: 'deny',
    reason: `Refused by blackcat's policy without asking the owner: ${reason}. Don't retry or work around it; tell the owner it isn't allowed.`,
  });

  if (tool === 'Bash') {
    const cmd = String(input.command ?? '');
    const plain = plainOf(cmd);
    for (const [re, reason] of [...BASH_NEVER, ...declaredRules(), ...dataRules()]) if (re.test(cmd) || re.test(plain)) return deny(reason);
    if (wrapped(plain))
      return {
        action: 'deny',
        reason:
          'Not run: blackcat commands are run on their own, written as `blackcat <plugin> <command> …`, not through another program or by a path.',
      };
    // A plugin command: its manifest says whether the agent may run it, must ask, or may not.
    const pa = pluginAccess(cmd);
    if (pa) {
      if (pa.level === 'allow') return { action: 'allow' };
      if (pa.level === 'ask') {
        if (cmd.length > MAX_SHOWN) return deny('it is too long to show the owner in full for approval; break it into smaller steps');
        // (As root: said of a command run through a plugin as of one run directly, on this machine or another.)
        const ask = {
          action: 'ask',
          title: `use ${pa.title}: ${pa.describe ?? pa.command}`,
          detail: cmd,
          why: input.description ?? null,
          root: ASKS_ROOT.test(cmd),
        };
        // `once`: the plugin wants the owner asked every single time (a lock, an alarm), so
        // there is no "always" to give and none is honoured.
        return pa.once ? ask : (standing(cmd) ?? { ...ask, command: cmd });
      }
      // Only the way it was written is wrong: say how to write it, rather than "not allowed".
      if (pa.retry) return { action: 'deny', reason: `Not run: ${pa.reason}.` };
      return deny(pa.reason ?? `${pa.title} "${pa.command}" is done by the owner, from a terminal or /setup`);
    }
  } else if (['Write', 'Edit', 'Read', 'Glob', 'Grep'].includes(tool)) {
    const p = resolve(input.file_path ?? input.path);
    // Judged as written and as it really is: a link is followed first.
    const real = realOf(p);
    if (isSecret(p) || isSecret(real)) return deny('credentials, keys and the raw message database are off-limits to the agent');
    if ((tool === 'Write' || tool === 'Edit') && (isSelf(p) || isSelf(real)))
      return deny("the agent can't change blackcat's own code, rules, data or services");
    // In its own folders it may look freely.
    if (['Read', 'Glob', 'Grep'].includes(tool) && ownFolders().some((d) => under(real, d))) return { action: 'allow' };
  } else {
    return deny(`the ${tool} tool isn't available to the agent`);
  }

  const s = summarise(tool, input);
  if (s.detail.length > MAX_SHOWN) return deny('it is too long to show the owner in full for approval; break it into smaller steps');
  // `command` marks a request the owner may answer for good ("always" / "never"): shell commands only.
  if (tool === 'Bash' && plainLook(input.command)) return { action: 'allow' };
  if (tool === 'Bash') return standing(String(input.command ?? '')) ?? { action: 'ask', ...s, command: String(input.command ?? '') };
  return { action: 'ask', ...s };
}

// Would reading this path show something private?
// Symbolic links are followed first, so a link can't point around the check.
// `deep`: the command reads through folders (a recursive search, a copy, an archive), so a
// folder that merely contains private files counts too. Listing such a folder does not.
export function touchesSecrets(file, { deep = false } = {}) {
  let p = resolve(file);
  try {
    p = fs.realpathSync(p);
  } catch {
    // doesn't exist (yet): judge the path as written
  }
  if (isSecret(p)) return true;
  return deep && [...SECRET_PATHS, DATA].some((s) => under(s, p));
}
