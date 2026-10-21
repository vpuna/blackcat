# Plugins

A plugin adds an ability to blackcat: a system to read or act on, a source of messages, a scheduled check. It is a folder with a `plugin.js` whose default export is a manifest. From the manifest blackcat builds the commands, the agent's permissions and instructions, setup in the terminal and the chat, scheduled jobs and the status line.

```
plugins/<name>/plugin.js        bundled with blackcat
user-plugins/<name>/plugin.js   your own (git-ignored)
```

> A plugin runs as you, with everything your user can do. Only enable plugins you have read. blackcat asks you to confirm this for anything outside `plugins/`.

## Quick start

```sh
bc plugin new plex        # writes user-plugins/plex/plugin.js and agent.md from a working template
bc plugin enable plex
bc restart agent          # the agent learns the new commands
bc plex hello
```

The smallest working plugin:

```js
export default {
  api: 1,
  name: 'plex',                       // must equal the folder name
  title: 'Plex',
  description: 'what is playing and what was added',
  commands: {
    hello: {
      summary: 'say hello',
      access: 'allow',
      usage: '[name...]',
      run: (ctx, input) => {
        const who = input.name?.length ? input.name.join(' ') : 'world';
        return { text: `Hello, ${who}.`, data: { greeted: who } };
      },
    },
  },
};
```

Other plugin commands:

```sh
bc plugin add <git url>   # install someone else's: fetched and described, not enabled
bc plugin list            # what exists, what is enabled, what was not loaded and why
bc plugin info <name>     # its commands, access levels and jobs
bc plugin disable <name>  # --data also deletes its settings, secrets and data
bc plugin remove <name>   # delete one you added (--data: its settings and data too)
```

## Example plugins

| Plugin | Shows |
|---|---|
| `plugins/host/` | the smallest complete one: a read command, a setup form, a job, access that depends on the arguments |
| `plugins/ssh/` | access decided per command line, secrets, a folder of keys, `storage` |
| `plugins/calendar/` | fetching on a schedule into a local copy; dated items for the briefing (`agenda`) |
| `plugins/mail/` | a message source, with attachments fetched on demand |
| `plugins/wa/`, `plugins/tg/` | a service that collects messages; interactive linking; `tg` mounts its commands under a group (`bc tg account …`) |
| `plugins/tg-bot/` | a channel |
| `plugins/claude-code/` | an engine |
| `plugins/voice/`, `plugins/ocr/`, `plugins/docs/` | file readers: voice notes, pictures, documents |
| `plugins/shortcut/` | commands the owner defines; chat menu entries added at run time |

`src/reminders/` and `src/watch/` are core parts written with a manifest. They show messages with buttons, chat commands, per-tick work, and a form built from what other plugins offer.

Bundled plugins with `default: true` are on unless disabled: `claude-code`, `docs`, `ocr`, `shortcut`, `tg`, `tg-bot`, `voice`, `wa`. `default` is ignored in `user-plugins/`.

## Rules

`test/rules.test.js` and `test/plugin-api.test.js` enforce these.

1. The core imports no plugin. blackcat runs with every plugin disabled.
2. No plugin imports another. Use another plugin through its commands (`ctx.command`). To offer something to all plugins, declare it in the manifest (`names`, `agenda`, `storage`).
3. A plugin uses the core only through `src/api.js`. Bundled plugins import it (`import { … } from '../../src/api.js'`). Plugins outside the repository use `ctx.api`, which has the same functions. Plugins may not import `src/internal.js`.
4. A plugin reaches only its own data: its settings, secrets, store and folder. The API gives no access to another plugin's data, the whole settings file, blackcat's database, the agent's standing permissions or the data folder itself.
5. Only a channel plugin talks to a chat service. Everything else uses the neutral `ui`.

These rules are not a sandbox. A plugin runs in the same process and can open any file you can. You are protected because you choose what runs, and the agent cannot enable, add or edit a plugin.

## Manifest

`api`, `name`, `title`, `description` and `commands` are required.

