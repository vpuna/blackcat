// One plugin using another, the only way it may: by its commands. Never its code, its
// settings or its secrets. What a command gives back is what it would print with --json.
//
//   manifest:   uses: ['ssh']
//   in a hook:  const r = await ctx.command('ssh', 'list');        → { text, data }
//               await ctx.command('ssh', 'put', { host, local, remote });
//
// The called command decides who may run it, as always, and who started the chain carries
// through: what the agent set going is judged as the agent, so a plugin is never a way
// round a command that is the owner's alone, or one the agent must ask about first.
import { levelOf } from './access.js';
import { PluginError, findLoaded, makeCtx, mountOf } from './registry.js';

export async function callCommand(from, { caller, surface }, target, name, input = {}) {
  const uses = from.manifest?.uses ?? [];
  if (!uses.includes(target))
    throw new PluginError(`${from.name} does not say it uses "${target}": add uses: ['${target}'] to its manifest.`);
  const plugin = findLoaded(target);
  if (!plugin)
    throw new PluginError(`${from.manifest.title} needs the ${target} plugin, which is not switched on (bc plugin enable ${target}).`);
  const c = plugin.manifest.commands[name];
  const at = `${mountOf(plugin.manifest).join(' ')} ${name}`;
  if (!c) throw new PluginError(`${plugin.manifest.title} has no "${name}" command.`);
  if (c.interactive) throw new PluginError(`"${at}" asks questions as it goes, so only a person can run it.`);
  if (input == null || typeof input !== 'object' || Array.isArray(input))
    throw new PluginError(`"${at}": what it is given must be an object (for a command that takes the line as it is: { _: [words] }).`);
  // The words it would have been typed with, for a command that judges by them.
  const names = [...(c.usage ?? '').matchAll(/[<[]([a-zA-Z]+)(?:\.\.\.)?[>\]]/g)].map((x) => x[1]);
  const tokens = (c.raw ? (input._ ?? []) : names.flatMap((n) => input[n] ?? [])).map(String);
  if (c.raw && !Array.isArray(input._)) throw new PluginError(`"${at}" takes the line as it is: give it { _: [words] }.`);
  if (caller === 'agent') {
    const lvl = levelOf(plugin, name, tokens, 'agent');
    if (lvl.level !== 'allow')
      throw new PluginError(
        `Not available to the agent this way: ${lvl.reason ?? `"${at}" ${lvl.level === 'ask' ? 'needs the owner to approve it; ask for it to be run directly' : 'is for the owner only'}`}.`,
      );
  }
  // A form's answers are checked as they would be when typed.
  if (c.form) {
    const { unanswered } = await import('./forms.js');
    const open = unanswered(c.form, input, makeCtx(plugin, { caller, surface })).filter((s) => s.type !== 'secret');
    if (open.length) throw new PluginError(`"${at}" still needs: ${open.map((s) => s.id).join(', ')}.`);
  }
  const result = await c.run(makeCtx(plugin, { caller, surface }), c.raw ? { _: tokens } : input);
  if (result == null) return { text: '', data: null };
  if (typeof result === 'string') return { text: result, data: null };
  // (`raw` and `end` are for the command line: how it is printed, and that the process then ends.)
  const { text, data, raw: _raw, end: _end, ...rest } = result;
  return { text: text ?? '', data: data ?? (Object.keys(rest).length ? rest : null) };
}

// Who uses whom, checked once everything has loaded. → what is wrong, in words.
export function usesProblems(plugins) {
  const out = [];
  const by = new Map(plugins.map((p) => [p.name, p]));
  for (const p of plugins) {
    for (const u of p.manifest.uses ?? []) {
      if (u === p.name) out.push(`plugin "${p.name}": it cannot use itself`);
      else if (!by.has(u))
        out.push(`plugin "${p.name}" uses "${u}", which is not switched on: what needs it will say so when run (bc plugin enable ${u})`);
    }
  }
  // A uses B uses A: neither could be understood without the other.
  const seen = new Set();
  const walk = (name, path) => {
    if (path.includes(name)) {
      const loop = [...path.slice(path.indexOf(name)), name];
      const key = [...new Set(loop)].sort().join(',');
      if (!seen.has(key)) out.push(`plugins use each other in a circle: ${loop.join(' → ')}`);
      seen.add(key);
      return;
    }
    for (const u of by.get(name)?.manifest.uses ?? []) if (by.has(u) && u !== name) walk(u, [...path, name]);
  };
  for (const p of plugins) walk(p.name, []);
  return out;
}
