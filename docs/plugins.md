# Plugins

A plugin adds an ability to blackcat: a system to read or act on, a source of messages, a scheduled check. It is a folder containing `plugin.js`, whose default export is a manifest. From the manifest blackcat builds the command-line commands, the agent's permissions and instructions, setup in the terminal and the chat, scheduled jobs and the status line.

```
plugins/<name>/plugin.js        bundled with blackcat
user-plugins/<name>/plugin.js   your own (git-ignored)
```

> A plugin runs as you, with everything your user can do. Only enable plugins you have read. blackcat asks you to confirm this for anything outside `plugins/`.

## Quick start

```sh
bc plugin new plex        # writes user-plugins/plex/plugin.js from a commented, working template
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
| `plugins/host/` | the smallest complete one: a read command, a setup form, a job, per-use access |
| `plugins/ssh/` | per-command access decisions, secrets, a folder of keys, `storage` |
| `plugins/calendar/` | fetching on a schedule into a local copy; dated items for the briefing (`agenda`) |
| `plugins/mail/` | a message source, with attachments fetched on demand |
| `plugins/wa/`, `plugins/tg/` | a background service that collects messages; interactive linking; `tg` mounts its commands under a group (`bc tg account …`) |
| `plugins/tg-bot/` | a channel |
| `plugins/voice/` | a chat hook (a voice note becomes words: the owner's own, and those in a watch's chats); a helper process |
| `plugins/shortcut/` | commands the owner defines; chat menu entries added at run time |

Two core parts are also written with a manifest: `src/reminders/` and `src/watch/` show messages with buttons, chat commands, per-tick work, and a form built from what other plugins offer.

Bundled plugins with `default: true` are on unless disabled: `claude-code`, `shortcut`, `tg`, `tg-bot`, `voice`, `wa`. `default` is ignored in `user-plugins/`. The core parts `backup`, `check`, `remind` and `watch` can also be disabled. `bc msg …` (the message archive) is a core part, available whenever there are messages to search.

## Rules

`test/rules.test.js` and `test/plugin-api.test.js` enforce these.

1. The core imports no plugin. blackcat runs with every plugin disabled.
2. No plugin imports another. Use another plugin through its commands (`ctx.command`). Offer something to all plugins by declaring it in the manifest (`names`, `agenda`, `storage`).
3. A plugin uses the core only through `src/api.js`. Bundled plugins import it (`import { … } from '../../src/api.js'`). Plugins outside the repository use `ctx.api`, which has the same functions.
4. A plugin reaches only its own data: its settings, secrets, store and folder, from `ctx` or from `settingsFor(import.meta.url)` and `ownDataDir(import.meta.url)`. The API gives no access to another plugin's data, the whole settings file, blackcat's database, the agent's standing permissions or the data folder itself. Plugins may not import `src/internal.js`.
5. Only a channel plugin talks to a chat service. Everything else uses the neutral `ui`.

[API reference](#api-reference) lists what `src/api.js` offers.

These rules are not a sandbox. A plugin runs in the same process and can open any file you can. The protection is that you choose what runs, and that the agent cannot enable, add or edit a plugin.

## Manifest

`api`, `name`, `title`, `description` and `commands` are required.

| Key | Purpose |
|---|---|
| `api` | Plugin API version. Must be `1`. |
| `name` | Lowercase letters, digits and dashes; 2 to 21 characters. Must equal the folder name. Becomes `bc <name> …`. |
| `title` | Display name. |
| `description` | One line, no full stop. |
| `commands` | See [Commands](#commands). |
| `mount` | Put the commands under a group: a plugin named `plex-music` with `mount: 'plex music'` gives `bc plex music …`. One or two words, and the first must be the plugin's name or the part of it before a dash. See [Names](#names). |
| `help` | Text shown at the end of `bc <name> --help`. |
| `default` | `true`: on without being enabled. Bundled plugins only. |
| `uses` | Plugins whose commands you call. See [Calling another plugin](#calling-another-plugin). |
| `jobs` | See [Jobs](#jobs). |
| `services` | See [Services](#services). |
| `chat` | See [Chat](#chat). |
| `channel` | See [Channels](#channels). |
| `engine`, `checks` | See [Engines](#engines). |
| `agent` | See [Agent notes](#agent-notes). |
| `source` | See [Message sources](#message-sources). |
| `storage` | See [Storage](#storage). |
| `privateData` | Names of private data: a login folder at the top of the data folder, or a database (`['plex-account']`). The agent is kept from them by name, whether the plugin is on or off. |
| `aliases` | `(ctx) => [{ name: 'movie', command: 'play', input: { what: 'the usual' }, usage: '[room]' }]` adds top-level words: `bc movie`, `bc movie kitchen`. Arguments named in `usage` are added to `input`. |
| `status` | `(ctx) => 'text'`: one line for `bc status`. May be async. |
| `settings` | `(ctx) => ({ … })`: what `bc <name> settings` shows. |
| `names`, `agenda`, `briefing`, `waiting`, `inboxKeeps`, `ownerMoved`, `nudgeDone`, `selftest` | See [Core hooks](#core-hooks). |

Every key is checked at load. An unknown key or a wrong type is reported with the nearest known key, the plugin is skipped, and `bc plugin list` shows why.

Functions may be async except these, whose result is used immediately: `aliases`, `names`, `nudgeDone`, `agent.fill`, `agent.readDirs`, `channel.paired`, `channel.self`, `storage.places`, `source.connected`, `source.collects`, and a job's `when`.

A hook that throws fails only that command, job or set of notes.

### Names

Names are first come, first served, and blackcat's own come first. Your plugin is not loaded, and `bc plugin list` and `bc selftest` report why, if:

- Its folder has the name of a bundled plugin or a core part (`ssh`, `backup`). These cannot be overridden: settings, secrets and the private folder go by name. Copy the plugin under a new name instead.
- Its `mount` does not begin with its own name, or the part before a dash (`tg-notes` may use `tg notes`).
- Its mount equals, contains or sits inside another plugin's (`tg` alone would cover `tg account`).
- Its title, a service id, a chat command or a source id is already taken.

Where the first answer wins (a name for an address, the words of a voice note), bundled plugins are asked before yours. Disable the bundled one to have yours used.

When the agent asks to run a non-bundled plugin's command, the approval says so: `Weather (your plugin "weather")`.

## Commands

Each entry in `commands` becomes `bc <plugin> <command>` and is what the agent runs.

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
| `working` | With a `form`: text shown while `run` executes (`'Signing in…'`). |
| `raw` | The arguments are free text, kept exactly as typed. `input._` is the list of words; no options are parsed. See `ssh run`. |
| `interactive` | The command drives the terminal itself, for example to show a QR code and wait. It runs only in a terminal, never for the agent, and is not in `/setup`. |
| `hidden` | Left out of help, chat menus and the agent's instructions. For a service's `run`. |
| `long` | It takes minutes. Typed in the chat, it runs beside the conversation, its result is sent when it ends, and it can be stopped with SIGTERM, so clean up. |
| `sends` | It fetches a file for the owner. Return `data.path` and `data.caption`. Typed in the chat (`/allsky now`), the file is sent with its caption. Save it in your media folder so it may be sent. |
| `untrusted` | `false` only when the output is your own measurements or settings. See [Output](#output). |

`form` cannot be combined with `raw` or `interactive`.

### Return values

`run` returns nothing, a string (printed as is), or `{ text, data }`: `text` for people, `data` (an object) for `--json`. Every command gets `--json`, and the agent always uses it. A command that prints its own output should honour `input.json`.

A list as `data` is printed as that list. It cannot carry the untrusted-content notice, so mark in each entry what other people wrote. `raw: true` in the result prints `data` exactly, for a result with its own notice.

Return the result; never `console.log` it or end the process. The same command is typed, run by the agent, shown in the chat and called by other plugins. If something you loaded keeps the process alive (a model's threads), return `end: true`. Core parts that build text line by line can use `saying()` from `src/util/saying.js`.

To stop with a message instead of a stack trace, call `ctx.fail('what went wrong and what to do')`.

### Standard commands

Every plugin gets two commands. Define one of the same name to replace it.

- `status`: how it is doing now. Your `status` line and your jobs.
- `settings`: how it is set up. What `ctx.config` holds, or what the manifest's `settings(ctx)` returns. Secrets are named, never shown.

A model name is a setting. "The model is loaded" is status.

### Naming

Use these words, only for these purposes. `test/conventions.test.js` holds bundled plugins to them.

| To | Call it | Notes |
|---|---|---|
| connect the one system a plugin talks to | `setup` | Run again to change anything. `bc plugin enable` points to it. |
| connect one of several | `add`, with `remove <name>` and `list` | SSH machines, mail accounts, calendars |
| link a personal account | `pair`, `unpair` | WhatsApp, Telegram |
| change preferences | `setup` | quiet hours, alert limits, which model |
| see one thing | `show <id>` | |
| look something up | `find <text>` | |
| fetch again from the origin | `sync` | |
| see whether a connection works | `test` | |
| succeed or fail, for a check (`bc check add … --run "blackcat <you> check"`) | `check` | its summary says "made for checks" |
| say how far back to look | `--since 6h`, `--since 7d` | never only `--hours` or `--days` |
| report health; report configuration | `status`; `settings` | built in; write your own only to add detail |
| disconnect for good | nothing | the owner runs `bc plugin disable <name> --data` |

Do not use `delete`, `rm`, `ls`, `configure`, `connect`, `login`, `disconnect`, `logout`, `refresh`, `update`, `info` or `ping`.

### Access levels

`access` says what the agent may do. The owner, in the terminal or `/setup`, can run everything.

| `access` | The agent |
|---|---|
| `'allow'` | runs it without asking. For commands that only read. |
| `'ask'` | needs the owner's Allow in the chat; the owner sees the exact command. For anything that changes something. |
| `'owner'` | can never run it. For setup, credentials, and changing what the agent may do. |
| `'never'` | can never run it. Use it for "this exists but is off". |

When the level depends on the arguments, `access` is a function of the words after the command name. It must have no side effects:

```js
access: (ctx, tokens) => {
  if (ctx.config.get().readOnly) return { level: 'never', reason: 'this library is read-only for you' };
  return { level: 'ask', describe: `delete "${tokens.join(' ')}" from Plex` };   // describe is shown in the prompt
},
```

Add `once: true` to an `ask` result for something to approve every time, such as unlocking a door. The prompt then offers no "Always allow".

Access is enforced twice: by the agent's policy before the command starts, and by the command when it sees the agent started it. The agent must run a plugin command as one plain command. Anything chained, piped or redirected is refused.

### Output

Text from an outside system (file contents, logs, API responses, other people's messages) can contain instructions aimed at the agent. With `--json`, results are labelled as untrusted data unless the command sets `untrusted: false`.

## Forms

A command with a `form` asks questions before it runs. It then works three ways:

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

| Type | Asks for | Notes |
|---|---|---|
| `text` | a line of text | `default`, `optional: true` |
| `secret` | a hidden line of text | Never echoed, logged or given as an option. In the chat the owner's message is deleted once read and never reaches the agent. `keep`: see below. |
| `select` | one of `options: [{ value, label, hint }]` | |
| `confirm` | yes or no | |
| `browse` | a folder, chosen by walking through folders | Supply `list: async (dir, answers, ctx) => [names]`, optionally `create: async (dir, answers, ctx)` and `start`. The person can enter a folder, go up, make one, or type a path. The folders can be anywhere: backup lists another machine's over SSH. |
| `note` | nothing | Shows `message`. |

Other question keys:

| Key | Purpose |
|---|---|
| `message`, `default`, `options` | A value, or a function of `(answers, ctx)`. |
| `when: (answers) => boolean` | Skips the question when false. |
| `validate: (value, answers, ctx)` | Returns a problem as text, or nothing. |
| `help` | What `--help` says of the option, when the question would not read well there. |
| `sticky: true` | Given as an option, it is set. Left out, away from a terminal, it keeps its current value. For rarely changed answers, such as an engine's options. |

`form` may be a function returning the steps. It is called once every plugin has loaded, for a form that depends on what other plugins offer.

### Running setup again

Setup is also how settings are changed.

Give `default` as a function of what is saved, never a fixed value. In the terminal the question is prefilled and Enter keeps it. In the chat it is one tap, and the current choice is marked ✓.

Add `keep: true` to a `secret` question whose answer you store with `ctx.secrets.set(<its id>, …)`. When one is saved, the question says so and an empty answer keeps it (in the chat, a "Keep the saved one" button). `run` then receives `''` and must leave the saved secret alone. Away from a terminal it is kept without asking, so `bc plex setup --url http://new-address` works with no token. For a secret stored another way, such as one per account, `keep: (answers, ctx) => boolean` reports whether one is saved.

