// A command at a terminal, or one blackcat runs for itself on a schedule, is a piece of
// work: everything it records carries one id, and when it ends one entry says what was
// run, by whom, how long it took and how it ended.
//
// What is kept of it: its name, its options, how long it took and how it ended. Its words
// are kept only for a command the agent could not run unasked (a setup, a mode, a
// machine added: what says who may do what). For the rest they are left out: they are
// what was looked for, what a reminder says, what a notice said. Never what it printed.
import { came, leadsBy, newWork, processWho, record } from './log.js';

// Sessions that go on for as long as someone is there: what happens in them is recorded
// piece by piece (each turn of a chat), not as one piece of work.
const SESSIONS = new Set(['chat', 'logs', 'service run']);
// Parts of blackcat itself that only look. (A plugin's command says so itself: `changes`.)
const LOOKS = new Set(['status', 'selftest', 'plugin list', 'plugin info', 'channel', 'permissions']);

let noted = null;
leadsBy((category) => leads(category));
// Parts of blackcat itself whose words are what was said, not what was set.
const SAID = new Set(['notify']);
// What the command that is running says of itself, once it is known: { changes, keep, surface, words }.
export function about(more) {
  if (noted) Object.assign(noted, more);
}
// What came of it: { idle: true } (nothing to do: counted, not listed), { did: 'a few words' }.
export function cameTo(said) {
  if (noted) noted.said = came(said);
}
// A more telling entry for the same command was made (`bc restart`: what was restarted): that one stands for it.
export const leads = (category) => {
  if (!noted || noted.category !== category || noted.taken) return false;
  noted.taken = true;
  return !noted.part;
};

const words = (argv, names) => {
  const rest = [...argv];
  for (const n of names) {
    const i = rest.indexOf(n);
    if (i >= 0) rest.splice(i, 1);
  }
  return rest.filter((t) => !/^--?json$/.test(t));
};

// `cmd` is the command about to run (commander's), `argv` what was typed after `bc`.
export function begin(cmd, argv = []) {
  const names = [];
  let hidden = false;
  for (let c = cmd; c?.parent; c = c.parent) {
    names.unshift(c.name());
    if (c._hidden) hidden = true;
  }
  beginNamed(names, argv, hidden);
}
// (The same for a command that takes what was typed as it is, and is not commander's.)
export function beginNamed(names, argv = [], hidden = false) {
  const who = processWho();
  // A service runs for days and does many things; what the agent runs is part of its turn,
  // and is recorded by the conversation that ran it.
  if (hidden || process.env.BLACKCAT_SERVICE || who === 'agent' || SESSIONS.has(names[0]) || SESSIONS.has(names.join(' '))) {
    // (A service started by a command is not part of that command's work for as long as it runs.)
    if (who !== 'agent' && names.join(' ') !== 'plugin job') delete process.env.BLACKCAT_WORK;
    return;
  }
  const part = !!process.env.BLACKCAT_WORK;
  process.env.BLACKCAT_WORK ||= newWork();
  const t0 = Date.now();
  noted = {
    category: `bc ${names.join(' ')}`,
    part,
    changes: !LOOKS.has(names.join(' ')),
    keep: !LOOKS.has(names.join(' ')) && !SAID.has(names[0]),
    surface: process.env.BLACKCAT_JOB ? 'job' : 'terminal',
    words: words(argv, names),
  };
  // (Noted as the command ends, however it ends, so that it says how long it took and whether it worked.)
  process.once('exit', (code) => {
    if (noted.taken) return;
    const said = noted.said ?? {};
    // (Reading the record is counted, and does not fill the record with itself.)
    const reading = noted.category.startsWith('bc activity ') && !noted.changes;
    const text = noted.keep ? noted.words.join(' ') : noted.words.filter((w) => /^--?[a-z][\w-]*$/.test(w)).join(' ');
    record({
      kind: process.env.BLACKCAT_JOB ? 'job' : 'owner',
      category: noted.category,
      surface: noted.surface,
      ok: !code && said.ok !== false,
      ms: Date.now() - t0,
      lead: !part,
      summary: said.did ?? (text ? text.slice(0, 160) : null),
      data: { ...(noted.changes ? {} : { looks: true }), ...(code ? { exit: code } : {}), ...said.data },
      countOnly: said.idle === true || reading,
    });
  });
}
