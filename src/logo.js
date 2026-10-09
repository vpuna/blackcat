import pc from 'picocolors';

// The black cat, drawn for a terminal. (The 🐈‍⬛ emoji is a joined sequence that many
// terminals show as an orange cat next to a black square, so it is only used in Telegram.)
//
// One character per cell: K black, Y an eye, N the nose, . the badge behind it. Every
// cell is a plain coloured space. Block characters would allow finer detail, but in many
// fonts they don't quite fill their cell, which leaves thin lines of the wrong colour.
const CELLS = ['.............', '..KK.....KK..', '..KKKKKKKKK..', '..KKYKKKYKK..', '...KKKNKKK...', '.............'];
// 256-colour codes, so black is really black whatever the terminal's theme.
const COLOUR = { K: 16, Y: 220, N: 211, '.': 133 };

const art = () => CELLS.map((row) => `${[...row].map((c) => `\x1b[48;5;${COLOUR[c]}m `).join('')}\x1b[0m`);

// The logo with a line or two of text beside it. Falls back to plain text when the
// output isn't a colour terminal (a pipe, NO_COLOR).
export function logo(subtitle = '') {
  if (!pc.isColorSupported) return `=^..^= blackcat${subtitle ? `  ${subtitle}` : ''}`;
  const side = ['', '', pc.bold('blackcat'), pc.dim(subtitle)];
  return art()
    .map((l, i) => `  ${l}  ${side[i] ?? ''}`.trimEnd())
    .join('\n');
}