## Context

Every hook receives `ctx`.

| Member | Purpose |
|---|---|
| `ctx.config.get()` / `.set(patch)` | Your settings, in `config.json` under your plugin's name. Not for secrets. |
| `ctx.secrets.get(k)` / `.set(k, v)` / `.delete(k)` / `.has(k)` / `.names()` | Tokens, passwords, keys. Stored in `data/plugins/<name>/`, which the agent can never read. |
| `ctx.store.get(k)` / `.set(k, v)` / `.delete(k)` / `.keys()` / `.update(k, fn)` | State that changes with use: what you last fetched, where you got to. Any JSON value under a key, in blackcat's database, private to your plugin. `update` is atomic. |
| `ctx.dataDir` | A private folder for files (keys, a database of your own). |
| `ctx.command(plugin, command, input)` | Run a command of a plugin in `uses`. Returns `{ text, data }`. |
| `ctx.exec(cmd, args, { timeoutMs, input })` | Run a program without a shell. Never throws. Returns `{ code, stdout, stderr, timedOut }`. |
| `ctx.notify(text)` | Message the owner on the channel in use. For jobs and alerts. Returns true if sent. |
| `ctx.log(msg)` | Write to the service log (`bc logs`). Never log secrets. |
| `ctx.ask(system, input, { model })` | Ask a model one question with no tools. Returns text. |
| `ctx.reader(job, { values, input, schema, also })` | Ask a reader defined in `readers/<job>.md`. `also` is text added after the file's instructions. See [Readers](#readers). |
| `ctx.fail(msg)` | Stop with a message for the person. |
| `ctx.plugin` | Your plugin's name. |
| `ctx.caller` | `'owner'`, `'agent'` or `'job'`. |
| `ctx.surface` | `'terminal'`, `'chat'` or `'job'`: where the result is read. `'chat'` is the owner's chat on any channel. |
| `ctx.api` | Everything in `src/api.js`: `ctx.api.shell(…)`, `ctx.api.ymd()`. |