| Key | Purpose |
|---|---|
| `api` | Plugin API version. Must be `1`. |
| `name` | Lowercase letters, digits and dashes, starting with a letter; 2 to 21 characters. Must equal the folder name. Becomes `bc <name> …`. |
| `title` | Display name. |
| `description` | One line, no full stop. |
| `commands` | See [Commands](#commands). |
| `mount` | Put the commands under a group: a plugin named `plex-music` with `mount: 'plex music'` gives `bc plex music …`. One or two words. See [Names](#names). |
| `help` | Text shown at the end of `bc <name> --help`. |
| `default` | `true`: on without being enabled. Bundled plugins only. |
| `uses` | Plugins whose commands you call. See [Calling another plugin](#calling-another-plugin). |
| `jobs` | See [Jobs](#jobs). |
| `services` | See [Services](#services). |
| `chat` | See [Chat](#chat). |
| `channel` | See [Channels](#channels). |
| `engine`, `trials`, `readerTrials` | See [Engines](#engines). |
| `checks` | Checks you offer, ready to add: `[{ id, name, summary, run, measure, limit, context, every }]`, or a function of ctx returning them (only what is set up, by its real names). Nothing runs until the owner adds one (`bc check add --from <plugin>:<id>`, their options replacing yours); it is then a check like any other. |
| `agent` | See [Agent notes](#agent-notes). |
| `source` | See [Message sources](#message-sources). |
| `fileReaders` | See [Reading files](#reading-files). |
| `storage` | See [Storage](#storage). |
| `privateData` | Names of private data: a login folder at the top of the data folder, or a database in your folder (`['plex-account']`). The agent is kept from them by name, whether the plugin is on or off. |
| `aliases` | `(ctx) => [{ name: 'movie', command: 'play', input: { what: 'the usual' }, usage: '[room]' }]` adds top-level words: `bc movie`, `bc movie kitchen`. Arguments named in `usage` are added to `input`. |
| `status` | `(ctx) => 'text'`: one line for `bc status`. |
| `settings` | `(ctx) => ({ … })`: what `bc <name> settings` shows. |
| `names`, `agenda`, `briefing`, `waiting`, `inboxKeeps`, `ownerMoved`, `chatRenamed`, `mentions`, `keptToDo`, `nudgeDone`, `selftest` | See [Core hooks](#core-hooks). |

blackcat checks every key at load. An unknown key or a wrong type is reported with the nearest known key, the plugin is skipped, and `bc plugin list` shows why.

Functions may be async, except these, whose result is used at once: `aliases`, `names`, `nudgeDone`, `agent.fill`, `agent.readDirs`, `channel.paired`, `channel.self`, `storage.places`, `source.connected`, `source.collects`, `engine.takes`, a file reader's `ready` and a job's `when`.

A hook that throws fails only that command, job or set of notes.

### Names

Names are first come, first served, and blackcat's own come first. Your plugin is not loaded, and `bc plugin list` says why, if:

- Its folder has the name of a bundled plugin or a core part (`ssh`, `backup`). Settings, secrets and the private folder go by name. To change a bundled plugin, copy it under a new name.
- Its name or mount is a single word that blackcat uses as a command (`status`, `chat`, `channel`, …).
- Its `mount` does not begin with its own name, or the part before a dash (`tg-notes` may use `tg notes`).
- Its mount equals, contains or sits inside another plugin's (`tg` alone would cover `tg account`).
- Its title, a service id, a chat command or a source id is already taken.

Where the first answer wins (a name for an address, a file reader), bundled plugins are asked before yours. Disable the bundled one to have yours used.

## Commands

Each entry in `commands` becomes `bc <plugin> <command>`. The agent runs nothing but `blackcat …` commands, so a plugin command is the only way to give the agent a new ability.

```js
commands: {
  playing: {
    summary: 'what is playing right now',
    access: 'allow',
    usage: '[library]',
    options: [['--limit <n>', 'how many', '10']],
    run: async (ctx, input) => { … },
  },
}
```

| Key | Purpose |
|---|---|
| `summary` | Required. One line, shown in help, in `/setup` and to the agent. |
| `run` | Required. `(ctx, input) => result`. `input` holds arguments and options by name. |
| `access` | Required. See [Access levels](#access-levels). |
| `usage` | Positional arguments, commander style: `'<host> [path...]'`. |
| `options` | `[flags, description, default, { many: true }]` each. With `many`, the option repeats and arrives as a list. |
| `form` | Questions asked before `run`. See [Forms](#forms). |
| `working` | With a `form`: text shown while `run` works (`'Signing in…'`). |
| `raw` | The arguments are free text, kept exactly as typed. `input._` is the list of words; no options are parsed. See `ssh run`. |
| `interactive` | The command drives the terminal itself, for example to show a QR code and wait. It runs only in a terminal, never for the agent, and is not in `/setup`. |
| `hidden` | Left out of help, chat menus and the agent's instructions. For a service's `run`. |
| `long` | It takes minutes. Typed in the chat, it runs beside the conversation and its result is sent when it ends. It may be stopped with SIGTERM, so clean up. |
| `sends` | It fetches a file for the owner. Save it in your media folder and return `data.path` and `data.caption`; typed in the chat (`/allsky now`), the file is sent. |
| `changes` | It changes something although its access is `allow` (a sync, a look that marks what it read), so the activity record does not count it as a look. |
| `untrusted` | `false` only when the output is your own measurements or settings. See [Output](#output). |

`form` cannot be combined with `raw` or `interactive`.

### Return values

`run` returns nothing, a string (printed as is), or `{ text, data }`: `text` for people, `data` (an object) for `--json`. Every command gets `--json`, and the agent always uses it. A command that prints its own output should honour `input.json`.

A list as `data` is printed as that list. It cannot carry the untrusted-content notice, so mark in each entry what other people wrote. `raw: true` in the result prints `data` exactly, for a result with its own notice.

Return the result. Never `console.log` it or end the process: the same command is typed, run by the agent, shown in the chat and called by other plugins. If something you loaded keeps the process alive (a model's threads), return `end: true`.

To stop with a message instead of a stack trace, call `ctx.fail('what went wrong and what to do')`. An error class of your own can extend `PluginError` from `src/api.js` to the same effect. `explainErrors((e) => 'a sentence' | null)` supplies your wording for an error blackcat would otherwise show raw, such as a service's numeric error code.

### Output

Text from an outside system (logs, API responses, other people's messages) can contain instructions aimed at the agent. With `--json`, results are labelled as untrusted data unless the command sets `untrusted: false`.

The agent gets at most 25,000 characters from one command (`AGENT_MAX_OUTPUT` in `src/plugins/cli.js`). Over that, the command fails and the agent is told to ask for less. Keep outputs short, and offer ways to narrow them: a search, `--since`, one item by id, `--limit`.

### Standard commands

Every plugin gets two commands. Define one of the same name to replace it.

- `status`: how it is doing now. Your `status` line and your jobs.
- `settings`: how it is set up. What `ctx.config` holds, or what the manifest's `settings(ctx)` returns. Secrets are named, never shown.

A model name is a setting. "The model is loaded" is status.

### Naming

Use these words, and only for these purposes. `test/conventions.test.js` holds bundled plugins to them.

| To | Call it | Notes |
|---|---|---|
| connect the one system a plugin talks to | `setup` | Run again to change anything. `bc plugin enable` points to it. |
| connect one of several | `add`, with `remove <name>` and `list` | SSH machines, mail accounts, calendars. A command called `add` always comes with `list` and `remove`, whatever it adds. |
| link a personal account, or a device | `pair`, `unpair` | WhatsApp, Telegram, an Android phone |
| change preferences | `setup` | quiet hours, alert limits, which model |
| see one thing | `show <id>` | |
| look something up | `find <text>` | |
| fetch again from the origin | `sync` | |
| see whether a connection works | `test` | |
| succeed or fail, for a check (`bc check add … --run "blackcat <you> check"`) | `check` | Its summary says "made for checks". To report several separate things, set `process.exitCode = 1` and return `data: { problems: [{ key, title }] }`; run with `--json`, each becomes a finding of its own. |
| say how far back to look | `--since 6h`, `--since 7d` | never only `--hours` or `--days` |
| report health; report configuration | `status`; `settings` | built in; write your own only to add detail |
| disconnect for good | nothing | the owner runs `bc plugin disable <name> --data` |

Do not use `delete`, `rm`, `ls`, `configure`, `connect`, `login`, `disconnect`, `logout`, `refresh`, `update`, `info` or `ping`.

### Access levels

`access` says what the agent may do. The owner can run everything, in the terminal or `/setup`.

| `access` | The agent |
|---|---|
| `'allow'` | runs it without asking. Only for commands that cannot change anything. |
| `'ask'` | needs the owner's Allow in the chat, and the owner sees the exact command. For anything that changes something. |
| `'owner'` | can never run it. For setup, credentials, and anything that changes what the agent may do (adding a host, raising a mode). |
| `'never'` | can never run it. Use it for "this exists but is off". |

When the level depends on the arguments, `access` is a function of the words after the command name. It must have no side effects:

```js
access: (ctx, tokens) => {
  if (ctx.config.get().readOnly) return { level: 'never', reason: 'this library is read-only for you' };
  return { level: 'ask', describe: `delete "${tokens.join(' ')}" from Plex` };   // describe is shown in the prompt
},
```

The approval names a plugin that is not bundled as yours: `use Plex (your plugin "plex"): delete "…" from Plex`. A bundled plugin may return `asks` to replace that whole line; for other plugins `asks` is ignored, so a borrowed name cannot pass for blackcat's own.

Add `once: true` to an `ask` result for something the owner must approve every time, such as unlocking a door. The prompt then offers no "Always allow".

Access is checked twice: by the agent's policy, and again by the command itself. The agent must run a plugin command as one plain command; anything chained, piped or redirected is refused.

## Forms

A command with a `form` asks questions before it runs. It works three ways:

- in the terminal, as prompts: `bc ssh add`
- non-interactively, each question as an option: `bc ssh add --name nas --host 10.0.0.5 …`
- in the chat, under `/setup`

```js
setup: {
  summary: 'connect to your Plex server',
  access: 'owner',
  form: [
    { id: 'url',   type: 'text',    message: 'Server address', default: (a, ctx) => ctx.config.get().url ?? 'http://plex.local:32400',
      validate: (v) => (/^https?:\/\//.test(v) ? undefined : 'Start with http:// or https://') },
    { id: 'token', type: 'secret',  message: 'Plex token', keep: true },
    { id: 'alerts', type: 'confirm', message: 'Tell me when something new is added?', default: (a, ctx) => ctx.config.get().alerts ?? true },
    { id: 'when',  type: 'select',  message: 'How often?', when: (a) => a.alerts,
      options: [{ value: 'daily', label: 'Once a day' }, { value: 'now', label: 'Straight away', hint: 'can be chatty' }] },
    { type: 'note', message: 'You can find the token under Settings → …' },
  ],
  run: async (ctx, a) => {
    const token = a.token || ctx.secrets.get('token');   // empty: keep the saved one
    await check(a.url, token);                           // try it before saving anything
    ctx.secrets.set('token', token);
    ctx.config.set({ url: a.url, alerts: a.alerts, when: a.when });
    return 'Connected.';
  },
},
```

Question ids are camelCase. The option for `someId` is `--some-id`.

| Type | Asks for | Notes |
|---|---|---|
| `text` | a line of text | `default`, `optional: true` |
| `secret` | a hidden line of text | Never echoed, logged or given as an option. In the chat the owner's message is deleted once read and never reaches the agent. `keep`: see below. |
| `select` | one of `options: [{ value, label, hint }]` | |
| `confirm` | yes or no | |
| `browse` | a folder, chosen by walking through folders | Supply `list: async (dir, answers, ctx) => [names]`, and optionally `create: async (dir, answers, ctx)` and `start`. The person can enter a folder, go up, make one, or type a path. The folders can be anywhere: backup lists another machine's over SSH. |
| `note` | nothing | Shows `message`. |

Other question keys:

| Key | Purpose |
|---|---|
| `message`, `default`, `options` | A value, or a function of `(answers, ctx)`. |
| `when: (answers, ctx) => boolean` | Skips the question when false. |
| `validate: (value, answers, ctx)` | Returns a problem as text, or nothing. |
| `help` | What `--help` says of the option, when the question would not read well there. |
| `sticky: true` | Given as an option, it is set. Left out, away from a terminal, it keeps its current value. For rarely changed answers, such as an engine's options. |

`form` may be a function that returns the questions. blackcat calls it once every plugin has loaded, so the form can depend on what other plugins offer.

### Running setup again

Setup is also how settings are changed, so give `default` as a function of what is saved, never a fixed value. The current value is then prefilled in the terminal and marked ✓ in the chat.

Add `keep: true` to a `secret` question whose answer you store with `ctx.secrets.set(<its id>, …)`. When one is saved, an empty answer keeps it, and `run` receives `''` and must leave the saved secret alone. Away from a terminal it is kept without asking, so `bc plex setup --url http://new-address` works with no token. For a secret stored another way, such as one per account, use `keep: (answers, ctx) => boolean` to say whether one is saved.

## Context

Every hook receives `ctx`.

| Member | Purpose |
|---|---|
| `ctx.config.get()` / `.set(patch)` | Your settings, in `config.json` under your plugin's name. Not for secrets. |
| `ctx.secrets.get(k)` / `.set(k, v)` / `.delete(k)` / `.has(k)` / `.names()` | Tokens, passwords, keys. Stored in `data/plugins/<name>/`, which the agent can never read. |
| `ctx.store.get(k)` / `.set(k, v)` / `.delete(k)` / `.keys()` / `.update(k, fn)` | State that changes with use: what you last fetched, where you got to. Any JSON value under a key, in blackcat's database, private to your plugin. `update` is atomic. |
| `ctx.dataDir` | A private folder for files (keys, a database of your own). |
| `ctx.command(plugin, command, input)` | Run a command of a plugin in `uses`. Returns `{ text, data }`. |
| `ctx.exec(cmd, args, { timeoutMs, input })` | Run a program without a shell. Never throws. Returns `{ code, stdout, stderr, timedOut }`, the output as text. The default timeout is one minute. For a program that writes binary data (a picture), have it write a file. |
| `ctx.notify(text, { picture })` | Message the owner on the channel in use. For jobs and alerts. `picture` is a file sent with it, from a folder in your `agent.readDirs`. Returns true if sent. |
| `ctx.progress(text)` | One message to the owner that shows how work is going, changed as it goes. Returns `{ update(text), done(text) }`, or null when there is nowhere to send it. Where messages cannot be changed, only the first and the last are sent. |
| `ctx.askOwner({ text, choices, picture, expiresIn })` | Ask the owner and wait for the answer. See [Asking the owner](#asking-the-owner). |
| `ctx.log(msg)` | Write to the service log (`bc logs`). Never log secrets. |
| `ctx.ask(system, input, { model })` | Ask a model one question with no tools. Returns text. |
| `ctx.reader(job, { values, input, schema, also })` | Ask a reader defined in `readers/<job>.md`. `also` is text added after the file's instructions. See [Readers](#readers). |
| `ctx.fail(msg)` | Stop with a message for the person. |
| `ctx.plugin` | Your plugin's name. |
| `ctx.caller` | `'owner'`, `'agent'` or `'job'`. |
| `ctx.surface` | `'terminal'`, `'chat'` or `'job'`: where the result is read. `'chat'` is the owner's chat on any channel: a command typed there, or run by the agent for it. |
| `ctx.api` | Everything in `src/api.js`: `ctx.api.shell(…)`, `ctx.api.ymd()`. |

The agent can open nothing under `data/` except `data/<name>-media/`, and only if you declare that folder with `agent: { readDirs: () => [it] }`.

### Asking the owner

A command, job or service that needs the owner's word in the middle of its work asks with `ctx.askOwner`:

```js
const a = await ctx.askOwner({
  text: 'Book this ride? Price: €24 - 31',
  picture: shot, // optional: a file in a folder you declare in agent.readDirs
  choices: ['✅ Book it', '✖ Cancel'], // 2 to 4, up to 30 characters each; the last one does nothing
  expiresIn: 120, // seconds, 30 to 600; 120 if left out
});
if (a.answer === '✅ Book it') …
```

It returns `{ answer, how, why }`. `answer` is the choice tapped, or null. `how` is `'answered'`, `'expired'` or `'unasked'`, with `why` when it could not ask (no channel in use, the agent service not running).

The question goes to the owner's chat on the channel in use, with buttons. When the owner ran the command in a terminal on this machine, it is asked there instead, with the cursor on the last choice. Only the owner's tap answers it, once, and not after it expires; a message they write instead ends it unanswered (`how: 'answered'`, `answer: null`), as Cancel would. There is no "always": the same question is asked every time. Each question and its outcome are on the activity record.

Use it where the answer depends on something only known at that moment (a price, what a camera shows). For permission to run a command at all, use [access levels](#access-levels).

## Storing data

Settings go in `ctx.config`, secrets in `ctx.secrets`, files in `ctx.dataDir`, and state that changes with use in `ctx.store`:

```js
const last = ctx.store.get('rooms');                 // undefined the first time
ctx.store.set('rooms', { at: Date.now(), rooms });   // any JSON value
ctx.store.update('fetches', (n) => (n ?? 0) + 1);    // two processes at once lose nothing
```

Do not keep such state in a JSON file of your own, where a half-written file or a second writer loses data. Do not keep it in `ctx.config` either: every write there tells the rest of blackcat that settings changed.

For rows, keep a database:

```js
import { openSqlite, upgrade, withDb } from '../../src/api.js';

const STEPS = [
  (db) => db.exec('CREATE TABLE readings (at INTEGER, value REAL)'),   // 1
  (db) => db.exec('ALTER TABLE readings ADD COLUMN room TEXT'),        // 2: added later
];
const open = (ctx) => {
  const db = openSqlite(path.join(ctx.dataDir, 'readings.db'));
  upgrade(db, 'readings', STEPS);
  return db;
};
const latest = (ctx) => withDb(() => open(ctx), (db) => db.prepare('SELECT * FROM readings ORDER BY at DESC LIMIT 1').get());
```

- Each step runs once and is recorded. Never change a shipped step; add another at the end.
- `withDb` closes the database whatever happens, including in async code. Always use it; a test checks this. A service that keeps a database open while it runs is the one exception.
- Put the database in `ctx.dataDir`, or `ownDataDir(import.meta.url)` where there is no `ctx`.

### Code without `ctx`

A helper module with no `ctx`, such as a service's settings reader, is identified by its file location:

```js
import { dataPath, ownDataDir, settingsChangedAt, settingsFor } from '../../src/api.js';

const mine = settingsFor(import.meta.url);        // mine.get(), mine.set({ … }): this plugin's settings only
const dir = ownDataDir(import.meta.url);          // the same folder as ctx.dataDir
const login = dataPath('sms-account');            // a folder of yours at the top of the data folder
const media = dataPath('sms-media');              // the one you open to the agent (agent.readDirs)
if (settingsChangedAt() > seen) reread();         // for a service: reread settings only when they changed
```

`dataPath` refuses blackcat's own files and folders (`config.json`, the databases, `plugins/`, `inbox/`) and anything outside the data folder.

## Calling another plugin

A plugin may use another plugin's commands, and nothing else of it. List it in `uses`, then call `ctx.command`:

```js
export default {
  api: 1, name: 'movie-night', title: 'Movie night', description: 'dims the lights and starts the film',
  uses: ['ha'],
  commands: {
    start: { summary: 'start it', access: 'ask', run: async (ctx) => {
      const lights = await ctx.command('ha', 'set', { name: ['living', 'room', 'lights'], brightness: '20' });   // → { text, data }
      return `Ready. ${lights.text}`;
    } },
  },
};
```

- `input` is what the command's `run` receives: arguments and options by name, or `{ _: [words] }` for a `raw` command.
- The original caller carries through. A chain the agent started is judged as the agent, so `owner` and `ask` commands are refused.
- An `interactive` command cannot be called. All of a form's answers must be given.
- A plugin in `uses` that is not enabled is reported at startup, and again by whatever needed it. Circular `uses` are reported.

Use `ctx.command` when you need one specific plugin. When any plugin could provide the thing, use a manifest declaration so that neither side names the other: `names`, `agenda`, `briefing`, `source`, a channel's `self`, `storage`.

## Core hooks

The core calls these on every plugin that defines them.

| Key | Called when | Return |
|---|---|---|
| `names: (ctx, address) => 'Ana Silva'` | a plugin calls `ctx.api.nameOf(address)` or `personLabel({ name, email })` | a name you know for the address |
| `agenda: (ctx, { from, to }) => [...]` | the briefing is built | dated items, copied onto "Things I need to do": `{ id, source, sourceName, title, start, end, allDay, day, lastDay, location, from }`. `source` is the calendar's key, `sourceName` its current name, `from` the organiser. |
| `briefing: (ctx) => ({ problems: ['html'], fine: 'html', buttons: [{ label, id }], note: 'html' })` | the daily briefing is built | what is wrong, a line for when all is well, optional buttons to act on what is wrong, and a note shown at the end every time |
| `waiting: async (ctx) => ({ heading, lines: [{ text, note }] })` | the owner opens the terminal chat and no channel is in use | what you could not send, such as reminders that came due, or `null`. Handed over once. |
| `inboxKeeps: async (ctx) => [paths]` | files the owner sent are tidied (they are kept a month) | the ones you still need |
| `ownerMoved: async (ctx, { from, to }) => n` | another channel is put in use | move what you were going to send; return how many |
| `chatRenamed: async (ctx, { ref, name }) => n` | a plugin calls `chatRenamed(ref, name)` (a mail account was renamed) | use the new name where you keep the old one; return how many changed |
| `mentions: (ctx, regex) => ['shortcut /porch']` | an account is renamed | what of yours still says the old name, for the owner to change |
| `keptToDo: (ctx) => [{ kind, id, title, where }]` | something to do is added (a reminder, a list entry) | what you keep to be done. blackcat compares the words, with no model, so the same thing is not kept twice. |
| `nudgeDone: (ctx, { db, itemId }) => {}` | the owner marks done a nudge set through `src/reminders/nudges.js` (core parts only) | update your item |
| `selftest: (ctx) => [probes]` | `bc selftest` runs | one probe per thing you have set up |

### Self-test probes

```js
selftest: (ctx) => Object.entries(ctx.config.get().servers ?? {}).map(([name, s]) => ({
  name,                                   // one per server
  run: async () => {                      // a few words when all is well; throw a sentence when not
    const v = await ping(s, ctx.secrets.get(`key:${name}`));
    return `answers · version ${v}`;
  },
})),
```

A probe only reads. It never changes, sends, fetches to keep, or runs something the owner defined. Return `{ skip: 'why' }` when there is nothing to test, such as an unlinked account. A probe fails after 30 seconds (`timeoutMs`), and an answer after 15 seconds is marked slow (`slowMs`).

## Storage

A plugin that can hold files somewhere (another machine, a cloud bucket, a disk) declares `storage`. Backup then offers its places beside "this machine" and uses them to send, list, fetch and prune. `plugins/ssh/` is the example; `src/storage.js` documents each call.

```js
storage: {
  label: 'machines reached over SSH',
  places: (ctx) => [{ id: 'nas', label: 'nas (me@10.0.0.5)' }],
  list:   async (ctx, place, dir) => [{ name, bytes, folder }],
  mkdir:  async (ctx, place, dir) => {},          // including parent folders
  put:    async (ctx, place, file, to) => {},     // atomic, and private to its account
  get:    async (ctx, place, from, file) => {},
  remove: async (ctx, place, paths) => {},
  free:   async (ctx, place, dir) => '1.2T',      // optional
},
```

Paths are full paths, checked before you see them. You are called as the owner: a file goes only where the owner configured, whoever started the backup.

## Jobs

The agent service starts each job run as a separate process (`blackcat plugin job <plugin> <id>`), so a job that crashes or hangs cannot take the agent down. A run is stopped after 20 minutes.

```js
jobs: [
  { id: 'watch',   cron: '*/10 * * * *', summary: 'alert when a stream fails', run: async (ctx) => { … } },
  { id: 'digest',  cron: '0 8,20 * * 1-5', run: async (ctx) => { … } },
  { id: 'nightly', cron: (ctx) => ctx.api.fromTimes(ctx.config.get().time, 'daily'), run: async (ctx) => { … } },
],
```

| Key | Purpose |
|---|---|
| `id`, `run` | Required. |
| `cron` | Five fields (`minute hour day-of-month month day-of-week`), local time. A string, a list, or `(ctx) => …` when the schedule is a setting. Checked at load. |
| `every`, `at` | Shorthand for `cron`: `every: '15m'`, `at: ['08:00']`. Give one of `cron`, `every` and `at`. |
| `summary` | One line. |
| `when: (ctx) => boolean` | Skips the job while there is nothing for it to do. |

`bc <plugin> status` shows each schedule in words with its next run. A job that was due while blackcat was off runs once when it comes back. To avoid repeating an alert, store what you last reported.

For schedules of your own, such as one the owner sets, the API has `schedule()` to check one, `describeSchedule()` to put it in words, `nextRuns()`, `scheduleDue(cron, lastTs)`, and `fromTimes()` and `fromEvery()` to turn times of day or an interval into cron.

### The activity record

What a job returns goes into the activity record (`bc activity recent`):

| Return | Recorded as |
|---|---|
| `{ idle: true }` | nothing to do: counted, not listed |
| `{ did: 'what happened' }` or a string | an entry |
| throws | failed |

Commands and `ctx.ask` calls are recorded for you. A command's arguments are kept only when its access is not `allow`.

Add entries of your own with `ctx.api.recordActivity({ kind: 'event', category: '<your plugin>', summary: '…' })`, never with message content in them. For something too frequent to list, add `countOnly: true` (and `count: n` for several at once).

If a command leaves a request for your service, keep `askedBy()` with the request and do the work inside `asAsked(by, fn)`. What the service records then belongs to the command that asked.

## Services

For something that must stay connected, such as a source, declare a service. blackcat's supervisor starts it when it is ready, restarts it if it dies, and stops it. It gets `bc restart slack`, `bc logs slack` and a row in `bc status`.

```js
services: [{
  id: 'slack',                               // the service name
  summary: 'Slack source (read-only)',
  command: 'run',                            // one of your commands; it should not return
  ready: (ctx) => (ctx.secrets.has('token') ? null : 'not connected → bc slack setup'),
  health: (ctx) => null,                     // optional: a problem only you can see ("logged out"), or null
}],
```

`ready` returns why the service cannot start yet, or `null`. Every two minutes blackcat checks that each service that is switched on and ready is running, and calls `health`. The owner is told once when a problem appears and once when it is gone.

In the command, exit with code 3 for "needs the owner" (logged out, not set up). The service is then not restarted.

Call `serviceConnected()` from the API once the service is connected and working, and `serviceConnected({ offlineMs })` after a dropped connection comes back. The activity record then shows how long it took to start and how long it was cut off.

## Chat

`ctx.notify(text)` is enough for a plain alert. For buttons, a chat command of your own, or delivery at an exact time, declare `chat`:

```js
chat: {
  commands: [{ command: 'plex', description: 'What is playing' }],
  install: (ui, { ctx }) => {
    ui.command('plex', (c) => c.reply('<b>Nothing</b> is playing', { html: true, actions: actions().add('⏹ Stop', 'plex:1:stop') }));
    ui.action(/^plex:(\d+):(stop)$/, async (c) => {
      await c.toast('Stopped');
      await c.edit('Stopped.');                    // the message whose button was tapped
    });
  },
  tick: async (ui, s) => { … },
  quick: async (text, { ctx }) => null,
},
```

| Key | Purpose |
|---|---|
| `commands` | Added to `/help` and the channel's menu. May be `(ctx) => [{ command, description }]` when the list depends on settings, as in the shortcut plugin. After changing what it returns, call `refreshMenu()`. |
| `install` | Called once when the agent service starts. Register handlers here. |
| `tick` | Called every 20 seconds inside the agent service, so it must return quickly. `ui` is `null` when no channel is in use. |
| `quick` | Offered every message, typed or transcribed, before the agent. Return `null` unless you are certain what is meant. `{ text, note }` answers directly; `note` goes to the agent with the owner's next message. `{ confirm: 'Really?', run: async () => ({ text, note }) }` asks first. |

Code in `install` and `tick` can message the owner. The agent cannot reach it: only the owner's messages and taps reach your handlers.

Nothing here names a chat service. On Telegram, `actions()` are buttons. On a channel without buttons they are listed with numbers and the owner answers with a number. Formatting is a subset of HTML (`<b> <i> <u> <s> <code> <pre> <a href> <blockquote>`), stripped for plain-text channels. A channel that cannot edit a message sends the new version as a new message.

All plugins share one space of action ids. Start yours with your plugin's name (`plex:…`) and keep each under 64 bytes.

`ui`:

| Member | Purpose |
|---|---|
| `ui.command(name, (c, next) => …)` | The owner typed `/name`. Several handlers may answer one name; `next()` passes it on. |
| `ui.action(pattern, (c) => …)` | The owner tapped a button whose id matches a string or regular expression. |
| `ui.text((c, next) => …)` | Any other text, before the agent. Call `next()` unless it is yours. |
| `ui.heard((ev) => …)` | Told of every message the owner writes (not a number answering a list of choices), before anyone takes it. It cannot take the message: use it to give up on something that waited for a tap. |
| `ui.send(chat, text, opts)` | Send unprompted. Returns a reference for `ui.edit(chat, ref, text, opts)`, `ui.setActions(chat, ref, actions \| null)` and `ui.remove(chat, ref)`. Text longer than the channel takes is split at line ends, with the actions under the last part. Formatted text that long goes as plain text, so keep formatted messages under the limit. |
| `ui.sendFile(chat, path, { caption })` | Send a file from a folder the agent may read. Returns false if it may not be sent. |
| `opts` | `{ html: true, actions: actions().add(label, id).row()…, preview: false, what: 'the weekly report', dueTs }`. `what` names, for the activity record, what you send from `tick` (never the text itself). `dueTs` (seconds) is when it was meant to go. |

`c`, passed to a handler:

| Member | Purpose |
|---|---|
| `c.chat`, `c.who`, `c.text`, `c.args`, `c.match` | Where, who, what was written or tapped. `c.args` follows the command; `c.match` is the pattern match. |
| `c.reply(text, opts)` | Answer. Returns a reference. |
| `c.edit(text, opts)`, `c.setActions(a)`, `c.clearActions()` | Change the message whose button was tapped. |
| `c.toast(text)` | Acknowledge a tap. If you do not, blackcat does. |
| `c.gone(text)` | The same, when what the button was about no longer exists. The activity record notes that the tap did nothing. |
| `c.working()`, `c.remove()`, `c.sendFile(path, caption)` | Show "typing…"; delete the owner's message (a secret); send a file. |

`s`, passed to `tick`:

| Member | Purpose |
|---|---|
| `s.ctx` | Your `ctx`. |
| `s.now`, `s.nowMs` | The time. |
| `s.chat` | The owner's chat on the channel in use: `ui.send(s.chat, …)`. |
| `s.last(key)`, `s.mark(key, value)` | Small persistent markers ("when did this last run?"). |
| `s.once(name, fn)` | Run `fn` unless the previous run under that name is still going. |
| `s.runJob(args)` | Run `blackcat <args…>` as a separate low-priority process and return what it printed. For anything slow. Ask for `--json`: log lines from that process are kept apart from what it prints. |

## Agent notes

While your plugin is enabled, the agent's instructions include a section built from the manifest: the description, each command with its access level, and your notes. Use the notes for what a list of commands cannot say: when to use the plugin, how to phrase arguments, what to check first.

The notes are a file, `agent.md`, beside `plugin.js`. Values that depend on the installation come from `agent.fill`, which must not be async:

```markdown
<!-- when: not ready -->
No SSH hosts are set up yet. The owner adds one with `bc ssh add` or /setup.
<!-- when: ready -->
Hosts: {{hosts}}.
Run things with `blackcat ssh run <host> '<command>' --json`. …
```

```js
agent: { fill: (ctx) => ({ ready: list(ctx).length > 0, hosts: list(ctx).map(describe).join('; ') }) },
```

| In `agent.md` | Meaning |
|---|---|
| `{{name}}` | Replaced by that value. A list becomes one line per item. A line that is only a placeholder is dropped when the value is empty. |
| `<!-- when: name -->` | What follows applies when the value is set (true, a number, or not empty). |
| `<!-- when: not name -->` | What follows applies when it is not. |
| `<!-- always -->` | What follows always applies. |

Text before the first marker is always included. A plugin with nothing to fill in needs no `fill`. A placeholder with no value is an error: the notes are left out and the log says why. Keep whole sentences in the file, and supply names and lists from `fill`, not fragments of prose.

Two more keys under `agent`:

- `readDirs: (ctx) => [folders]` opens folders to the agent: it may read files there, and the chat may send them to the owner. For files your plugin fetches. Inside the data folder only `data/<name>-media/` is honoured.
- `listCommands: false` leaves your commands out of the agent's instructions, so the notes must say everything. Sources use this, because the agent reads their messages through `bc msg …`.

## Readers

When a model must read text written by other people (to classify messages or summarise a page), do not hand that text to the agent. Ask a reader: a model with no tools, so nothing in the text can cause an action.

Describe what the reader looks for in `readers/<job>.md` beside `plugin.js`, and give the shape of the answer in code:

```js
const ANSWER = { type: 'object', additionalProperties: false, required: ['urgent', 'why'],
  properties: { urgent: { type: 'boolean', description: 'Whether it needs the owner today.' }, why: { type: 'string', description: 'One short sentence.' } } };

const found = await ctx.reader('urgent', { values: { who: 'the school' }, input: text, schema: ANSWER });
if (found.urgent) await ctx.notify(found.why);
```

- The file says what to look for and how to decide, with `{{placeholders}}` and `<!-- when: name -->` as in `agent.md`. It says nothing about the format of the answer.
- blackcat first tells every reader that what it reads is data, never instructions. Your file cannot remove that.
- `schema` is an object; put a list inside one (`{ items: [...] }`). Describe each field in its `description`, which the model sees. The engine holds the model to the schema and blackcat checks the answer. If it does not fit, blackcat asks once more, then throws.
- Without `schema` the answer is text.
- The owner can replace your file with `data/readers/<your plugin>/<job>.md`.

For a one-off question with no file, use `ctx.ask(system, input)`. It also has no tools, sends only what you give it, and returns text for you to check.

## Reading files

blackcat reads the files that come with messages as they arrive and keeps the words with the message (see the README's [Files in messages](../README.md#files-in-messages)). A plugin can be the reader on this machine for one kind of file:

```js
fileReaders: [
  {
    kind: 'voice',                                   // voice, pictures or documents
    read: async (ctx, { file, seconds }) => ({ text: 'what it says', score: 85 }),
    ready: () => true,                               // optional, not async: can it read just now?
    stop: async () => {},                            // optional: let go of what was loaded, when the work is done and when blackcat stops
  },
],
```

- `read` returns `{ text }`. An empty `text` means there is nothing to read in the file. Return `{ error: 'why' }` when it could not be read this time (it is tried again later), or `{ error: 'why', final: true }` when it never will be.
- `score`, 0 to 100, says how sure the reading is that it got everything. Leave it out if you cannot tell. In the `both` mode, a score under the owner's level sends the file to the model as well.
- The first enabled plugin that reads a kind and is `ready` is used. `plugins/ocr` is not ready where Tesseract is not installed.

What each kind is given and returns:

| Kind | Example | Notes |
|---|---|---|
| `voice` | `plugins/voice` | `seconds` is the length, or `null` for a voice note the owner sent to blackcat (that becomes their message). `score` is kept with the note and not used yet. |
| `pictures` | `plugins/ocr` | Returns `text` in reading order, `extra` (a list of words it found less surely, kept apart) and `score`. |
| `documents` | `plugins/docs` | Given `{ file, mime, name, tmp }`. Returns `{ parts: [{ label, text, picture, whole }], pages, cut }`, where a part is a page or a picture inside the document. `picture` is a file written into `tmp` (cleared afterwards) for the picture reader. `whole: true` says the picture is the whole page, so only what it adds to the part's `text` is kept. No score: the pictures' readings give it. |

## API reference

Everything a plugin may import from `src/api.js` (or reach as `ctx.api` outside the repository). The file is short and commented.

| For | Names |
|---|---|
| Your settings and folders without a `ctx` | `settingsFor`, `ownDataDir`, `dataPath`, `settingsChangedAt` |
| Time | `now`, `ymd`, `isoLocal`, `clock`, `hm`, `ago`, `agoShort`, `duration`, `sleep` |
| Reading a time a person wrote | `parseAt`, `parseDuration`, `parseTime`, `fmtWhen`, `TimeError`. `sinceTs` reads any `--since`: `45m`, `24h`, `7d`, `2mo` or a day; `m` is always minutes. |
| Schedules (cron) | `schedule`, `describeSchedule`, `nextRuns`, `scheduleDue`, `fromTimes`, `fromEvery`, `storedSchedule`, `ScheduleError` |
| Text and sizes | `size`, `esc`, `errMsg`, `chunks`, `plain`, `explainErrors`, `plural(n, one, many)` ("3 messages"), `took(ms)` ("4.2s"), `count(n)` ("36.0k"), `usd(x)` ("$0.13") |
| Errors | `PluginError` |
| Paths a person wrote | `expandHome`, `resolveHome` |
| Running programs | `shell`, and `ctx.exec`. `withoutSecrets(env, keep)` removes keys and logins from an environment before a program gets it. `classify`, `commandAccess` and `COMMAND_MODES` say whether a shell command only looks (`'read'`, `'sensitive'`, `'change'`); for a machine of another kind, pass its own looking programs and its personal patterns (`classify(cmd, { programs, sensitive })`, as the android plugin does for a device's shell). `touchesSecrets` says whether it would show blackcat's private files. |
| People | `nameOf`, `personLabel` |
| Named accounts (mail accounts, calendars, machines) | Keep each under a key that never changes and file everything for it under that key, so the owner can rename it. `accountNameQuestions` are the name questions for an `add` form; `chosenAccountName` gives `{ name, key, replacing }` from the answers. `renameAccount` for a `rename` command. `accountName`, `accountKey`, `accountNames`, `freeAccountKey` convert between names and keys. `chatRenamed(ref, name)` when an account's chat in the archive has a new name; `mentioning(regex)` lists the shortcuts, checks and permissions that still use an old name. |
| The chat | `actions`, `refreshMenu`, `chatCommands`, `directCommands`, `sendable`, `hasBot`, `notifyOwner` |
| Reading the archive | `openArchive`, `searchMessages`, `readThread`, `listChats`, `countChats`, `archiveStats`, `formatMessage`, `archiveMeta`, `sourceSql`, `QueryError`, `await semantic()` for search by meaning |
| Message files | `mediaPaths`, `downloadedPath`, `MEDIA_DIR`, `ARCHIVE_DB`, `reading`, `setReading` |
| Writing the archive (a source) | `openArchiveForWriting`, `archiveStatements`, `messageRow`, `mediaRow`, `setArchiveMeta`, `ownRefs` |
| Going back over a source's days of history (`bc wa recover`); work whose end the owner is sent | `recoverCommand`, `recoveredText`, `serveRecovery`, `workTable`, `leaveWork` |
| A database of your own | `openSqlite`, `upgrade`, `withDb`, `hasTable`, `hasColumn`, `addColumns` |
| A model with no tools | `askModel`; `ctx.ask` and `ctx.reader` are the same with your plugin's name on them |
| The activity record | `recordActivity`, `serviceConnected`, `askedBy`, `asAsked`. See [The activity record](#the-activity-record). |
| Services | `service`, `show`, `controlService` (start, stop or restart one through the supervisor), `isInstalled`, `await serviceCommands()` |
| Terminal questions | `await prompts()` |
| A channel plugin | `keepFile`, `INBOX_MAX_BYTES`, `runAgent`, `useChannelIfNone` |
| Logging | `log`; prefer `ctx.log`, which adds your plugin's name |

## Message sources

A plugin that collects messages (mail, SMS, another chat service) declares a `source` and writes into the shared archive. Search, watches, the to-do watch and file fetching then treat it like any other source. `plugins/mail/` is the example to copy; `test/source-plugin.test.js` builds a small one.

```js
source: {
  id: 'sms', label: 'Text messages',
  optIn: true,                       // not part of "all chats"; a watch must name one of its chats
  textLimit: 3000, todoLimit: 1500,  // characters of one message a reader is shown
  connected: (ctx) => true,          // is anything set up to collect from it?
  collects: (ctx, ref, db) => true,  // is this chat still being collected? (shown in the list of chats)
  fetchMedia: async (ctx, { row, dest, id }) => { … },  // save a message's file to dest
},
```

| Key | Purpose |
|---|---|
| `id`, `label` | Required. The id is a short lowercase word (letters and digits, 2 to 16). It is the prefix of every chat and sender ref you write (`sms:…`) and the value of `--source`. One plugin per id. |
| `optIn` | `true` keeps the source out of "all chats": a watch reads it only when it names one of its chats. |
| `textLimit`, `todoLimit` | Characters of one message shown to a watch's reader (default 400) and to the to-do reader (default 500). |
| `todoText`, `todoQuestion` | What the to-do watch calls the source when it says what it covers (`'kept email'`), and the question `bc watch setup` asks about including it. |
| `connected`, `collects` | Whether anything is set up to collect; whether a given chat is still being collected. Must not be async. |
| `fetchMedia` | Fetch a message's file on demand, for `bc msg media`, the reading of files as they arrive, and watches that read documents. |

Write with `openArchiveForWriting()` and `archiveStatements(db)` from the API, which give you prepared statements for chats, contacts and messages. `messageRow` and `mediaRow` build the rows.

A chat that is blackcat itself (its bot, as the owner's account sees it) is never collected, or the agent would react to its own replies. `archiveStatements` leaves such chats out. Call `ownRefs()` so that your setup does not offer them.

## Channels

A channel carries the conversation between the owner and the agent. It passes what the owner writes or taps to blackcat and sends what blackcat gives it. `plugins/tg-bot` is the bundled one. The terminal (`bc chat`) is built into the core on the same interface.

One channel is in use at a time, and the terminal is always available beside it. `bc channel` lists and switches channels. For the `ui` API that other plugins use to show things in the chat, see [Chat](#chat).

### A minimal channel

This channel appends what blackcat sends to `out.jsonl` and reads what the owner writes from `in.jsonl`. It is a shortened `test/support/file-channel.js`.

```js
import fs from 'node:fs';
import path from 'node:path';

const carrier = (ctx) => {
  fs.mkdirSync(ctx.dataDir, { recursive: true });
  let n = 0;
  return {
    label: 'File',
    can: { maxChars: 500 },
    send: async (chat, m) => { fs.appendFileSync(path.join(ctx.dataDir, 'out.jsonl'), JSON.stringify({ chat, ...m }) + '\n'); return ++n; },
  };
};

export default {
  api: 1, name: 'filechan', title: 'File channel', description: 'a channel made of two files',
  commands: {
    pair: { summary: 'pair it', access: 'owner', run: (ctx) => { ctx.config.set({ owner: { chat: 'me', name: 'Ana' } }); return 'paired'; } },
  },
  channel: {
    label: 'File',
    paired: (ctx) => !!ctx.config.get().owner,
    open: async (ctx) => carrier(ctx),
    start: async (ctx, host) => {
      let read = 0, timer, done;
      const poll = async () => {
        let lines = [];
        try { lines = fs.readFileSync(path.join(ctx.dataDir, 'in.jsonl'), 'utf8').split('\n').filter(Boolean); } catch {}
        for (const line of lines.slice(read)) {
          const ev = JSON.parse(line);
          read++;
          if (ev.from !== ctx.config.get().owner.chat) continue;   // only the owner gets through
          await host.incoming({ chat: ev.from, who: 'Ana', ref: read, text: ev.text });
        }
      };
      return {
        ...carrier(ctx),
        run: () => new Promise((resolve) => { done = resolve; timer = setInterval(poll, 40); }),
        stop: () => { clearInterval(timer); done?.(); },
      };
    },
  },
};
```

### The `channel` manifest key

| Member | Arguments | Returns | When it is called |
|---|---|---|---|
| `label` | | string | Shown by `bc channel`. |
| `can` | | object | Optional. What the service can do, as on the carrier. |
| `paired` | `(ctx)` | boolean, not a promise | When the core needs to know whether the channel is set up and linked to the owner. Required. |
| `open` | `(ctx)` | promise of a carrier | In a command or scheduled job that has something to send. Required. |
| `start` | `(ctx, host)` | promise of a carrier with `run()` and `stop()` | When the agent service starts with this channel in use. `run()` resolves when the channel stops. Required. |
| `self` | `(ctx)` | array of chat refs, such as `['tg:12345']` | Optional. The chats that are blackcat itself, as a source plugin sees them. |

### The carrier

The carrier is the object that talks to the service. Only `send` is required.

| Member | Arguments | Notes |
|---|---|---|
| `label` | | A string. |
| `can` | | `{ buttons, edit, html, files, voice, maxChars, maxFileBytes }`. Defaults: no buttons, editing or HTML, and `maxChars: 4000`. |
| `send` | `(chat, { text, html, actions, preview })` | Returns a reference to the message. `actions` is rows of `{ label, id }`, or `null`. |
| `edit` | `(chat, ref, message)` | Called only when `can.edit` is set. |
| `setActions` | `(chat, ref, rows \| null)` | Called only when `can.buttons` and `can.edit` are set. |
| `remove` | `(chat, ref)` | Deletes a message. Without it, `ui.remove` throws. |
| `toast` | `(event, text)` | Acknowledges a tap. `event` is what you passed to `host.action`. |
| `working` | `(chat, kind)` | `kind` is `'typing'`, `'file'` or `'photo'`. |
| `sendFile` | `(chat, path, { caption })` | The core has checked that the file may be sent and fits `maxFileBytes`. |
| `setMenu` | `([{ command, description }])` | Sets the service's own command menu. |

The core adapts to `can`, as described under [Chat](#chat). `send` is never given more than `maxChars`: a longer message arrives as several calls. Set `maxChars` to what the service really takes, or lower.

### The host

`start` receives `host`. Call it for everything the owner sends.

| Call | When |
|---|---|
| `host.incoming({ chat, who, ref, text, at })` | The owner wrote something. `at` (seconds) is when they wrote it, if your service says, so the record can show how long it took to reach blackcat. |
| `host.incoming({ chat, who, ref, text, files, errors })` | The owner sent files. Keep each with `keepFile()` from `src/api.js` and pass what it returns. `errors` are strings to show. |
| `host.incoming({ chat, who, ref, text, forwardedFrom })` | The owner forwarded a message. `forwardedFrom` is the sender's name. |
| `host.incoming({ chat, who, ref, unsupported: true })` | A kind of message you cannot pass on. |
| `host.action({ chat, who, id, ref, ...rest })` | The owner tapped a button. Add whatever `toast` needs, and `label` (the button's words) if you have it, for the activity record. |
| `host.log(text)` | Writes a line to the agent's log. |

### Rules for a channel

- Let only the paired owner, in a private conversation, reach `host`. The core does not check again. On a team service that means a direct message with the bot, never a shared room.
- Keep the owner in your settings as `owner: { chat, name }`. The core reads it without loading your plugin.
- Make pairing a terminal command (`access: 'owner'`, `interactive: true`), and call `useChannelIfNone(name)` from `src/api.js` when it succeeds.
- Store the token with `ctx.secrets`.
- Set `forwardedFrom` on every forwarded message. The core then never runs the text as a command or takes it as an answer to a setup question.
- Do not assume a type for a chat id. It is a number on Telegram and a string in the file channel.

When the owner switches channels (`bc channel use`, from a terminal only), plugins with an `ownerMoved` hook move what they hold to the new channel. Conversations are stored per channel.

### The terminal

`bc chat` uses `terminalCarrier` in `src/channels/terminal.js`, which sends text only. It runs beside the channel in use, has no pairing, and keeps its conversations apart. Scheduled messages go to the channel in use, never to an open terminal; with no channel in use, the `waiting` hook hands them over when `bc chat` starts.

### Where the channel code is

`src/channels/registry.js` resolves the channel in use, `desk.js` implements `ui` on the carrier, and `front.js` handles `host.incoming`. `test/channels.test.js` runs reminders, approvals, setup forms and watches through the file channel. Only the Telegram bot has run against a real service.

## Engines

An engine runs the model. It holds a conversation, passes each thing the model asks to do to blackcat, and reports what was used. `plugins/claude-code` is the bundled one.

An engine decides nothing about what the agent may do. The policy, approvals, the activity record and the conversation store are in the core. An engine can be stricter than blackcat, never looser. The owner tests an engine with `bc engine check` ([what it tests](architecture.md#the-engine-check)).

### A minimal engine

This engine repeats what it is sent. A line of the form `DO <Tool> <json>` makes it request a tool call, as a model would. It is a shortened `test/support/parrot-engine.js`.

```js
const usage = (model) => ({ ok: true, model, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, cost: null, data: {} });
let n = 0;

export default {
  api: 1, name: 'parrot', title: 'Parrot', description: 'an engine that repeats what it hears',
  engine: {
    label: 'Parrot',
    choices: () => ({
      models: [{ id: 'grey', label: 'Grey' }],
      options: [{ id: 'volume', label: 'How loud', values: ['soft', 'loud'] }],
      defaults: { chat: { model: 'grey' }, readers: { model: 'grey', options: { volume: 'soft' } } },
    }),
    ready: async () => ({ ok: true, detail: 'perched' }),
    converse: async (ctx, spec, on) => {
      const id = `parrot-${++n}`;
      let closed = false;
      queueMicrotask(() => on.ready());
      return {
        get closed() { return closed; },
        async send(text) {
          const m = /^DO (\w+) (.*)$/.exec(text);
          if (m) {
            const call = { id: `${id}-1`, tool: m[1], input: JSON.parse(m[2]) };
            on.toolUse(call);
            const d = await on.request({ tool: call.tool, input: call.input, toolUseId: call.id });
            // carry the call out here, and only if d.allow
            on.toolResult({ id: call.id, isError: !d.allow });
          }
          on.result({ text: `heard: ${text}`, isError: false, sessionId: id, usage: usage(spec.model) });
        },
        stop() { if (!closed) { closed = true; on.exit({ code: 0, stderr: '' }); } },
      };
    },
    ask: async (ctx, { content, model }) => ({ text: `read: ${JSON.stringify(content)}`, isError: false, usage: usage(model) }),
  },
};
```

### The `engine` manifest key

| Member | Arguments | Returns | When it is called |
|---|---|---|---|
| `label` | | string | Shown by `bc engine status`. |
| `choices` | `(ctx)` | `{ models, options, defaults }`, not a promise | When the core lists or resolves what can be chosen. Required. |
| `ready` | `(ctx)` | promise of `{ ok, why, detail }` | By `bc engine status` and `bc selftest`: is the engine installed and signed in? Required. |
| `converse` | `(ctx, spec, on)` | promise of `{ send(text), stop(), closed }` | When a chat conversation starts or resumes. Required. |
| `ask` | `(ctx, { system, content, model, options, schema })` | promise of `{ text, isError, usage }` | For each reader call: one question, no tools. `content` is a string or a list of content blocks. Required. |
| `has` | `(ctx, sessionId, workdir)` | promise of boolean | Optional. Before `/resume`: does the engine still hold that conversation? |
| `forget` | `(ctx, workdir)` | promise | Optional. After a check, to discard what the engine kept for the temporary folder. |
| `ownResult` | `(ctx, workdir, file)` | promise of boolean | Optional. During a check: is this a file the engine wrote to hold a command's result? |
| `where` | `(ctx)` | string | Optional. Where the model is hosted, for `bc engine status` and the check report. |
| `takes` | `()` | array, not a promise | Optional. The kinds of file the model can be given: `['pictures', 'documents']`. See [Reading files](#reading-files). |
| `process` | | string | Optional. The name of the engine's processes, so `bc status` can count the conversations held. |
| `shapes` | | boolean | Optional. Set it if `ask` can hold an answer to a JSON schema; `ask` then receives `schema`. Otherwise the core appends the schema to `system`. |

`choices` returns:

| Field | Shape |
|---|---|
| `models` | `[{ id, label, hint }]`. A convenience list. The owner may type any model name. |
| `options` | `[{ id, label, values, roles }]`. `values` are names or `{ value, label, hint }`. `roles` limits an option to `['chat']` or `['readers']`. |
| `defaults` | `{ chat: { model, options }, readers: { model, options } }`. Used until the owner chooses. |

#### `spec`

| Field | Meaning |
|---|---|
| `workdir` | The agent's folder. Start the model there. |
| `tools` | The tools the model may be offered: `Bash`, `Read`, `Glob`, `Grep`. Offer fewer if you like, never more. `Bash` is for `blackcat` commands only; the policy refuses anything else. |
| `readDirs` | Folders outside `workdir` that the agent may read. |
| `resume` | The `sessionId` of one of your own conversations to continue, or undefined. |
| `model`, `options` | What the owner chose, with your defaults for the rest. |
| `instructions` | `{ rules, generated, memory }`, three pieces of text. Give the model all three, in that order. Do not rely on the engine finding a file. |
| `env` | Extra environment variables for the engine's process. |
| `serve` | blackcat's tool server. See [Whose tools](#whose-tools). |

#### `on`

| Callback | Call it when |
|---|---|
| `on.ready()` | The conversation has started. |
| `on.toolUse({ id, tool, input })` | The model asks for something to be done. |
| `on.request({ tool, input, toolUseId })` | Before you carry out a call. Returns a promise of `{ allow, message }`: the policy's answer, and the owner's where the policy asks. |
| `on.toolResult({ id, isError })` | The call was carried out or refused. |
| `on.result({ text, isError, sessionId, usage, running })` | The turn is over. |
| `on.error(err)` | The engine could not start. |
| `on.exit({ code, stderr })` | The engine's process has gone. |

`usage` is `{ ok, model, tokensIn, tokensOut, cacheRead, cacheWrite, cost, data }`. Set `cost` to `null` when the model reports no price.

### Whose tools

A tool call can reach the policy in two ways.

- Served tools. Start the engine with no tools of its own and give it `spec.serve`, which is `{ name, tools, handle(message) }`. It speaks the Model Context Protocol over JSON-RPC (`initialize`, `tools/list`, `tools/call`). Pass each message the engine sends to `serve.handle` and send the answer back. blackcat judges each call and carries it out itself. A new engine must work this way.
- Ask first. The engine keeps its own tools and calls `on.toolUse`, `on.request` and `on.toolResult` around each use. Use this only when the engine can be made to ask about every call, and `bc engine check` shows that it does.

Claude Code does both, chosen with its `tools` option. [architecture.md](architecture.md#how-a-message-is-answered) describes the three values and what each costs.

### Rules for an engine

- Do nothing for the model that `on.request` or `serve.handle` has not allowed.
- Give `ask` no tools. Readers go through text written by other people.
- Leave the engine's extras (web access, connectors, sub-agents, its own memory) off.
- Keep a key for a hosted model in `ctx.secrets`. If you pass it to the engine's process, the agent could come to see it, so it should be good for that model and nothing else.
- Keep everything that knows the engine's arguments, message format and storage inside your plugin.

The core handles the rest. The chat and the readers each have their own engine, model and options (`engine.chat` and `engine.readers` in the settings). The agent cannot run `bc engine use`, `check` or `accept`. The engine in use cannot be disabled. A conversation held by another engine is never passed as `spec.resume`. A turn is stopped after five minutes.

### Limits of engines

- Only Claude Code and the test engines have run.
- The tool server has one transport, Claude Code's pipe. An engine that needs a socket or a helper process must build that around `serve.handle`.
- Commands that blackcat carries out itself (served tools) are not sandboxed.

The core side is in `src/agent/policy.js` (every call), `src/agent/brain.js` (conversations and `on.request`), `src/agent/oneshot.js` (readers), `src/tools/` (the tool server) and `src/engines/registry.js` (roles and `TOOLS`).

### Trials: requests for the engine check

Any plugin, not only an engine, can supply these. `bc engine check` gives the model requests the owner might make and looks at which commands it asks to run. Each plugin supplies requests for its own commands:

```js
trials: [
  { say: 'what reminders do i have', expect: /blackcat remind list\b/ },
  { say: 'whats 17 times 23', never: /./ },            // nothing to look up: no command at all
],
// or a function, for requests that apply only once the plugin is set up:
trials: (ctx) => (Object.keys(hosts(ctx)).length ? [{ say: `how much disk is free on ${first}`, expect: … }] : []),
```

`expect` is a pattern on a command line the agent should ask to run; `never` is one it must not. The check runs in a copy with none of your plugin's secrets, so a request is judged by what was asked for, not by whether it worked. Decide "set up" the same way your `agent.fill` does.

A plugin with a [reader](#readers) can have it asked too, with its real instructions and a made-up input, and judge the answer:

```js
readerTrials: () => [
  {
    say: 'a long exchange is put in one short clause',     // shown in the report
    job: 'summary',                                       // readers/summary.md, as ctx.reader('summary', …) uses it
    values: { max: 3 },                                   // optional, as there
    content: '…the made-up input, as your code would build it…',
    schema: SUMMARY,                                      // optional: the shape of the answer
    ok: (answer) => (answer.text.length <= 200 ? true : 'it ran on'),   // true, or what was wrong
  },
],
```

Write one for each mistake a model has made on your reader. `src/watch/checks.js` has examples.

## Guidelines

- Secrets go in `ctx.secrets`, never in `config`, output or logs.
- Never build a shell command from input. Use `ctx.exec(program, [args])`.
- A command must end on its own: no `tail -f`, and set timeouts on network calls.
- Return the outcome, including failures, in words a person can act on.

## Limitations

- The agent's only way to act is a `blackcat` command. A plugin cannot offer it a tool of another kind, so a generic MCP plugin is not possible.
- There are no version ranges: `api: 1` is all that is checked.

## Checklist

Before sharing a plugin:

1. `bc plugin info <name>` shows every command with the access level you intend.
2. `bc <name> --help` reads well.
3. Each form command works in the terminal, with options, and in `/setup`. On a second run of `setup`, every question offers the current value and a saved secret can be kept.
4. The commands use the standard words. See [Naming](#naming). For a bundled plugin, run `npm run docs:commands` after changing its commands: `docs/commands.md` is made from them, and a test compares the two.
5. With the plugin enabled, ask the agent to use it. Then ask for something it should not be able to do (an `owner` command, a change to something read-only) and check that it is refused.
6. No command gives the agent more than it needs: large results can be narrowed.
