// Simple spoken or typed commands for the home ("turn on kitchen lights", "kitchen lights
// off", "close the bedroom blinds"), understood without the agent: a fixed set of sentence
// shapes, matched against the synced catalogue. Anything that isn't exactly one of these
// shapes, or doesn't name exactly one thing (or one obvious group), is left to the agent.
import { ACTIONS, areaName, levelFor, main } from './catalogue.js';
import { sleep } from '../../src/api.js';

const FILLER_START = /^(hey|hi|ok|okay|please|kindly|can you|could you|would you|will you|blackcat|black cat)\s+/;
const FILLER_END = /\s+(please|now|for me|thanks|thank you)$/;
const SKIP = new Set(['the', 'my', 'a', 'an', 'our', 'in', 'of']);
// Words that mean the request is more than "do this now": timing, conditions, several things.
const NOT_SIMPLE =
  /\b(and|then|if|when|unless|until|after|before|at|tomorrow|tonight|later|minutes?|hours?|seconds?|every|except|but|why|what|is|are|was|did|does|how)\b/;

// "lights" and "light" are the same word here.
const stem = (w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const words = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

// What a script's name says it does: a home often has "…_fan_on", "…_blinds_down", "…_light_onoff".
const OPTIONAL = new Set(['window', 'main', 'switch']);
const SCRIPT_WORDS = {
  on: ['on', 'onoff'],
  off: ['off', 'onoff'],
  toggle: ['onoff', 'toggle'],
  open: ['up', 'open'],
  close: ['down', 'close'],
  stop: ['stop'],
};

// The sentence shapes. → { action, name: [words], plural } or null.
export function parse(text) {
  let t = String(text)
    .toLowerCase()
    .replace(/[.,!?;:"“”'’]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (let i = 0; i < 3; i++) t = t.replace(FILLER_START, '').replace(FILLER_END, '');
  if (!t || t.length > 80 || NOT_SIMPLE.test(t)) return null;
  const shapes = [
    [/^(?:turn|switch|put|power) (on|off) (.+)$/, (m) => [m[1], m[2]]], // turn on kitchen lights
    [/^(?:turn|switch|put|power) (.+) (on|off)$/, (m) => [m[2], m[1]]], // turn kitchen lights on
    [/^(.+) (on|off)$/, (m) => [m[2], m[1]]], // kitchen lights on
    [/^(on|off) (.+)$/, (m) => [m[1], m[2]]], // off kitchen lights
    [/^toggle (.+)$/, (m) => ['toggle', m[1]]],
    [/^(open|raise|close|shut|lower|stop) (.+)$/, (m) => [{ raise: 'open', shut: 'close', lower: 'close' }[m[1]] ?? m[1], m[2]]], // close the blinds
    [/^(.+) (up|open|down|closed?|shut|stop)$/, (m) => [{ up: 'open', down: 'close', closed: 'close', shut: 'close' }[m[2]] ?? m[2], m[1]]], // blinds down
  ];
  for (const [re, pick] of shapes) {
    const m = re.exec(t);
    if (!m) continue;
    const [action, rest] = pick(m);
    const raw = words(rest).filter((w) => !SKIP.has(w));
    if (!raw.length || raw.length > 6) return null;
    return { action, name: raw.map(stem), plural: raw.some((w) => stem(w) !== w) };
  }
  return null;
}

// How many single-letter slips apart two words are: a letter missing, extra, wrong, or two swapped.
function slips(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

// A typing slip ("kitchn", "ligth") is corrected to the word that was meant, but only when
// there is exactly one word in this home's names it could be. Short words are left alone
// ("fan" is not "tan"), and a different word that merely sounds similar is never swapped in.
function correct(word, vocab) {
  if (vocab.has(word) || word.length < 4) return word;
  const allowed = word.length >= 8 ? 2 : 1;
  const near = [...vocab].filter((v) => v.length >= 4 && Math.abs(v.length - word.length) <= allowed && slips(word, v) <= allowed);
  return near.length === 1 ? near[0] : word;
}

// What exactly would be done? → { action, things: [entity], via } or null (leave it to the agent).
export function plan(text, cat, cfg = {}) {
  const p = parse(text);
  if (!p) return null;
  const pool = cat.entities.filter((e) => main(e) && e.available !== false);
  const vocab = new Set(pool.flatMap((e) => words(`${areaName(cat, e.area) ?? ''} ${e.name}`).map(stem)));
  const said = p.name.join(' ');
  p.name = p.name.map((w) => correct(w, vocab));
  const corrected = p.name.join(' ') !== said;
  const has = (terms) => p.name.every((w) => terms.includes(w));

  // Things with a state of their own: lights, switches, fans, blinds, media players.
  let hits = pool.filter(
    (e) => e.domain !== 'script' && ACTIONS[e.domain]?.[p.action] && has(words(`${areaName(cat, e.area) ?? ''} ${e.name}`).map(stem)),
  );
  // Prefer one whose name is exactly what was said ("hallway light") over longer ones.
  const exact = hits.filter(
    (e) =>
      words(e.name)
        .map(stem)
        .filter((w) => w !== 'switch')
        .join(' ') === p.name.join(' '),
  );
  if (exact.length) hits = exact;
  let via = 'entity';

  // Otherwise a script named for it: "<what was said>_<on|off|up|down|stop>".
  if (!hits.length && SCRIPT_WORDS[p.action]) {
    hits = pool.filter((e) => {
      if (e.domain !== 'script') return false;
      const terms = words(e.name)
        .filter((w) => !/^\d+$/.test(w))
        .map(stem);
      const does = terms.filter((w) => SCRIPT_WORDS[p.action].includes(w));
      const rest = terms.filter((w) => !Object.values(SCRIPT_WORDS).flat().includes(w));
      // Every word said must be in the script's name, and the name may add nothing but filler ("window" blinds).
      return does.length && has(rest) && rest.every((w) => p.name.includes(w) || OPTIONAL.has(w));
    });
    via = 'script';
  }
  if (!hits.length) return null;
  // Two things with the same name can't be told apart here.
  if (
    hits.length > 1 &&
    (new Set(hits.map((e) => e.name.toLowerCase())).size !== hits.length || !p.plural || via === 'script' || hits.length > 6)
  )
    return null;
  // Done at once only for a single thing the agent could also switch freely. Several things
  // at once ("lights off"), or a kind that normally asks, get one confirming tap.
  return { action: p.action, things: hits, via, corrected, free: hits.length === 1 && hits.every((e) => levelFor(e, cfg) === 'free') };
}

// Carry a plan out. → the line to show the owner.
export async function carryOut(pl, cat, api) {
  const done = [];
  for (const e of pl.things) {
    const [domain, service] = pl.via === 'script' ? ['script', 'turn_on'] : ACTIONS[e.domain][pl.action];
    await api.call(domain, service, { entity_id: e.id });
  }
  await sleep(700); // let it take effect, then say what it is now
  for (const e of pl.things) {
    if (pl.via === 'script') {
      done.push(`ran ${e.name}${/onoff/i.test(e.name) ? " (it toggles, so I can't tell which way it went)" : ''}`);
      continue;
    }
    const s = await api.state(e.id).catch(() => null);
    done.push(`${e.name}: ${s?.state ?? pl.action}`);
  }
  return done.join('\n');
}