`data/<name>-media/` is the one folder of yours the agent may read and send files from, and only if you declare it with `agent: { readDirs: () => [that folder] }`. Nothing else under `data/` can be opened to the agent.

## Storing data

Settings go in `ctx.config`, secrets in `ctx.secrets`, files in `ctx.dataDir`, and state that changes with use in `ctx.store`:

```js
const last = ctx.store.get('rooms');                 // undefined the first time
ctx.store.set('rooms', { at: Date.now(), rooms });   // any JSON value
ctx.store.update('fetches', (n) => (n ?? 0) + 1);    // two processes at once lose nothing
```

Do not keep such state in a JSON file of your own: a file written in place can be left half-written, and one of two concurrent writers loses.

Do not keep it in `ctx.config` either: every write to the settings file tells the rest of blackcat that settings changed. `ctx.config.set` with nothing changed writes nothing.

`ctx.secrets` is written atomically. A damaged file fails with a message instead of reading as empty.

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
- `withDb` closes the database whatever happens, including in async code. Always use it: a test fails for code that opens a database into a variable and closes it by hand. A service that keeps one open while it runs is the exception, and is listed in that test.
- Put the database in `ctx.dataDir`, or `ownDataDir(import.meta.url)` where there is no `ctx`.

### Code without `ctx`

