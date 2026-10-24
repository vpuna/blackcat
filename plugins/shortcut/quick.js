// A shortcut asked for in words ("turn tv on" for /tv_on, "play the waves" for /waves play),
// run without the agent. Only when the words are its name and nothing else: every word of
// the name said, in any order, and nothing more than a few that change nothing ("please",
// "run", "the"). Anything else ("tv on at nine", "is the tv on") is left to the agent.

// (`turn` and `switch` too: "turn tv on" is the name tv_on. `on` and `off` never are: they
// are what is asked.)
const FILLER = new Set(
  'hey hi ok okay please kindly can could would will you blackcat black cat run do start turn switch put the my a an our shortcut now for me thanks thank'.split(
    ' ',
  ),
);

export const words = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

// parts: [{ label: 'waves play', … }] → the one the words name, or null.
// The name with the most words wins ("waves play" over "waves" for "play the waves"); two
// that fit as well as each other are left to the agent.
export function named(text, parts) {
  const said = words(text);
  if (!said.length || said.length > 12) return null;
  const fits = parts
    .map((t) => ({ t, name: words(t.label) }))
    .filter(({ name }) => name.length && name.every((w) => said.includes(w)) && said.every((w) => name.includes(w) || FILLER.has(w)));
  if (!fits.length) return null;
  const most = Math.max(...fits.map((f) => f.name.length));
  const best = fits.filter((f) => f.name.length === most);
  return best.length === 1 ? best[0].t : null;
}
