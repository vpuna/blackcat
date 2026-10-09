// Decide whether a remote command only looks at things. Deliberately strict: a command
// is read-only only if every part of it is on the list below. Anything not recognised
// is treated as a change, which means "ask the owner" or "refuse", never "run".
//
// This is a filter on the command text, so it is a convenience, not a guarantee. For a
// guarantee, restrict the key on the remote machine as well (see the plugin's help).

const noFollow = (args) => !hasOpt(args, 'fF', ['--follow', '--retry']);
const always = () => true;
// Every argument must be one of these (used where a stray option can change something).
const only = (re) => (args) => args.every((a) => re.test(a));
// A short option cluster ("-ro") that contains one of these letters, or one of the long
// options. GNU programs accept a long option cut short ("--out" for "--output"), so a long
// option counts when what was written is the start of it.
function hasOpt(args, letters, long = []) {
  return args.some((a) => {
    if (a.startsWith('--')) {
      const name = a.split('=')[0];
      return name.length > 2 && long.some((l) => l.startsWith(name));
    }
    return letters && /^-[a-zA-Z]/.test(a) && new RegExp(`[${letters}]`).test(a.slice(1));
  });
}
// Programs that repeat forever when given an interval and no count ("vmstat 1"): either
// no numbers, or both.
const bounded = (args) => [0, 2].includes(args.filter((a) => /^\d+(\.\d+)?$/.test(a)).length);

// docker <verb> … or docker <object> <verb> …, with the verb where it is expected: an
// option in front of it ("docker --config ps rm x") could carry a value that looks like a
// verb, so none is accepted there.
const DOCKER_VERBS = ['ps', 'images', 'version', 'info', 'top', 'port', 'diff', 'history', 'inspect'];
const DOCKER_OBJECTS = {
  container: ['ls', 'list', 'ps', 'logs', 'top', 'port', 'stats', 'diff', 'inspect'],
  image: ['ls', 'list', 'history', 'inspect'],
  network: ['ls', 'list', 'inspect'],
  volume: ['ls', 'list', 'inspect'],
  system: ['df', 'info'],
  compose: ['ps', 'logs', 'ls', 'top', 'images', 'version'],
};
function docker(args) {
  const [a, b] = args;
  // `inspect` only reads, but shows environment variables, which often hold passwords:
  // it passes here and is then marked sensitive below.
  if (DOCKER_VERBS.includes(a)) return true;
  if (a === 'logs') return noFollow(args);
  if (a === 'stats') return args.includes('--no-stream'); // otherwise it never ends
  if (DOCKER_OBJECTS[a]?.includes(b)) {
    if (b === 'logs') return noFollow(args);
    if (b === 'stats') return args.includes('--no-stream');
    return true;
  }
  return false;
}

// systemctl [plain options] <verb> …: the verb is the first word that is not an option, and
// only options that take no separate value may come before it ("-p status poweroff" would
// otherwise read "status" as the verb).
const SYSTEMCTL_VERBS = ['status', 'is-active', 'is-enabled', 'is-failed', 'list-units', 'list-unit-files', 'list-timers', 'show', 'cat'];
const SYSTEMCTL_BEFORE =
  /^(--no-pager|--user|--system|-l|--full|-a|--all|--failed|--plain|--no-legend|-q|--quiet|--type=[\w,.-]+|--state=[\w,.-]+)$/;
function systemctl(args) {
  const i = args.findIndex((a) => !a.startsWith('-'));
  return (
    i >= 0 &&
    SYSTEMCTL_VERBS.includes(args[i]) &&
    args.slice(0, i).every((a) => SYSTEMCTL_BEFORE.test(a)) &&
    !hasOpt(args.slice(i + 1), 'HM', ['--host', '--machine', '--root', '--image'])
  );
}

// ip [display options] <object> [show|list …]. Abbreviated commands are not accepted:
// "ip link s eth0 down" is "set".
const IP_OPTIONS = /^-(4|6|br|brief|c|color|j|json|p|pretty|s|stats|statistics|d|details|o|oneline|h|human|r|resolve)$/;
const IP_OBJECTS = [
  'addr',
  'address',
  'a',
  'link',
  'l',
  'route',
  'r',
  'neigh',
  'neighbor',
  'neighbour',
  'n',
  'rule',
  'maddr',
  'maddress',
  'tunnel',
  'tuntap',
  'vrf',
  'netconf',
];
function ip(args) {
  const words = args.filter((a) => !a.startsWith('-'));
  if (!args.filter((a) => a.startsWith('-')).every((a) => IP_OPTIONS.test(a))) return false;
  if (!words.length) return false;
  if (!IP_OBJECTS.includes(words[0])) return false;
  return words.length === 1 || ['show', 'list', 'ls', 'get'].includes(words[1]);
}