A helper module that has no `ctx`, such as a service's settings reader, is identified by its file location:

```js
import { dataPath, ownDataDir, settingsChangedAt, settingsFor } from '../../src/api.js';

const mine = settingsFor(import.meta.url);        // mine.get(), mine.set({ … }): this plugin's settings only
const dir = ownDataDir(import.meta.url);          // the same folder as ctx.dataDir
const login = dataPath('sms-account');            // a folder of yours at the top of the data folder
const media = dataPath('sms-media');              // the one you open to the agent (agent.readDirs)
if (settingsChangedAt() > seen) reread();         // for a service: reread settings only when one changed
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
| `names: (ctx, address) => 'Priya Nair'` | a plugin calls `ctx.api.nameOf(address)` or `personLabel({ name, email })` | a name you know for the address |
| `agenda: (ctx, { from, to }) => [...]` | the briefing is built | dated items, copied onto "Things I need to do": `{ id, source, title, start, end, allDay, day, lastDay, location, from }`. `from` is the organiser. |
| `briefing: (ctx) => ({ problems: ['html'], fine: 'html' })` | the daily briefing is built | what is wrong, and a line for when all is well |
| `waiting: async (ctx) => ({ heading, lines: [{ text, note }] })` | the owner opens the terminal chat and no channel is in use | what you could not send, such as reminders that came due, or `null`. Handed over once. |
| `inboxKeeps: async (ctx) => [paths]` | files the owner sent are tidied (kept a month) | the ones you still need |
| `ownerMoved: async (ctx, { from, to }) => n` | another channel is put in use | move what you were going to send; return how many |
| `nudgeDone: (ctx, { db, itemId }) => {}` | the owner marks done a nudge you set | update your item |
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

A probe only reads. It never changes, sends, fetches to keep, or runs something the owner defined. Return `{ skip: 'why' }` when there is nothing to test, such as an unlinked account; that is not a failure. A probe fails after 30 seconds without an answer; `timeoutMs` on the probe changes that.

### Nudges

A core part that wants a reminder about one of its items sets a nudge through `src/reminders/nudges.js` (`setNudgeFor`, `cancelNudges`, `settleNudges`), tied to the item's id. It never writes the reminders table, and reminders never write its tables. `nudgeDone` is the callback.

### Error messages

`explainErrors((e) => 'a sentence' | null)` supplies your wording for an error blackcat would otherwise show raw, such as a chat service's numeric error.

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

Each job run is a separate process (`blackcat plugin job <plugin> <id>`) started by the agent service, so a job that crashes or hangs cannot take the agent down.

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
| `every`, `at` | Shorthand for `cron`: `every: '15m'`, `at: ['08:00']`. |
| `summary` | One line. |
| `when: (ctx) => boolean` | Skips the job while there is nothing for it to do. |

`bc <plugin> status` shows each schedule in words with its next run. A job that was due while blackcat was off runs once when it comes back. To avoid repeating an alert, store what you last reported.

For schedules of your own, such as one the owner sets, the API has `schedule()` to check one, `describeSchedule()` to put it in words, `nextRuns()`, `scheduleDue(cron, lastTs)`, and `fromTimes()` and `fromEvery()` to turn times of day or an interval into cron.

What a job returns goes into the activity record (`bc activity recent`):

| Return | Recorded as |
|---|---|
| `{ idle: true }` | nothing to do: counted, not listed |
| `{ did: 'what happened' }` or a string | an entry |
| throws | failed |

Add other entries with `ctx.api.recordActivity({ kind: 'event', category: '<your plugin>', summary: '…' })`. A `ctx.ask` call is recorded for you, with its tokens, under `plugin: <name>`. Never put message content in an entry.

## Services

For something that must stay connected, such as a source, declare a service. blackcat's supervisor starts it when it is ready, restarts it if it dies, and stops it: `bc restart slack`, `bc logs slack`, a row in `bc status`.

```js
services: [{
  id: 'slack',                               // the service name
  summary: 'Slack source (read-only)',
  command: 'run',                            // one of your commands; it should not return
  ready: (ctx) => (ctx.secrets.has('token') ? null : 'not connected → bc slack setup'),
  health: (ctx) => null,                     // optional: a problem only you can see ("logged out"), or null
}],
```

`ready` returns why the service cannot start yet, or `null`. Every two minutes blackcat checks that a service that is switched on and ready is running, and calls `health`. The owner is told once when a problem appears and once when it is gone.

In the command, exit with code 3 for "needs the owner" (logged out, not set up). The service is then not restarted.

When the service is connected and working, call `serviceConnected()` from the API; after a dropped connection comes back, `serviceConnected({ offlineMs })`. The activity record then shows how long it took to start and how long it was cut off.

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
| `commands` | Added to `/help` and the channel's menu. May be `(ctx) => [{ command, description }]` when the list depends on settings, as in the shortcut plugin. After changing what it returns, call `refreshMenu()` from the API. |
| `install` | Called once when the agent service starts. Register handlers here. |
| `tick` | Called every 20 seconds inside the agent service, so it must return quickly. `ui` is `null` with no channel in use. |
| `quick` | Offered every message, typed or transcribed, before the agent. Return `null` unless you are certain what is meant. `{ text, note }` answers directly; `note` goes to the agent with the owner's next message. `{ confirm: 'Really?', run: async () => ({ text, note }) }` asks first. |
| `voice` | `async (file, { ctx }) => ({ text, seconds, took } \| { error })`: turns a voice note into words. The first enabled plugin that has it is used. It is called for the owner's own voice notes, and by watches for voice notes and audio files in their chats (then outside the agent's process: give a `stop` hook if you keep a helper running, and it is called when the look is over). |
| `stop` | `() => {}`: called when the agent service stops, to end a helper process. |

Code in `install` and `tick` can message the owner. The agent cannot reach it. Only the owner's messages and taps reach your handlers.

Nothing here names a chat service. On Telegram, `actions()` are buttons. On a channel without buttons they are listed with numbers and the owner answers with a number. Formatting is a subset of HTML (`<b> <i> <u> <s> <code> <pre> <a href> <blockquote>`), stripped for plain-text channels. A channel that cannot edit a message sends the new version as a new message.

Keep an action id under 64 bytes and start it with your plugin's name (`plex:…`): all plugins share one id space.

`ui`:

| Member | Purpose |
|---|---|
| `ui.command(name, (c, next) => …)` | The owner typed `/name`. Several handlers may answer one name; `next()` passes it on. |
| `ui.action(pattern, (c) => …)` | The owner tapped a button whose id matches a string or regular expression. |
| `ui.text((c, next) => …)` | Any other text, before the agent. Call `next()` unless it is yours. |
| `ui.send(chat, text, opts)` | Send unprompted. Returns a reference for `ui.edit(chat, ref, text, opts)`, `ui.setActions(chat, ref, actions \| null)` and `ui.remove(chat, ref)`. Text longer than the channel takes is sent as several messages, cut at line ends, with the actions under the last (whose reference is returned); formatted text that long goes as plain text, so keep a formatted message under the limit yourself. |
| `ui.sendFile(chat, path, { caption })` | Send a file from a folder the agent may read. Returns false if it may not be sent. |
| `opts` | `{ html: true, actions: actions().add(label, id).row()…, preview: false, what: 'the weekly report' }`. `what` is a few words for the activity record when you send something by yourself from `tick`; never the text itself. `dueTs` (seconds) is when it was meant to go, so the record can say how late it was. The record also keeps how long the send took and why it failed. |

`c`, passed to a handler:

| Member | Purpose |
|---|---|
| `c.chat`, `c.who`, `c.text`, `c.args`, `c.match` | Where, who, what was written or tapped. `c.args` follows the command; `c.match` is the pattern match. |
| `c.reply(text, opts)` | Answer. Returns a reference. |
| `c.edit(text, opts)`, `c.setActions(a)`, `c.clearActions()` | Change the message whose button was tapped. |
| `c.toast(text)` | Acknowledge a tap. If you do not, blackcat does. |
| `c.gone(text)` | The same, when what the button was about no longer exists. The activity record marks the tap as having done nothing. |
| `c.working()`, `c.remove()`, `c.sendFile(path, caption)` | Show "typing…"; delete the owner's message (a secret); send a file. |

`s`, passed to `tick`:

| Member | Purpose |
|---|---|
| `s.ctx` | Your `ctx`. |
| `s.now`, `s.nowMs` | The time. |
| `s.chat` | The owner's chat on the channel in use: `ui.send(s.chat, …)`. |
| `s.last(key)`, `s.mark(key, value)` | Small persistent markers ("when did this last run?"). |
| `s.once(name, fn)` | Run `fn` unless the previous run under that name is still going. |
| `s.runJob(args)` | Run `blackcat <args…>` as a separate low-priority process and return what it printed. For anything slow. Ask for `--json`: log lines of that process are kept apart from what it prints. |

## Agent notes

While your plugin is enabled, the agent's instructions include a section generated from the manifest: the description, each command with its access level, and your notes. Use the notes for what a command list cannot say: when to use the plugin, how to phrase arguments, what to check first.

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

Text before the first marker is always included. A plugin with nothing to fill in needs no `fill`. A placeholder with no value is an error: the notes are left out and the log says why. Keep sentences whole in the file; supply names and lists, not fragments of prose.

Two more keys under `agent`:

- `readDirs: (ctx) => [folders]` opens folders to the agent: it may read files there, and the chat may send them to the owner. For files your plugin fetches. Inside the data folder only `data/<name>-media/` is honoured.
- `listCommands: false` leaves your commands out of the agent's instructions; the notes then say everything. Sources use this, because the agent reads their messages through `bc msg …`.

## Readers

When a model must read text written by other people (to classify messages or summarise a page), do not hand that text to the agent. Ask a reader: a model with no tools, so nothing in the text can cause an action.

Describe what the reader looks for in `readers/<job>.md` beside `plugin.js`, and give the shape of the answer in code:

```js
const ANSWER = { type: 'object', additionalProperties: false, required: ['urgent', 'why'],
  properties: { urgent: { type: 'boolean', description: 'Whether it needs the owner today.' }, why: { type: 'string', description: 'One short sentence.' } } };

