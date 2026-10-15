// Named accounts of a plugin: mail accounts, calendars, ssh machines. Each is kept in the
// plugin's settings under a key that never changes, because everything stored for it (its
// secret, its mail, its key file) is filed under that key. The name the owner knows it by is
// the key, until it is renamed: then the new name is kept beside it.
//
//   { personal: { address: '…' }, av: { name: 'work', address: '…' } }
//
// So renaming moves nothing: only the name changes.
import { eachHook } from './hooks.js';

export const accountName = (all, key) => all[key]?.name ?? key;
export const accountKey = (all, name) => Object.keys(all).find((k) => accountName(all, k) === name) ?? null;
export const accountNames = (all) => Object.keys(all).map((k) => accountName(all, k));

// A key for a new account called `name`: the name itself, unless an account renamed away from
// it still has it as its key.
export function freeAccountKey(all, name) {
  if (!all[name]) return name;
  let n = 2;
  while (all[`${name}-${n}`]) n++;
  return `${name}-${n}`;
}

// The questions for an account's name, for a command that adds one. A name already in use is
// asked about: replace that account, or give this one another name.
//   what:      'mail account', 'calendar', 'machine'
//   rule:      a regular expression the name must match, and `ruleText` saying it in words
//   describe:  (account) → a few words that say which one it is, e.g. its address
export function accountNameQuestions({ what, message, rule, ruleText, all, describe }) {
  const clean = (v) =>
    String(v ?? '')
      .trim()
      .toLowerCase();
  const taken = (a, ctx) => accountKey(all(ctx), clean(a.name));
  return [
    {
      id: 'name',
      type: 'text',
      message,
      validate: (v) => (rule.test(clean(v)) ? undefined : ruleText),
    },
    {
      id: 'taken',
      type: 'select',
      when: (a, ctx) => taken(a, ctx) != null,
      message: (a, ctx) => {
        const key = taken(a, ctx);
        const about = describe(all(ctx)[key]);
        return `There is already a ${what} called "${clean(a.name)}"${about ? ` (${about})` : ''}. Replace it, or give this one another name?`;
      },
      help: 'replace, or other: what to do when the name is already used',
      options: [
        { value: 'other', label: 'give this one another name' },
        { value: 'replace', label: `replace the ${what} called by that name` },
      ],
    },
    {
      id: 'otherName',
      type: 'text',
      when: (a, ctx) => taken(a, ctx) != null && a.taken === 'other',
      message: `Another name for this ${what}`,
      validate: (v, _a, ctx) =>
        !rule.test(clean(v)) ? ruleText : accountKey(all(ctx), clean(v)) != null ? `"${clean(v)}" is used too` : undefined,
    },
  ];
}

// What the questions came to. → { name, key, replacing }: `key` is where the account goes
// (the one it replaces, or a free one), `replacing` whether an account is being replaced.
// Answers given up front skip the questions, so they are checked again here.
export function chosenAccountName(all, a, fail) {
  const name = String(a.name ?? '')
    .trim()
    .toLowerCase();
  const key = accountKey(all, name);
  if (key == null) return { name, key: freeAccountKey(all, name), replacing: false };
  if (a.taken === 'replace') return { name, key, replacing: true };
  if (a.taken !== 'other') fail(`There is already one called "${name}". Say --taken replace, or --taken other with --other-name <name>.`);
  const other = String(a.otherName ?? '')
    .trim()
    .toLowerCase();
  if (!other) fail('Give it another name: --other-name <name>.');
  if (accountKey(all, other) != null) fail(`"${other}" is used too.`);
  return { name: other, key: freeAccountKey(all, other), replacing: false };
}

// The account settings with the one called `from` renamed to `to`. → { all, key }
export function renameAccount(all, from, to, { rule, ruleText, what, fail }) {
  const key = accountKey(all, from);
  const target = String(to ?? '')
    .trim()
    .toLowerCase();
  if (key == null) fail(`There is no ${what} called "${from}".`);
  if (!rule.test(target)) fail(`${ruleText}.`);
  if (target === from) fail(`It is already called "${from}".`);
  if (accountKey(all, target) != null) fail(`There is already a ${what} called "${target}".`);
  const { name: _old, ...rest } = all[key];
  // Back to its key: the name beside it is no longer needed.
  return { key, all: { ...all, [key]: target === key ? rest : { ...rest, name: target } } };
}

// A chat in the archive was given a new name (a mail account's, say): each part that shows
// chats by name (the watches) takes the new one (`chatRenamed`). → how many things changed
export async function chatRenamed(ref, name) {
  return (await eachHook('chatRenamed', { ref, name })).reduce((n, x) => n + (Number(x) || 0), 0);
}

// What the owner has set up that still says an old name after a rename: shortcuts, checks and
// standing permissions hold commands as text, and are not changed behind the owner's back.
// Each part says what of its own matches (`mentions`).
// → ['shortcut /porch', 'check 2 "The NAS is up"', 'permission: allow ssh run old df -h']
export async function mentioning(pattern) {
  const { listRules } = await import('../agent/permissions.js');
  return [
    ...(await eachHook('mentions', pattern)).flat(),
    ...listRules()
      .filter((r) => pattern.test(r.command))
      .map((r) => `permission: ${r.effect} ${r.command}`),
  ];
}