// smartctl: the options that report, and for -l only the logs that are read (a value such
// as "scterc,70,70" changes a setting).
function smartctl(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-')) continue;
    if (/^(-a|-A|-H|-i|-x|-c|--all|--attributes|--health|--info|--xall|--capabilities|--scan|--scan-open)$/.test(a)) continue;
    if (/^(-d|--device)$/.test(a)) {
      i++;
      continue;
    }
    if (/^--device=[\w,+-]+$/.test(a)) continue;
    if (/^(-l|--log)$/.test(a) && /^[a-z]+$/.test(args[i + 1] ?? '')) {
      i++;
      continue;
    }
    if (/^--log=[a-z]+$/.test(a)) continue;
    return false;
  }
  return true;
}

const PROGRAMS = {
  // looking at files and folders
  ls: always,
  cat: always,
  head: always,
  wc: always,
  stat: always,
  // -C compiles a magic file (writing one); -m reads rules from a file of the caller's choosing.
  file: (args) => !hasOpt(args, 'Cm', ['--compile', '--magic-file']),
  du: always,
  df: always,
  realpath: always,
  readlink: always,
  tail: noFollow,
  grep: always,
  egrep: always,
  fgrep: always,
  zgrep: always,
  zcat: always,
  find: (args) => !args.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint.*|fls)$/.test(a)),
  // shaping output (only useful after a pipe)
  sort: (args) => !hasOpt(args, 'oT', ['--output', '--compress-program', '--temporary-directory', '--files0-from']),
  // `uniq IN OUT` writes OUT, so at most one file may be named.
  uniq: (args) => args.filter((a) => !a.startsWith('-') || a === '-').length <= 1,
  cut: always,
  tr: always,
  column: always,
  nl: always,
  tac: always,
  rev: always,
  // the machine
  uptime: always,
  uname: always,
  whoami: always,
  id: always,
  hostname: only(/^(-[fsiIdaAy]|--fqdn|--short|--ip-address|--all-ip-addresses|--domain|--alias|--all-fqdns)$/),
  // Only ways of showing the time: a bare number or -s sets the clock.
  date: only(/^(\+.*|-u|--utc|--universal|-R|--rfc-email|-I[a-z]*|--iso-8601(=[a-z]+)?|--rfc-3339=[a-z]+)$/),
  free: (args) => !hasOpt(args, 's', ['--seconds']),
  vmstat: bounded,
  iostat: bounded,
  mpstat: bounded,
  nproc: always,
  lscpu: always,
  lsblk: always,
  lsusb: always,
  lspci: always,
  lsmod: always,
  // Options that show; -s (--set) applies the limits in the configuration to the hardware.
  sensors: only(/^(-A|-f|-u|-j|--no-adapter|--fahrenheit|[A-Za-z0-9*][\w*-]*)$/),
  dmesg: only(/^(-[THkxteL]+|--ctime|--human|--kernel|--nopager|--level=[\w,]+|--facility=[\w,]+|--color=\w+)$/),
  w: always,
  who: always,
  last: always,
  ps: always,
  pgrep: always,
  top: (args) => hasOpt(args, 'b') && hasOpt(args, 'n'), // batch mode, a set number of times
  mount: (args) => !args.length,
  findmnt: always,
  lsof: always,
  // network (looking only). Nothing here sends a name or data anywhere: dig, nslookup and
  // host are left out because a lookup of "<anything>.example.com" is a way to send data out.
  ip,
  ss: (args) => !hasOpt(args, 'KDFE', ['--kill', '--diag', '--filter', '--events']),
  netstat: always,
  ifconfig: (args) => args.length <= 1,
  // services and logs
  systemctl,
  journalctl: (args) =>
    noFollow(args) &&
    !hasOpt(args, '', [
      '--vacuum-size',
      '--vacuum-time',
      '--vacuum-files',
      '--rotate',
      '--flush',
      '--sync',
      '--setup-keys',
      '--update-catalog',
      '--relinquish-var',
      '--smart-relinquish-var',
    ]),
  // storage
  smartctl,
  zpool: (args) => ['status', 'list', 'iostat', 'history'].includes(args[0]) && bounded(args),
  zfs: (args) => ['list', 'get'].includes(args[0]),
  btrfs: (args) =>
    ['filesystem', 'device', 'subvolume', 'scrub'].includes(args[0]) &&
    ['show', 'df', 'usage', 'list', 'stats', 'status'].includes(args[1]),
  mdcmd: (args) => args[0] === 'status' && args.length === 1,
  // containers
  docker,
  echo: always,
  true: always,
  test: always,
  which: always,
  type: always,
};
// Programs whose output is the contents of the files they are given. With a wildcard in a
// file name, what they would print can't be told from the text, so that is not a free look.
const SHOWS_CONTENTS = [
  'cat',
  'head',
  'tail',
  'tac',
  'nl',
  'rev',
  'grep',
  'egrep',
  'fgrep',
  'zgrep',
  'zcat',
  'sort',
  'uniq',
  'cut',
  'tr',
  'column',
  'file',
];
// Only the system's own copies of these programs: "/tmp/docker" is not docker.
const SYSTEM_DIRS = /^(\/usr)?(\/local)?\/s?bin\/$/;

