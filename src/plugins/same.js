// Whether something to do is already kept somewhere: on a list, or as a reminder. By the words
// that carry the meaning, with no model, so that the answer is the same every time and costs
// nothing: "Register Leo for the chess club" and "Chess club places (optional)"
// share chess and club, which is enough to ask.
import { eachHook } from './hooks.js';

// Words that say nothing about which matter it is.
const SAYS_NOTHING = new Set(
  `a an the and or but nor for to of in on at by with from into onto about over under after before up down out off
  is are was were be been being am it its this that these those there here
  i me my mine we us our you your yours he him his she her they them their
  do does did done doing get got gets have has had will would can could should shall may might must
  need needs want wants please pls let lets make makes made go goes going went come comes
  today tomorrow tonight yesterday now soon later next last this week weeks day days month months year time times
  morning afternoon evening night am pm
  monday tuesday wednesday thursday friday saturday sunday mon tue tues wed thu thur thurs fri sat sun
  january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec
  new one two all any some more most other also just only very not no yes ok okay re fwd via per etc`.split(/\s+/),
);

// The words of a text that carry its meaning: lower case, with a plural or 's taken off.
export function meaningWords(text) {
  const out = new Set();
  for (let w of String(text ?? '')
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .split(/[^a-zÀ-ɏ]+/)) {
    if (w.length < 3 || SAYS_NOTHING.has(w)) continue;
    if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    out.add(w);
  }
  return out;
}

// Do two things to do look the same? At least two meaning words in common, and those at least
// half of the shorter one's. `common`: words found in many of the things kept (a child's name,
// "school"): they are shared by things that are not the same, so they are not enough on their
// own: two in common have to include one that is not common.
export function alike(a, b, common = new Set()) {
  const x = meaningWords(a);
  const y = meaningWords(b);
  const shared = [...x].filter((w) => y.has(w));
  return shared.length >= 2 && shared.length * 2 >= Math.min(x.size, y.size) && shared.filter((w) => !common.has(w)).length >= 2;
}

// The words found in many of `titles`: at least 6 of them, and at least one in 20. (Fewer, and
// it is the matter itself kept a few times over: just what is to be found.)
export function commonWords(titles) {
  const n = new Map();
  for (const t of titles) for (const w of meaningWords(t)) n.set(w, (n.get(w) ?? 0) + 1);
  const least = Math.max(6, Math.ceil(titles.length / 20));
  return new Set([...n].filter(([, k]) => k >= least).map(([w]) => w));
}

// What is kept already that looks like `text`: [{ kind: 'list' | 'reminder', id, title, where }].
// Each part that keeps things to do says what it keeps (the hook `keptToDo`); `not` leaves one out
// (the entry that is itself being looked at).
export async function keptAlike(text, { not } = {}) {
  const kept = (await eachHook('keptToDo')).flat();
  const common = commonWords(kept.map((k) => k.title));
  // (What is on a list first: that is where it would be dropped from.)
  return kept
    .filter((k) => !(not && k.kind === not.kind && k.id === not.id) && alike(text, k.title, common))
    .sort((a, b) => (a.kind === 'list' ? 0 : 1) - (b.kind === 'list' ? 0 : 1));
}

// One line for each, as the owner is told it.
export const keptLine = (k) => (k.kind === 'reminder' ? `reminder ${k.id}: ${k.title}` : `#${k.id} on ${k.where}: ${k.title}`);

// Said when something is not added because it looks like what is kept: what it looks like, and
// how to add it all the same.
export const notAddedText = (what, kept) =>
  `Not ${what}: it looks like what is kept already:\n${kept.map((k) => `  ${keptLine(k)}`).join('\n')}\nIf it is something else, add it anyway with --anyway.`;
