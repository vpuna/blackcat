import { classify } from '../util/readonly.js';
import { LEVELS, findCommand, makeCtx } from './registry.js';

// Split a command line into words the way a shell would, but ONLY if it is one plain
// command. Anything that could make the shell do more than run that one program
// (; & | < > ` $ ( ) and newlines outside single quotes) returns null.
export function shellTokens(cmd) {
  const out = [];
  let cur = '';
  let has = false; // the current word exists (it may be an empty quoted string)
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '$' || ch === '`')
        return null; // the shell would expand these
      else if (ch === '\\' && i + 1 < cmd.length && '"\\$`'.includes(cmd[i + 1])) cur += cmd[++i];
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (ch === '\n' || ch === '\r') return null;
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else if (';&|<>`$(){}'.includes(ch)) return null;
    else if (ch === '\\') {
      if (i + 1 >= cmd.length) return null;
      cur += cmd[++i];
    } else cur += ch;
  }
  if (quote) return null;
  if (has || cur) out.push(cur);
  return out;
}

// Arguments reach a command exactly as typed. Only a leading or trailing --json is blackcat's.
export function stripJson(tokens) {
  const t = [...tokens];
  let json = false;
  if (t[0] === '--json') ((json = true), t.shift());
  else if (t.at(-1) === '--json') ((json = true), t.pop());
  return { tokens: t, json };
}

// What a plugin command's manifest says about one invocation. `tainted`: the agent's
// conversation has read what other people wrote.
// → { level: 'allow' | 'ask' | 'owner' | 'never', reason?, describe? }
export function levelOf(plugin, commandName, tokens, caller = 'agent', { tainted = false } = {}) {
  const c = plugin.manifest.commands[commandName];
  if (!c) return { level: 'never', reason: `${plugin.manifest.title} has no "${commandName}" command` };
  let r = c.access;
  if (typeof r === 'function') {
    try {
      r = r(makeCtx(plugin, { caller, tainted }), tokens);
    } catch (e) {
      return { level: 'never', reason: e.message };
    }
  }
  const out = typeof r === 'string' ? { level: r } : r;
  // (An answer that is not a level, a misspelt one say, allows nothing.)
  if (!out || !LEVELS.includes(out.level))
    return { level: 'never', reason: `${plugin.manifest.title} "${commandName}" did not say who may run it` };
  return out;
}

const PROGRAM = /^(?:\S*\/)?(?:blackcat|bc)$/;

// Is this Bash command an invocation of an enabled plugin? If so, how should it be treated?
// → null (not a plugin command), or { plugin, command, tokens, level, reason, describe, title }.
export function pluginAccess(cmd, { tainted = false } = {}) {
  // A quick look first, without full parsing: is it `blackcat <a plugin's first word> …`?
  const m = /^\s*(\S+)\s+(\S+)(?:\s+(\S+))?/.exec(cmd);
  if (!m || !PROGRAM.test(m[1])) return null;
  const guess = findCommand([m[2], m[3]]);
  if (!guess) return null;
  const plugin = guess.plugin;
  // (Said of a plugin that did not come with blackcat, so that a borrowed name cannot pass for the real thing.)
  const title = plugin.bundled ? plugin.manifest.title : `${plugin.manifest.title} (your plugin "${plugin.name}")`;

  const words = shellTokens(cmd);
  if (!words) {
    return {
      plugin,
      title,
      level: 'never',
      retry: true,
      reason: `${title} commands must be run as one plain command, with nothing chained, piped or redirected. Put any argument that contains spaces, quotes or symbols inside single quotes. Run it again that way`,
    };
  }
  const found = findCommand(words.slice(1));
  // Asking what a plugin's commands are, or how one is used, changes nothing and runs
  // nothing: `blackcat ha --help`, `blackcat ha set --help`. Only when --help is all there
  // is after the name, so that it cannot be a way to dress up something else.
  const HELP = ['--help', '-h'];
  if (found && HELP.includes(found.command) && !found.rest.length) return { plugin, title, command: 'help', tokens: [], level: 'allow' };
  if (!found?.command) return { plugin, title, level: 'never', reason: `say which ${title} command to run` };
  const { tokens } = stripJson(found.rest);
  if (plugin.manifest.commands[found.command] && tokens.length === 1 && HELP.includes(tokens[0]))
    return { plugin, title, command: found.command, tokens, level: 'allow' };
  return { plugin, title, command: found.command, tokens, ...levelOf(plugin, found.command, tokens, 'agent', { tainted }) };
}

// How a command may be tried without changing anything (a shortcut tried when it is made):
// as it is, when it only looks; with its own --dry or --dry-run, when the command has one and
// that makes it a look (a routine that stops before the press); else not at all.
// → the command line to run, or null. Standing permissions do not count: only what it is.
const DRY = ['--dry', '--dry-run'];
export function triedAs(cmd) {
  const a = pluginAccess(cmd);
  if (!a) return /^\s*(?:\S*\/)?(?:blackcat|bc)\s/.test(cmd) ? null : classify(cmd) === 'read' ? cmd : null;
  if (a.level === 'allow') return cmd;
  const flags = (a.plugin.manifest.commands[a.command]?.options ?? []).map((o) => o[0].split(/[ ,]/)[0]);
  for (const flag of DRY.filter((f) => flags.includes(f))) if (pluginAccess(`${cmd} ${flag}`)?.level === 'allow') return `${cmd} ${flag}`;
  return null;
}
