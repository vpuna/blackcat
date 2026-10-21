// `bc android adb <device> …`: any adb command on a paired device, judged like a command on a
// machine reached over SSH. Each device has a mode (read, ask, full: src/util/readonly.js);
// a command that only looks runs, anything else is asked about or refused by that mode.
//
// What adb does on this machine is not the device's to decide: copying files to or from
// here, or installing one from here, is the owner's (it could carry blackcat's own private
// files off); connecting and pairing are `pair` and `unpair`'s.
import { classify } from '../../src/api.js';

const always = () => true;
const only =
  (...words) =>
  (args) =>
    words.includes(args[0]);
// (A setting or an option given as a word on its own: `-a`, `--checkin`.)
const optionsOnly = (args) => args.every((a) => a.startsWith('-'));

// Programs of an Android device's shell that only look, beside those of any Linux (ls, cat, ps…).
export const PROGRAMS = {
  getprop: (args) => args.length <= 1,
  // `dumpsys <service>` and its options only report; a few services take words that change
  // something (`dumpsys battery set level 5`, `dumpsys deviceidle force-idle`).
  dumpsys: (args) =>
    args.length <= 1 ||
    optionsOnly(args.slice(1)) ||
    (['package', 'activity', 'window', 'meminfo', 'gfxinfo', 'procstats', 'usagestats', 'netstats'].includes(args[0]) &&
      args.slice(1).every((a) => /^[\w.:-]+$/.test(a) && !['set', 'reset', 'clear', 'enable', 'disable', 'kill'].includes(a))),
  pm: only('list', 'path', 'dump', 'has-feature', 'get-install-location', 'get-max-users', 'get-app-links'),
  cmd: (args) =>
    (args[0] === 'package' && ['list', 'resolve-activity', 'query-activities', 'query-services', 'has-feature'].includes(args[1])) ||
    (args[0] === 'lock_settings' && /^get-/.test(args[1] ?? '')),
  settings: (args) => ['get', 'list'].includes(args[0]),
  wm: (args) => ['size', 'density'].includes(args[0]) && args.length === 1,
  service: only('list', 'check'),
  // (`-d`: what is in the log now, and stop. Without it, it would follow the log for ever.)
  logcat: (args) => args.includes('-d') && !args.some((a) => /^-(c|G|P|f)/.test(a) || ['--clear', '--file'].includes(a)),
  // (What an app keeps for others to read: contacts, the call log. Personal: see SENSITIVE.)
  content: only('query'),
  getenforce: always,
  top: (args) => args.includes('-n'),
  df: always,
  uptime: always,
  id: always,
  whoami: always,
  date: (args) => args.every((a) => a.startsWith('+')),
  uname: always,
  free: always,
};

// Looks that show what is personal: messages in notifications, accounts, the clipboard,
// where the device is, what was logged, what apps keep (contacts, messages).
export const SENSITIVE = [
  /^dumpsys\s+(notification|account|accounts|clipboard|location|telecom|telephony\.registry|iphonesubinfo|wifi|bluetooth_manager)\b/,
  /^logcat\b/,
  /^content\b/,
];

export const judgeShell = (cmd) => classify(cmd, { programs: PROGRAMS, sensitive: SENSITIVE });

// adb's own words, beside `shell`.
const LOOKS = new Set(['get-state', 'get-serialno', 'get-devpath', 'features', 'version', 'help']);
const HERE = new Set([
  'push',
  'pull',
  'sync',
  'install',
  'install-multiple',
  'install-multi-package',
  'sideload',
  'backup',
  'restore',
  'bugreport',
]);
const PAIRING = new Set([
  'connect',
  'disconnect',
  'pair',
  'devices',
  'kill-server',
  'start-server',
  'reconnect',
  'keygen',
  'mdns',
  'attach',
  'detach',
  'wait-for-device',
  'host-features',
]);

// → { kind: 'read' | 'sensitive' | 'change', command } for the device's mode to decide, or
// { level, reason } where it is decided whatever the mode.
export function judge(args) {
  const [first, ...rest] = args;
  if (!first) return { level: 'never', reason: 'say what to run: an adb command, such as shell getprop ro.product.model' };
  if (first.startsWith('-'))
    return { level: 'never', reason: 'the device is chosen by its name; adb options before the command are not taken' };
  if (first === 'shell') {
    if (!rest.length) return { level: 'never', reason: 'an interactive shell needs a terminal: give the command, as in shell getprop' };
    if (rest[0].startsWith('-')) return { level: 'never', reason: "adb shell's own options are not taken: give the command alone" };
    const command = shellCommand(rest);
    return { kind: judgeShell(command), command };
  }
  if (first === 'logcat') {
    const kind = PROGRAMS.logcat(rest) ? 'sensitive' : 'change';
    if (kind === 'change' && !rest.includes('-d'))
      return { level: 'never', reason: 'logcat needs -d (what is in the log now), or it never ends' };
    return { kind };
  }
  if ((first === 'forward' || first === 'reverse') && rest.length === 1 && rest[0] === '--list') return { kind: 'read' };
  if (/^wait-for-/.test(first) || PAIRING.has(first))
    return { level: 'never', reason: 'connecting and pairing are done by bc android pair and unpair' };
  if (HERE.has(first))
    return { level: 'owner', reason: `adb ${first} copies files between this machine and the device: only the owner runs it` };
  return { kind: LOOKS.has(first) ? 'read' : 'change' };
}

// The words after `shell`, as one command line for the device's shell: one word given is the
// whole line (quoted by the caller); several are quoted as needed, as ssh's run does.
export function shellCommand(words) {
  if (words.length === 1) return words[0];
  return words.map((t) => (/^[A-Za-z0-9_/.:=,@%+-]+$/.test(t) ? t : `'${t.replace(/'/g, `'\\''`)}'`)).join(' ');
}
