// What a command says, a line at a time, for a command that builds its text as it goes:
//
//   const say = saying();
//   say('First line');
//   if (nothing) return say('Nothing to show.').all();
//   return say.all();          → { text: 'First line\n…' }
//
// A command returns what it says; it does not print. (That is what lets the same command
// be typed, run by the agent with --json, or called by another part: src/plugins/cli.js
// prints what was returned.)
export function saying() {
  const out = [];
  const say = (line = '') => (out.push(String(line)), say);
  say.all = (more = {}) => ({ ...more, text: out.join('\n') });
  return say;
}
