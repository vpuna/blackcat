// What the agent is told, whichever engine runs the model: two pieces of text, handed to
// the engine as text.
//   rules      agent/AGENT.md: who it is, how it behaves, what it must never do. Written by
//              hand, and the same on every installation.
//   generated  what is true of this installation right now: the chat's commands, the
//              folders it may read, and each enabled plugin's commands and notes
//              (src/channels/commands.js).
//   memory     what it remembers from earlier conversations (src/memory/store.js). It changes
//              whenever something is saved, so it is no part of the fingerprint below: a
//              conversation is not begun afresh because something was remembered in it.
// Nothing here is read by an engine from a file of its own accord: an engine is given both.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from '../config.js';
import { runtimePrompt } from '../channels/commands.js';
import { remembered } from '../memory/store.js';

// The agent's own folder: its rules are here, and an engine is started in it.
export const AGENT_DIR = path.join(HOME, 'agent');
export const AGENT_FILE = 'AGENT.md';

// The rules, from an agent folder (this installation's, unless another is named).
export function rules(dir = AGENT_DIR) {
  try {
    return fs.readFileSync(path.join(dir, AGENT_FILE), 'utf8').trim();
  } catch {
    return '';
  }
}

// All of it, for a conversation on a surface (the chat, or the terminal).
export const instructions = ({ surface = 'chat', dir = AGENT_DIR } = {}) => ({
  rules: rules(dir),
  generated: runtimePrompt({ surface }),
  memory: memory(),
});

// What it remembers, or nothing if that cannot be read just now.
function memory() {
  try {
    return remembered();
  } catch {
    return '';
  }
}

// As one text, rules first: for an engine that takes its instructions whole.
export const whole = (i) => [i?.rules, i?.generated, i?.memory].filter(Boolean).join('\n\n');

// A fingerprint of everything the agent is told. A conversation that began under other
// instructions is not carried on as it was.
export const stamp = (surface) => {
  const i = { rules: rules(), generated: runtimePrompt({ surface }) };
  return crypto.createHash('sha256').update(i.generated).update(i.rules).digest('hex').slice(0, 16);
};
