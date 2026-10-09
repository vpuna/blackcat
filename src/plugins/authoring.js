// Making a plugin of your own, and installing one somebody else made.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { update } from '../config.js';
import { PLUGIN_DATA, USER_DIR, available, isEnabled, loadOne, mountOf } from './registry.js';

const NAME = /^[a-z][a-z0-9-]{1,20}$/;
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};
const git = (args, cwd) =>
  new Promise((resolve) =>
    execFile('git', args, { cwd, timeout: 120_000 }, (err, out, errOut) => resolve({ ok: !err, out: `${out}${errOut}`.trim() })),
  );

const TEMPLATE = (name) => `// ${name}: a blackcat plugin. docs/plugins.md explains every part of this file.
//
// Everything blackcat offers a plugin is on \`ctx\`: its settings (ctx.config), secrets
// (ctx.secrets), a private folder (ctx.dataDir), running a program (ctx.exec), telling the
// owner something (ctx.notify), and the rest of the API as ctx.api (time and size helpers,
// the message archive, reminders, asking a model with no tools…).

export default {
  api: 1,
  name: '${name}',
  title: '${name[0].toUpperCase()}${name.slice(1)}',
  description: 'what this plugin does, in one line',

  commands: {
    // bc ${name} hello [name…]      In the chat: /${name} hello, or just ask for it in words.
    hello: {
      summary: 'say hello',
      // Who may run it: 'allow' (the agent may, freely), 'ask' (the owner approves each time),
      // 'owner' (only you, from a terminal or a slash command), 'never'.
      access: 'allow',
      usage: '[name...]',
      run: (ctx, i) => {
        const who = i.name?.length ? i.name.join(' ') : 'world';
        // \`text\` is shown to people; \`data\` is what the agent gets with --json.
        return { text: \`Hello, \${who}. It is \${ctx.api.hm(ctx.api.now())}.\`, data: { greeted: who } };
      },
    },

    // Questions asked in the terminal, or in the chat under /setup.
    setup: {
      summary: 'choose a greeting',
      access: 'owner',
      form: [{ id: 'greeting', type: 'text', message: 'What should it say?', default: (_a, ctx) => ctx.config.get().greeting ?? 'Hello' }],
      run: (ctx, a) => {
        ctx.config.set({ greeting: a.greeting });
        return \`Saved: "\${a.greeting}".\`;
      },
    },
  },

  // Work done by itself. Runs in a process of its own; ctx.notify sends the owner a message.
  // jobs: [{ id: 'check', cron: '*/30 * * * *', summary: 'look at something', run: async (ctx) => {} }],

  // One line for \`bc status\`, and what \`bc ${name} settings\` shows.
  status: (ctx) => \`greeting: \${ctx.config.get().greeting ?? 'Hello'}\`,

  // What the agent is told about this plugin is in agent.md, beside this file. What changes
  // from one installation to another is filled in from here: {{greeting}} in that file.
  agent: { fill: (ctx) => ({ greeting: ctx.config.get().greeting ?? 'Hello' }) },
};
`;

export async function scaffold(name) {
  if (!NAME.test(name)) fail('A plugin name is 2 to 21 lowercase letters, digits or dashes, starting with a letter.');
  if (available().some((p) => p.name === name)) fail(`There is already a plugin called "${name}".`);
  const dir = path.join(USER_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.js'), TEMPLATE(name));
  fs.writeFileSync(
    path.join(dir, 'agent.md'),
    `To greet someone: \`blackcat ${name} hello <name> --json\`. The greeting the owner chose is "{{greeting}}".\n`,
  );
  const p = await loadOne({ name, dir, bundled: false });
  if (p.error) fail(`The template did not load: ${p.error}`);
  return [
    `Created ${dir}/plugin.js and agent.md (what the agent is told about it)`,
    '',
    'It works as it is. Try it:',
    `  bc plugin enable ${name}`,
    `  bc ${name} hello`,
    '',
    'Then edit the file. docs/plugins.md explains each part; the plugins in plugins/ are worked examples.',
  ].join('\n');
}

// A plugin from a git address. It is fetched and checked, but not switched on: that is a
// separate step, taken after reading what it does.
export async function install(address, { name } = {}) {
  if (!/^(https:\/\/|git@|ssh:\/\/|file:\/\/|\/)/.test(address)) fail('Give a git address: https://…, git@…, or a folder on this machine.');
  const guess = (
    name ??
    path
      .basename(address)
      .replace(/\.git$/, '')
      .replace(/^blackcat-(plugin-)?/, '')
  ).toLowerCase();
  if (!NAME.test(guess)) fail(`"${guess}" can't be a plugin's name. Give one with --name (lowercase letters, digits, dashes).`);
  if (available().some((p) => p.name === guess))
    fail(`There is already a plugin called "${guess}". Remove it first (bc plugin remove ${guess}) or give another --name.`);
  fs.mkdirSync(USER_DIR, { recursive: true });
  const dir = path.join(USER_DIR, guess);
  const r = await git(['clone', '--depth', '1', '--', address, dir]);
  if (!r.ok) fail(`Could not fetch it: ${r.out.split('\n').at(-1)}`);
  const p = await loadOne({ name: guess, dir, bundled: false });
  if (p.error) {
    fs.rmSync(dir, { recursive: true, force: true });
    fail(
      `That is not a plugin blackcat can use, so it was not kept: ${p.error}${/must match its folder name/.test(p.error) ? `\nTry: bc plugin add ${address} --name <the name it gives itself>` : ''}`,
    );
  }
  const m = p.manifest;
  const at = mountOf(m).join(' ');
  const line = (n, c) =>
    `  bc ${at} ${n}${c.usage ? ` ${c.usage}` : ''}   ${typeof c.access === 'function' ? 'decided per use' : c.access}`;
  return [
    `Fetched "${m.title}" into ${dir}`,
    m.description,
    '',
    'Its commands, and who may run each:',
    ...Object.entries(m.commands)
      .filter(([, c]) => !c.hidden)
      .map(([n, c]) => line(n, c)),
    ...(m.jobs?.length ? ['', `It runs by itself: ${m.jobs.map((j) => j.id).join(', ')}`] : []),
    ...(m.source ? ['', `It adds a source of messages to the archive: ${m.source.label}`] : []),
    '',
    'It is NOT switched on yet. A plugin is code that runs as you, with everything you can do on this machine.',
    `Read ${dir}/plugin.js first, then: bc plugin enable ${guess}`,
  ].join('\n');
}

export async function uninstall(name, { data = false } = {}) {
  const e = available().find((p) => p.name === name);
  if (!e) fail(`No plugin "${name}". See: bc plugin list`);
  if (e.bundled) fail(`"${name}" is part of blackcat. Switch it off instead: bc plugin disable ${name}`);
  const wasOn = isEnabled(name);
  update((cfg) => {
    const pl = (cfg.plugins ??= {});
    pl.enabled = (pl.enabled ?? []).filter((x) => x !== name);
    pl.disabled = (pl.disabled ?? []).filter((x) => x !== name);
    if (data && pl.settings) delete pl.settings[name];
  });
  fs.rmSync(e.dir, { recursive: true, force: true });
  if (data) fs.rmSync(path.join(PLUGIN_DATA, name), { recursive: true, force: true });
  return `Removed ${name}${data ? ', with its settings and data' : ' (its settings and data are kept; add --data to delete them too)'}.${wasOn ? ' Restart the agent so the agent forgets it: bc restart agent' : ''}`;
}
