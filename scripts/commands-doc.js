#!/usr/bin/env node
// Writes docs/commands.md: every command there is, with its options and the examples each
// part gives, taken from the command line itself so that it cannot drift from it.
//
//   npm run docs:commands        write the file
//
// It is built in an empty installation of its own with every bundled plugin switched on,
// so the result does not depend on what this installation has set up. A test holds the
// file in the repository to what this produces (test/commands-doc.test.js).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = new URL('..', import.meta.url).pathname;

// → the text of docs/commands.md. (Call with BLACKCAT_HOME already pointing at an empty folder.)
export async function commandsDoc() {
  const { save } = await import('../src/config.js');
  const bundled = fs.readdirSync(path.join(root, 'plugins')).filter((n) => fs.existsSync(path.join(root, 'plugins', n, 'plugin.js')));
  save({ plugins: { enabled: bundled } });
  // (The message commands are there once there is an archive: an empty one is made.)
  const { withDb } = await import('../src/db.js');
  withDb((await import('../src/archive/db.js')).openWrite, () => {});
  const { build } = await import('../src/main.js');
  const { everyKnown, mountOf } = await import('../src/plugins/registry.js');
  const program = await build();
  const helpOf = new Map(everyKnown().map((p) => [mountOf(p.manifest).join(' '), p.manifest]));

  const clean = (s) =>
    String(s ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  const cell = (s) => clean(s).replace(/\|/g, '\\|');
  const line = (cmd, words) => {
    const usage = clean(cmd.usage())
      .replace(/^\[options\]\s*/, '')
      .replace(/\s*\[options\]/, '')
      .replace(/\[command\]/, '');
    return `bc ${[...words, clean(usage)].filter(Boolean).join(' ')}`;
  };
  const optionsOf = (cmd) =>
    cmd.options
      .filter((o) => !o.hidden && o.long !== '--help' && o.long !== '--json') // (--json is every command's: said once, above)
      .map(
        (o) =>
          `  - \`${o.flags}\`: ${clean(o.description)}${o.defaultValue != null && o.defaultValue !== false && String(o.defaultValue) !== '' ? ` (default: ${[o.defaultValue].flat().join(', ')})` : ''}`,
      );
  const leaves = (cmd, words) =>
    cmd.commands.length
      ? cmd.commands.filter((c) => !c._hidden && c.name() !== 'help').flatMap((c) => leaves(c, [...words, c.name()]))
      : [{ cmd, words }];

  const out = [
    '# Commands',
    '',
    'Every `bc` command, with its options. This file is generated from the command line itself (`npm run docs:commands`), so it matches what `--help` prints. Do not edit it by hand.',
    '',
    'In a chat channel the same commands work with a slash: `bc backup now` is `/backup now`. What the agent may do with a command is in [brackets]: run it freely, ask you first, or not at all. Nearly every command also takes `--json`, for output a program can read.',
    '',
  ];
  const groups = program.commands.filter((c) => !c._hidden && c.name() !== 'help');
  out.push('## Contents', '', groups.map((g) => `[${g.name()}](#bc-${g.name()})`).join(' · '), '');
  for (const g of groups) {
    out.push(`## bc ${g.name()}`, '');
    const m = helpOf.get(g.name());
    // (A command with nothing under it says what it does on its own line below.)
    if (g.commands.length && clean(g.description()) && clean(g.description()) !== g.name()) out.push(`${clean(g.description())}`, '');
    // A group whose commands sit one level down (bc tg account …, bc tg bot …).
    for (const { cmd, words } of leaves(g, [g.name()])) {
      const sub = helpOf.get(words.slice(0, 2).join(' '));
      out.push(`- \`${line(cmd, words)}\`  `, `  ${cell(cmd.description()) || (sub ? cell(sub.description) : '')}`);
      out.push(...optionsOf(cmd));
    }
    out.push('');
    const helps = [m, ...g.commands.map((c) => helpOf.get(`${g.name()} ${c.name()}`))].filter((x) => x?.help);
    for (const h of helps) out.push('```', String(h.help).trim(), '```', '');
  }
  return `${out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackcat-doc-'));
  fs.mkdirSync(path.join(dir, 'data'), { mode: 0o700 });
  process.env.BLACKCAT_HOME = dir;
  try {
    fs.writeFileSync(path.join(root, 'docs/commands.md'), await commandsDoc());
    console.log('Wrote docs/commands.md');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.exit(0);
}