// Things that can hold passwords or keys. Reading them is not a harmless look.
const SENSITIVE = [
  /shadow\b/,
  /\.ssh\b/,
  /\bid_(rsa|ed25519|ecdsa|dsa)\b/,
  /\.(pem|key|p12|pfx|kdbx)\b/i,
  /\bsecrets?\b/i,
  /\.env\b/,
  /password/i,
  /\/boot\/config\b/,
  /wireguard|wg\d*\.conf/i,
  /\.netrc\b/,
  /credentials/i,
  /token/i,
  /\/proc\/\d+\/environ/,
];
const SENSITIVE_COMMANDS = [/^(\S*\/)?docker\s+(\w+\s+)?inspect\b/];

// Split on unquoted | (a single one, not ||). Returns null if the command uses anything
// that chains, redirects, substitutes, escapes or backgrounds.
//
// The shell and this function must agree on where a quoted string ends, or the rest of the
// line is read differently by the two. A backslash is what could make them disagree, so:
//   outside quotes          refused (it escapes whatever follows)
//   inside '…'              plain text to the shell, so accepted ('a\.b' in a grep pattern)
//   inside "…"              accepted only before a letter or digit, where the shell leaves it
//                           as it is ("{{.Names}}\t{{.Status}}"); before a quote, another
//                           backslash, $ or ` it would change what the shell sees
function pipeline(cmd) {
  if (/[\n\r\0]/.test(cmd)) return null;
  const parts = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (quote === '"' && (ch === '$' || ch === '`' || ch === '!')) return null;
      else if (quote === '"' && ch === '\\' && !/[A-Za-z0-9]/.test(cmd[i + 1] ?? '')) return null;
      cur += ch;
    } else if (ch === '\\') return null;
    else if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
    } else if (ch === '|') {
      if (cmd[i + 1] === '|' || cmd[i + 1] === '&') return null;
      parts.push(cur);
      cur = '';
    } else if (ch === '{') {
      // A Go template such as {{.Names}} (docker --format) is plain text to the shell.
      // Anything else in braces could be brace expansion, so it is not accepted.
      const m = /^\{\{[\w .:-]*\}\}/.exec(cmd.slice(i));
      if (!m || m[0].includes('..')) return null;
      cur += m[0];
      i += m[0].length - 1;
    } else if (';&<>`$()}!'.includes(ch)) return null;
    else cur += ch;
  }
  if (quote) return null;
  parts.push(cur);
  return parts.map((p) => p.trim());
}

// The words of one command, as the shell would pass them, with whether each has a wildcard
// outside quotes (which the shell would expand into file names).
function words(segment) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  let glob = false;
  const push = () => {
    if (has || cur) out.push({ text: cur, glob });
    cur = '';
    has = false;
    glob = false;
  };
  for (const ch of segment) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === "'" || ch === '"') ((quote = ch), (has = true));
    else if (/\s/.test(ch)) push();
    else {
      if ('*?['.includes(ch)) glob = true;
      cur += ch;
    }
  }
  push();
  return out;
}

// → 'read' (safe to run without asking), 'sensitive' (reads, but may expose secrets),
//   or 'change' (anything else).
export function classify(command) {
  const cmd = String(command ?? '').trim();
  if (!cmd) return 'change';
  const segments = pipeline(cmd);
  if (!segments || segments.some((s) => !s)) return 'change';
  let sensitive = false;
  for (const seg of segments) {
    const [first, ...rest] = words(seg);
    if (!first || first.glob) return 'change';
    const slash = first.text.lastIndexOf('/');
    if (slash >= 0 && !SYSTEM_DIRS.test(first.text.slice(0, slash + 1))) return 'change';
    const prog = first.text.slice(slash + 1);
    const args = rest.map((w) => w.text);
    // (hasOwn: "constructor" and the like are not programs.)
    if (!Object.hasOwn(PROGRAMS, prog) || !PROGRAMS[prog](args)) return 'change';
    // The secrets test is made on the words as the shell would see them, so quotes in the
    // middle of a name ("/root/.s''sh") hide nothing.
    const plain = [prog, ...args].join(' ');
    if (SENSITIVE.some((re) => re.test(plain)) || SENSITIVE_COMMANDS.some((re) => re.test(plain))) sensitive = true;
    if (SHOWS_CONTENTS.includes(prog) && rest.some((w) => w.glob)) sensitive = true;
    // A search through whole folders prints from every file in them, whatever they are
    // (keys and password files included) without naming one of them.
    if (/grep$/.test(prog) && hasOpt(args, 'rRd', ['--recursive', '--dereference-recursive', '--directories'])) sensitive = true;
  }
  return sensitive || SENSITIVE.some((re) => re.test(cmd)) ? 'sensitive' : 'read';
}
