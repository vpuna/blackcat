// docs/commands.md lists every command with its options. It is generated from the command
// line itself; this holds the copy in the repository to what the code now says.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { home } from './helpers.js';

home();
const { commandsDoc } = await import('../scripts/commands-doc.js');

test('docs/commands.md is what the command line says today (npm run docs:commands)', async () => {
  const now = await commandsDoc();
  const kept = fs.readFileSync(new URL('../docs/commands.md', import.meta.url), 'utf8');
  if (now !== kept) {
    const a = now.split('\n');
    const b = kept.split('\n');
    const at = a.findIndex((l, i) => l !== b[i]);
    assert.fail(
      `docs/commands.md is out of date. Run: npm run docs:commands\nFirst difference, line ${at + 1}:\n  now:  ${a[at]}\n  kept: ${b[at]}`,
    );
  }
  // every part and every bundled plugin is in it
  for (const word of ['remind', 'watch', 'check', 'backup', 'msg', 'memory', 'engine', 'ssh', 'ha', 'mail', 'shortcut', 'tg', 'wa'])
    assert.match(now, new RegExp(`^## bc ${word}$`, 'm'), word);
  assert.match(now, /`bc shortcut schedule <name> \[action\]`/);
});