const found = await ctx.reader('urgent', { values: { who: 'the school' }, input: text, schema: ANSWER });
if (found.urgent) await ctx.notify(found.why);
```

- The file says what to look for and how to decide, with `{{placeholders}}` and `<!-- when: name -->` as in `agent.md`. It says nothing about the answer format.
- blackcat first tells every reader that what it reads is data, never instructions. Editing your file cannot remove that.
- `schema` is an object; put a list inside one (`{ items: [...] }`). Describe each field in its `description`, which the model sees. The engine holds the model to the schema, blackcat checks the answer, asks once more if it does not fit, then throws.
- Without `schema` the answer is text.
- The owner can override your file with `data/readers/<your plugin>/<job>.md`.

`ctx.ask(system, input)` is for a one-off question with no file. It also has no tools, sends only what you give it, and returns text for you to check.

## API reference

Everything a plugin may import, from `src/api.js` (or `ctx.api` outside the repository). The file is short and commented; this is the map.

| For | Names |
|---|---|
| Your settings and folders without a `ctx` | `settingsFor`, `ownDataDir`, `dataPath`, `settingsChangedAt` |
| Time | `now`, `ymd`, `isoLocal`, `clock`, `hm`, `ago`, `agoShort`, `duration`, `sleep` |
| Reading a time a person wrote | `parseAt`, `parseDuration`, `parseTime`, `fmtWhen`, `TimeError` |
| Schedules (cron) | `schedule` (check one), `describeSchedule` (say it in words), `nextRuns`, `scheduleDue`, `fromTimes`, `fromEvery`, `storedSchedule`, `ScheduleError` |
| Text and sizes | `size`, `esc`, `errMsg`, `chunks`, `plain`, `explainErrors` |
| Paths a person wrote | `expandHome`, `resolveHome` |
| Running programs | `shell`, and `ctx.exec`. `classify` says whether a shell command only looks (`'read'`, `'sensitive'`, `'change'`); `touchesSecrets` says whether it would show blackcat's private files. |
| People | `nameOf`, `personLabel` |
| The chat | `actions`, `refreshMenu`, `chatCommands`, `directCommands`, `sendable`, `hasBot`, `notifyOwner` |
| Reading the archive | `openArchive`, `searchMessages`, `readThread`, `listChats`, `countChats`, `archiveStats`, `formatMessage`, `archiveMeta`, `sourceSql`, `QueryError`, `await semantic()` for search by meaning |
| Message files | `mediaPaths`, `downloadedPath`, `MEDIA_DIR`, `ARCHIVE_DB` |
| Writing the archive (a source) | `openArchiveForWriting`, `archiveStatements`, `messageRow`, `mediaRow`, `setArchiveMeta`, `ownRefs` |
| A database of your own | `openSqlite`, `upgrade`, `withDb`, `hasTable`, `hasColumn`, `addColumns` |
| A model with no tools | `askModel`; `ctx.ask` and `ctx.reader` are the same with your plugin's name on them |
| The activity record | `recordActivity({ kind: 'event', category, summary, ok, ms, data })`. Never put message content in one. A service calls `serviceConnected()` when it is connected, and `serviceConnected({ offlineMs })` when it is back after being cut off. |
| Services | `service`, `show`, `controlService` (start, stop or restart one through the supervisor), `isInstalled`, `await serviceCommands()` |
| Terminal questions | `await prompts()` |
| A channel plugin | `keepFile`, `INBOX_MAX_BYTES`, `runAgent`, `useChannelIfNone` |
| Logging | `log`; prefer `ctx.log`, which adds your plugin's name |

## Special kinds of plugin

Most plugins stop here. Three kinds add one more manifest key and take on a larger job: a [message source](#message-sources), a [channel](#channels) and an [engine](#engines).

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
| `id`, `label` | Required. The id is the prefix of every chat and sender ref you write (`sms:…`) and the value of `--source`. One plugin per id. |
| `optIn` | `true` keeps the source out of "all chats": a watch reads it only when it names one of its chats. |
| `textLimit`, `todoLimit` | Characters of one message shown to a watch's reader (default 400) and to the to-do reader (default 500). |
| `todoText`, `todoQuestion` | What the to-do watch calls the source when it says what it covers (`'kept email'`), and the question `bc watch setup` asks about including it. |
| `connected`, `collects` | Whether anything is set up to collect; whether a given chat is still being collected. Must not be async. |
| `fetchMedia` | Fetch a message's file on demand, for `bc msg media` and watches that read attachments. |

Write with `openArchiveForWriting()` and `archiveStatements(db)` from the API, which give you prepared statements for chats, contacts and messages; `messageRow` and `mediaRow` build the rows.

A source never collects a chat that is blackcat itself (its bot, as the owner's account sees it), because the agent would react to its own replies. `archiveStatements` leaves such chats out. Call `ownRefs()` so your setup does not offer them either.

A channel reports those chats with `channel.self`.

## Channels

A channel is a plugin that carries the conversation between you and the agent. It passes what you write or tap to blackcat and sends what blackcat gives it. `plugins/tg-bot` is the bundled one. The terminal (`bc chat`) is built into the core on the same interface.

One channel is in use at a time, with the terminal always available beside it. To list and switch channels: `bc channel`. For the `ui` API that other plugins use to show things in the chat, see [Chat](#chat).

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
| `paired` | `(ctx)` | boolean, not a promise | When the core needs to know if the channel is set up and linked to the owner. Required. |
| `open` | `(ctx)` | promise of a carrier | In a command or scheduled job that has something to send. Required. |
| `start` | `(ctx, host)` | promise of a carrier with `run()` and `stop()` | When the agent service starts with this channel in use. `run()` resolves when the channel stops. Required. |
| `self` | `(ctx)` | array of chat refs, such as `['tg:12345']` | Optional. Names the chats that are blackcat itself as a source plugin sees them. No source collects or offers them. |

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
| `native` | | Optional. The service's client, for plugins that still use `telegram: { install(bot) }`. |

The core adapts to `can`. Without buttons, actions are listed with numbers and the owner answers with a number. Without editing, the new version is sent as a new message. Without HTML, the tags are removed. `send` is never given more than `maxChars`: a longer message arrives as several calls. Set `maxChars` to what the service really takes, or below it.

### The host

`start` receives `host`. Call it for everything the owner sends.

| Call | When |
|---|---|
| `host.incoming({ chat, who, ref, text, at })` | The owner wrote something. `at` (seconds) is when they wrote it, if your service says: the record then shows how long it took to reach blackcat. |
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
- Only a channel plugin may import a chat service's library. `test/rules.test.js` enforces this.
- `bc channel use` and `bc channel off` refuse to run from a chat or as the agent.
- On a switch, plugins with an `ownerMoved` hook move what they hold for the owner (reminders, watches) to the new channel. The agent must be restarted.
- Conversations are stored under the channel they happened on. `/resume` lists that channel's only.

### The terminal

`bc chat` uses `terminalCarrier` in `src/channels/terminal.js`, which can send text and nothing else: bold and italics are shown where the terminal can, choices are numbered, and a message cannot be changed afterwards (so an approval's outcome is said on a line of its own). It differs from a plugin channel:

- It runs beside the channel in use and does not count as the one in use.
- It has no pairing, and its conversations are kept apart from the channel's.
- A blackcat command typed with a slash gets the terminal to itself, so commands that ask questions or draw a QR code work.
- Scheduled messages go to the channel in use, not to an open terminal. With no channel in use, reminders that came due are shown when `bc chat` starts.
- `bc chat <one question>` asks the agent and exits without the desk.

### Where the channel code is

| File | Role |
|---|---|
| `src/channels/registry.js` | Lists channels and resolves the one in use. `useChannel()`. |
| `src/channels/desk.js` | Routes text and taps to handlers. Implements `ui` on the carrier. |
| `src/channels/front.js` | `host.incoming`, the built-in commands, the path to the agent. |
| `src/channels/send.js` | `ctx.notify`, which opens the channel in use to send. |
| `src/agent/run.js` | The agent service. Starts the channel in use, or runs the scheduler alone until one is paired. |
| `plugins/tg-bot/` | `carrier.js` sends. `bot.js` receives and checks the paired accounts. |

`test/channels.test.js` runs reminders, approvals, setup forms and watches through the file channel. `test/bot.test.js` runs the agent against a stand-in for the Telegram Bot API, which refuses what the real one refuses (a message over 4,096 characters, a caption over 1,024).

### Limits of channels

- Only the Telegram bot has run against a real service.
- A chat id is whatever the channel uses: a number on Telegram, a string in the file channel. Do not assume a type.
- `ctx.surface` is `'chat'` on every channel.
- WhatsApp is a read-only source, not a channel.
- There is no web interface.

## Engines

An engine is a plugin that runs the model. It holds a conversation, passes each thing the model asks to do to blackcat, and reports what was used. `plugins/claude-code` is the bundled one.

An engine decides nothing about what the agent may do. The policy, approvals, the activity record and the conversation store are in the core and are the same for every engine. An engine can be stricter than blackcat, never looser.

To choose a model, run the check or change whose tools are used: `bc engine setup`, `bc engine check`. What the check tests is in [architecture.md](architecture.md#the-engine-check).

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
| `ready` | `(ctx)` | promise of `{ ok, why, detail }` | By `bc engine status` and `bc selftest`, to ask if the engine is installed and signed in. Required. |
| `converse` | `(ctx, spec, on)` | promise of `{ send(text), stop(), closed }` | When a chat conversation starts or resumes. Required. |
| `ask` | `(ctx, { system, content, model, options, schema })` | promise of `{ text, isError, usage }` | For each reader call: one question, no tools. `content` is a string or a list of content blocks. Required. |
| `has` | `(ctx, sessionId, workdir)` | promise of boolean | Optional. Before `/resume`, to ask if the engine still holds that conversation. |
| `forget` | `(ctx, workdir)` | promise | Optional. After a check, to discard what the engine kept for the temporary folder. |
| `ownResult` | `(ctx, workdir, file)` | promise of boolean | Optional. During a check, to ask if a file is one the engine wrote to hold a command's result. |
| `where` | `(ctx)` | string | Optional. Where the model is hosted, for `bc engine status` and the check report. |
| `process` | | string | Optional. The name of the engine's processes, so `bc status` can count the conversations held. |
| `shapes` | | boolean | Optional. Set it if `ask` can hold an answer to a JSON schema. `ask` then receives `schema`. Otherwise the core appends the schema to `system`. |

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
| `tools` | The tools the model may be offered: `Bash`, `Read`, `Glob`, `Grep`, `Write`, `Edit`. Offer fewer if you like, never more. |
| `readDirs` | Folders outside `workdir` that the agent may read. |
| `resume` | The `sessionId` of one of your own conversations to continue, or undefined. |
| `model`, `options` | What the owner chose, with your defaults for the rest. |
| `instructions` | `{ rules, generated, memory }`, three pieces of text. Give the model all three, in that order. Do not rely on the engine finding a file. |
| `env` | Extra environment variables for the engine's process. |
| `serve` | blackcat's tool server. See [Tools](#whose-tools). |

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

Served tools: start the engine with no tools of its own and give it `spec.serve`, which is `{ name, tools, handle(message) }`. It speaks the Model Context Protocol over JSON-RPC (`initialize`, `tools/list`, `tools/call`). Pass each message the engine sends to `serve.handle` and send the answer back. blackcat judges the call and carries it out itself. A new engine must work this way.

Ask first: the engine keeps its own tools and calls `on.toolUse`, `on.request` and `on.toolResult` around each use. This is acceptable only when the engine can be made to ask about every call and `bc engine check` shows that it does.

Claude Code supports both through its `tools` option:

| Value | Who decides each call | Who carries it out | How |
|---|---|---|---|
| `supervised` (default) | blackcat | Claude Code | A `PreToolUse` hook answers "ask" to every call, and the permission prompt goes to `on.request`. |
| `blackcat` | blackcat | blackcat | Claude Code starts with `--tools ""` and `spec.serve` as an `sdk` MCP server on the pipe already in use. |
| `engine` | Claude Code for commands it judges read-only, blackcat for the rest | Claude Code | The permission prompt alone. |

### Rules for an engine

- Do nothing for the model that `on.request` or `serve.handle` has not allowed.
- Give `ask` no tools. Readers go through text written by other people.
- Leave the engine's extras (web access, connectors, sub-agents, its own memory) off.
- Keep a key for a hosted model in `ctx.secrets`. If you pass it to the engine's process, the agent could come to see it, so it should be good for that model and nothing else.
- Keep everything that knows the engine's arguments, message format and storage inside your plugin.
- The chat and the readers are set separately, as `engine: { chat: { name, model, options }, readers: { ... } }` in the settings. Choosing another engine resets a role to that engine's defaults.
- The agent cannot run `bc engine use`, `check` or `accept`, and cannot change the `tools` option.
- The engine in use cannot be disabled as a plugin.
- A conversation held by another engine is not passed as `spec.resume`. The core carries it on from its own record.
- The core stops a turn after five minutes.

### What stays in the core

| Concern | Where |
|---|---|
| Allow, ask or refuse, for every call | `src/agent/policy.js` |
| Approval prompts | `src/channels/approvals.js` |
| The six tools, their limits, the tool server | `src/tools/` |
| Starting a conversation, answering `on.request` | `src/agent/brain.js` |
| Reader calls | `src/agent/oneshot.js` |
| Instructions and long-term memory | `src/agent/instructions.js`, `src/memory/` |
| Roles, stored choices, `TOOLS` | `src/engines/registry.js` |

`policy.js` still has rules about Claude Code's own settings files. They have no effect with another engine.

### Limits of engines

- Only Claude Code and the test engines have run. There is no second real engine.
- The tool server has one transport, Claude Code's pipe. An engine that needs a socket or a helper process must write that around `serve.handle`.
- The 0.2 s delay has not been measured for an engine that calls a model's API directly.
- A model that declines to try a forbidden action leaves that safeguard `not attempted`, which proves nothing either way.
- The sample data covers messages only.
- Commands run in `blackcat` mode are not sandboxed.

### Requests for the engine check

Any plugin, not only an engine, can supply these. `bc engine check` gives the model requests the owner might make and looks at which commands it asks to run. Each plugin supplies requests for its own commands:

```js
checks: [
  { say: 'what reminders do i have', expect: /blackcat remind list\b/ },
  { say: 'whats 17 times 23', never: /./ },            // nothing to look up: no command at all
],
// or a function, for requests that apply only once the plugin is set up:
checks: (ctx) => (Object.keys(hosts(ctx)).length ? [{ say: `how much disk is free on ${first}`, expect: … }] : []),
```

`expect` is a pattern on a command line the agent should ask to run; `never` is one it must not. A request is judged by what was asked for, not by whether it worked: the check runs in a copy with none of your plugin's secrets. Decide "set up" the same way your `agent.fill` does, or the agent is asked about something it was told is not connected.

## Guidelines

- Give `allow` only to commands that cannot change anything.
- Anything that changes what the agent may do is `owner`: adding a host, raising a mode, storing a credential.
- Secrets go in `ctx.secrets`, never in `config`, output or logs.
- Never build a shell command from input. Use `ctx.exec(program, [args])`.
- A command must end on its own: no `tail -f`, and set timeouts on network calls.
- Return the outcome, including failures, in words a person can act on.

## Limitations

- Agent tools that are not shell commands are not supported. A generic MCP plugin would need them.
- Scheduled messages, such as a reminder coming due, go to the channel in use, not to an open `bc chat`.
- There are no version ranges: `api: 1` is all that is checked.

## Checklist

Before sharing a plugin:

1. `bc plugin info <name>` shows every command with the access level you intend.
2. `bc <name> --help` reads well.
3. Each form command works in the terminal, with options, and in `/setup`. On a second run of `setup`, every question offers the current value and a saved secret can be kept.
4. The commands use the standard words. See [Naming](#naming).
5. With the plugin enabled, ask the agent to use it. Then ask it for something it should not be able to do (an `owner` command, a change on something read-only) and check that it is refused.
