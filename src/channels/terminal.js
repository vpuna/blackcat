// The terminal as a channel: `bc chat`. Part of the core, always there, and built on the
// same interface as a channel plugin, so everything the chat can do (a plugin's screens,
// approvals, the quick route) works here too. It can do the least a channel can: text.
// Choices appear as numbered lists, answered with a number.
//
// It differs from the others in two ways. It is one conversation and nothing else, so there
// is no pairing and no "which chat". And it sits beside the channel in use, not instead of
// it: what belongs to the owner (reminders, watches) is the same here as there.

import pc from 'picocolors';
import { plain } from './kit.js';

// Bold and italics as the terminal shows them (plain where it shows no colour); every other tag is taken out.
const styled = (html) =>
  plain(
    String(html)
      .replace(/<i>([\s\S]*?)<\/i>/g, (_, t) => pc.italic(t))
      .replace(/<b>([\s\S]*?)<\/b>/g, (_, t) => pc.bold(t)),
  ).replace(/\n{3,}/g, '\n\n');
// Signs that many terminal fonts cannot draw, as ones they can.
const shown = (text) => String(text).replaceAll('🐈‍⬛', '🐈').replaceAll('♾', '∞');

// `write(text)`: put text on the screen. `busy(on)`: show, or stop showing, that work is going on.
export function terminalCarrier({ write, busy = () => {} }) {
  let n = 0;
  return {
    label: 'the terminal',
    // (It takes the formatting and shows what a terminal can: bold and italics. The rest is taken out.)
    can: { oneChat: true, html: true, maxChars: 200_000 },
    send: async (_chat, m) => {
      busy(false);
      write(`\n${shown(m.html ? styled(m.text) : m.text)}\n`);
      return ++n;
    },
    sendFile: async (_chat, file, { caption } = {}) => {
      busy(false);
      write(`  file: ${file}${caption ? `  (${caption})` : ''}\n`);
    },
    working: async () => busy(true),
  };
}
