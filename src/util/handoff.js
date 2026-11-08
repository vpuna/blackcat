// What a command run as a step of a shortcut hands to the shortcut besides what it prints: a
// picture to send after the shortcut's last step, or that the owner has been told its result
// already. The shortcut names a file for the step in BLACKCAT_HANDOFF; a step of any kind can
// write to it, one JSON object a line ({ "picture": "<path>" }, { "told": true }). Outside a
// shortcut there is none, and nothing is kept.
import fs from 'node:fs';

// → whether there was a shortcut to hand it to
export function handOff(what) {
  const file = process.env.BLACKCAT_HANDOFF;
  if (!file) return false;
  fs.appendFileSync(file, `${JSON.stringify(what)}\n`);
  return true;
}

// What a step handed on, and the file gone. → { pictures: [path], told }
export function handedOff(file) {
  let lines = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {}
  fs.rmSync(file, { force: true });
  const out = { pictures: [], told: false };
  for (const l of lines) {
    let o;
    try {
      o = JSON.parse(l);
    } catch {
      continue; // (a line that is not one is no instruction)
    }
    if (typeof o?.picture === 'string') out.pictures.push(o.picture);
    if (o?.told === true) out.told = true;
  }
  return out;
}
