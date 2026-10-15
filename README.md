<p align="center">
  <img src="docs/images/logo.svg" width="128" height="128" alt="blackcat logo: a black cat's face in pixels">
</p>

# blackcat

blackcat is a personal agent that runs on a small always-on computer at home. It keeps a searchable copy of your messages, reminds you, watches for things you care about, and looks after your machines.

You use it from a terminal on the machine, and optionally from your phone through a **channel**: a chat that carries your messages to blackcat and its replies back. A Telegram bot is the channel that comes with it; others can be added as plugins.

It works at two levels:

- Without an AI model, it runs the commands, shortcuts, reminders and checks you set up.
- With one, you also talk to it in plain words. It reads your messages for you, and it sets things up when you ask: "remind me every Monday to put the bins out", "make a /door command that sends me a picture from the front door camera", "watch the school group for anything I need to act on".

```
you       what do I need to do this week?
blackcat  Three things. The school trip form is due Thursday. Maya asked on
          Monday whether you can drive on Saturday and you haven't answered.
          The car insurance renews on the 14th.

you       remind me about the form on Wednesday evening
blackcat  Done. Wednesday at 18:00.
```

<table>
  <tr><th>In a terminal</th><th>In Telegram</th></tr>
  <tr>
    <td><img src="docs/images/demo-top.gif" width="560" alt="Asking what needs doing this week, in a terminal"></td>
    <td><img src="docs/images/demo-tg-week.gif" width="250" alt="Asking what needs doing this week, in Telegram"></td>
  </tr>
</table>

It was written for a Raspberry Pi and runs on any Linux machine. It keeps its own services running, so it needs nothing from the system but a way to be started.

## Contents

- [What it can do](#what-it-can-do)
- [Requirements](#requirements)
- [Install](#install), on a machine or [in a container](#in-a-container)
- [Set up](#set-up)
- [Using it](#using-it)
- [Core features](#core-features): messages, reminders, watches, briefing, checks, shortcuts, messages from your scripts, memory, backups
- [Plugins](#plugins): WhatsApp, Telegram, mail, calendar, SSH, this machine, Home Assistant, UniFi, Allsky, files in messages
- [Running it](#running-it)
- [Security](#security)
- [Files and settings](#files-and-settings)
- [For developers](#for-developers)
- [License](#license)

## What it can do

| | | Needs a model |
|---|---|---|
| Chat | Talk to it in plain words, in a terminal or a chat channel. It remembers what you tell it. | yes |
| Commands | Every feature is a `bc` command. In a chat channel the same commands work with a slash: `/backup now`. | no |
| Shortcuts | Commands you define: `/door` sends a picture from the front door camera. | no |
| Reminders | "Remind me on Friday to call the bank", or `/remind add …`. | only for plain words |
| Messages | WhatsApp, Telegram and mail in one local archive. Read-only. Search by keyword or by meaning. | no |
| Watches | "Watch the school group for anything a parent must act on." Each keeps a list. | yes |
| Daily briefing | One message each morning: today, tomorrow, the week, what is new. | only for what watches add |
| Checks | "Is the camera still taking pictures? If not, restart it and tell me." | only to judge by description |
| Machines | Other machines over SSH, this machine's health, Home Assistant, a UniFi network, an all-sky camera. | no |
| Approvals | The agent works only through blackcat's commands, and shows you anything that changes something first. | |
| Backups | A nightly copy to another machine or disk, optionally encrypted. | no |

## Requirements

- Linux. With systemd, blackcat starts at boot by itself. Without it (a container), you start it with one command.
- Node.js 22 or later.

Optional, and recommended:

- [Claude Code](https://claude.com/claude-code), installed and signed in, to talk to blackcat in plain words. blackcat runs the model through it, under your own login, so no API key is needed. It is the only model provider supported today; what runs the model is a plugin, so others can be added.
- A Telegram account, to use blackcat from your phone through a bot of your own.

## Install

```sh
sudo apt install git zstd gnupg openssh-client ffmpeg unzip imagemagick poppler-utils tesseract-ocr antiword build-essential python3
git clone https://github.com/vpuna/blackcat.git ~/blackcat && cd ~/blackcat
npm install
mkdir -p ~/.local/bin && ln -sf "$PWD/bin/bc.js" ~/.local/bin/blackcat
echo 'alias bc=blackcat' >> ~/.bashrc && source ~/.bashrc
timedatectl set-timezone Europe/Lisbon     # reminders and schedules use local time
```

`bc` is only an alias, so scripts that use the calculator of the same name still work. If `blackcat` is not found, `~/.local/bin` is not on your `PATH` yet: log out and in again, or add it yourself.

The folder you cloned into is the installation. Settings and data go in `data/` inside it, created the first time you run a command.

### In a container

The `Dockerfile` follows the steps above, and blackcat's own supervisor is the container's command.

```sh
docker build -t blackcat .
docker run -d --name blackcat --restart unless-stopped -e TZ=Europe/Lisbon \
  -v blackcat-data:/blackcat/data -v blackcat-home:/home/blackcat blackcat

docker exec -it blackcat bc status          # every command works the same way
docker exec -it blackcat claude             # optional: sign in to Claude Code
```

- `/blackcat/data` holds your settings, messages, logins and logs; `/home/blackcat` holds the Claude Code sign-in. Keep both outside the container, as above, so an update loses nothing.
- It runs as user 99:100 (what Unraid gives its shared folders). Use `--user` for another.
- `bc host` is the container, not the computer it runs on. Add that computer as an SSH host.
- On Unraid, `unraid/blackcat.xml` is a template for the Docker tab. `docker-compose.yml` does the same for Compose.

## Set up

```sh
bc service install      # run in the background, now and at boot
bc status               # what is running
```

The background service delivers reminders, runs checks and backups, and sends the daily briefing. You can already use it with commands:

```sh
bc remind add Call the bank --in 2d
bc shortcut add uptime --description "How long this machine has been up" --run uptime
bc chat                 # where reminders and reports arrive until you add a channel; type /help
```

### A model (recommended)

```sh
claude                  # sign in to Claude Code once, then /exit
bc restart agent
bc chat what can you do
```

Everything in this guide can then be done by asking. That is easier for commands with many options (a watch, a check with a fix, a shortcut with several steps), and anything that would change your machines is still shown to you first. Without a model, plain words get a one-line reply saying so, and everything marked "no" above works. Watches pick up the waiting messages once you add one.

### The Telegram bot (recommended)

Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.

```sh
bc tg bot pair          # paste the token, then scan the QR code with your phone
bc restart agent
```

The bot answers only the accounts you pair, and only in a private chat. Try `/ping` and `/help`. It is separate from linking your own Telegram account (`bc tg account pair`, below), which lets blackcat read your Telegram chats.

One channel is in use at a time, and the terminal always works beside it (`bc channel`). Others (Slack, Signal) can be added as plugins; see [docs/plugins.md](docs/plugins.md#channels).

### Then connect what you want

Each is optional. All of them only read, except where the row says otherwise.

| To connect | Run | You need |
|---|---|---|
| WhatsApp messages | `bc wa pair` | your phone, to scan a QR code |
| Your Telegram account's messages | `bc tg account pair` | an api_id and api_hash from my.telegram.org |
| Email | `bc plugin enable mail`, then `bc mail add` | the address and an app password |
| Calendars | `bc plugin enable calendar`, then `bc calendar add` | the calendar's iCal address |
| Other machines, over SSH (can act, with your approval) | `bc plugin enable ssh`, then `bc ssh add` | the address and a user; you install the key it prints |
| This machine: health alerts and commands (can act, with your approval) | `bc plugin enable host`, then `bc host setup` | nothing |
| Home Assistant (can act; see its section) | `bc plugin enable ha`, then `bc ha setup` | the address and a long-lived access token |
| A UniFi network and cameras | `bc plugin enable unifi`, then `bc unifi setup` | the console's address and an API key |
| An all-sky camera | `bc plugin enable allsky`, then `bc allsky setup` | its address |
| Voice notes | `bc voice setup` | nothing; the speech model is downloaded once and runs on the CPU |
| Backups to another machine or disk | `bc backup setup` | an SSH host added above, or a folder |

After enabling a plugin, run `bc restart agent` so the agent knows about it. In a chat channel, `/setup` asks the same questions with buttons.

## Using it

### In a terminal

```sh
bc <command> --help              # every command explains itself
bc chat                          # the same conversation and slash commands as a chat channel
bc chat how hot is it running    # one question, then exit
```

[docs/commands.md](docs/commands.md) lists every command with all its options.

### In a chat channel

With a model, write anything and the agent answers. These are handled directly, without the model:

| | |
|---|---|
| `/help` | what it can do |
| `/briefing` | today's briefing |
| `/watch`, `/remind`, `/check`, `/ha` | your watches, reminders, checks and rooms, with buttons |
| `/setup` | set a plugin up by answering questions |
| `/permissions` | standing approvals; remove any |
| `/status` | the machine's health |
| `/new`, `/resume` | start a fresh conversation, or go back to an earlier one |

Any `bc` command also works with a slash: `/backup now`, `/unifi status`, `/bc plugin list`. Add `help` to see what one does: `/watch help`. You can also send photos, PDFs, documents and voice notes.

### Approvals

When the agent wants to do something that changes anything, it shows you the exact command and waits.

| | |
|---|---|
| Allow once | runs this time |
| Always allow | this exact command runs without asking from now on |
| Not now | refused; it will ask again next time |
| Never allow | this exact command is always refused |

A prompt expires after five minutes. `bc permissions` lists the standing answers and removes them.

<table>
  <tr><th>In a terminal</th><th>In Telegram</th></tr>
  <tr>
    <td><img src="docs/images/demo-approve.gif" width="560" alt="An approval: the exact command is shown and nothing runs until it is allowed, in a terminal"></td>
    <td><img src="docs/images/demo-tg-approve.gif" width="250" alt="An approval: the exact command is shown and nothing runs until it is allowed, in Telegram"></td>
  </tr>
</table>

## Core features

These are part of blackcat itself. Reminders, watches, checks and backups can each be switched off with `bc plugin disable <name>`.

### Messages

One local archive of everything your sources collect. Nothing here sends.

```sh
bc msg find when did we decide on the holiday         # by meaning
bc msg search dinner saturday --chat Family --since 30d
bc msg search "bring dessert" --from me
bc msg chats --match maya
bc msg thread Family --since 3d
bc msg media <message-id>                             # fetch a photo or document
```

Search by meaning uses an index built on the machine and updated every 15 minutes.

<table>
  <tr><th>In a terminal</th><th>In Telegram</th></tr>
  <tr>
    <td><img src="docs/images/demo-messages.gif" width="560" alt="Searching messages, and asking about them, in a terminal"></td>
    <td><img src="docs/images/demo-tg-messages.gif" width="250" alt="Searching messages, and asking about them, in Telegram"></td>
  </tr>
</table>

### Reminders

```sh
bc remind add Call the bank --in 2d
bc remind add Pay school fees --at "2026-10-05 09:00"
bc remind add Take the bins out --at 20:00 --repeat weekly
bc remind add Take the bins out --cron "0 20 * * 1,4"
bc remind list
bc remind snooze 4 --in 1h
bc remind done 4
```

A reminder arrives with Done and snooze buttons. `bc remind setup --quiet 23:00-07:00` sets quiet hours.

<table>
  <tr><th>In a terminal</th><th>In Telegram</th></tr>
  <tr>
    <td><img src="docs/images/demo-plain.gif" width="560" alt="Reminders: adding and listing them, and one arriving with its buttons, in a terminal"></td>
    <td><img src="docs/images/demo-tg-reminder.gif" width="250" alt="Reminders: adding and listing them, and one arriving with its buttons, in Telegram"></td>
  </tr>
</table>

### Watches

A watch reads certain chats, collects what fits into a list, and tells you. Needs a model.

```sh
bc watch add School notices \
  --look-for "things a parent needs to act on: events, trips, deadlines, forms" \
  --chat "Year 4 parents"

bc watch add Flat hunting --look-for "new listings with a price" --chat "Flat hunting" --mode alert

bc watch list
bc watch show 2
bc watch find dentist                # what every list has about something
bc watch item 12 done                # or keep, drop
bc watch edit-item 12 --title "Lunch at 14:00"
bc watch edit 2 --pause
```

- `--mode briefing` (the default) reports in the daily briefing, `digest` sends its own report on a schedule, `alert` sends each item at once.
- A watch reads your own messages in its chats too, so a plan you proposed is picked up; `--no-also-mine` leaves them out. Each message is read with the few lines before it, so "let's talk to him tonight" makes sense.
- A watch with no `--chat` is a plain list you add to by hand: `bc watch add-item 1 --title "Pottery class"`.
- One watch is built in: "Things I need to do". It reads all your chats, and mail and calendar if connected, and picks up promises, unanswered questions and deadlines. `bc watch setup` changes what it covers.
- It also notes what you are waiting on from others, under "Waiting on others" in the briefing. Each look reads that conversation since you asked, from both sides, voice notes included. When you have your answer it is ticked off and the briefing says what it came to. If nothing comes by the expected time (the time you named, else the next evening for a chat or three days for a mail), you get one "No reply yet" message. It reads only the conversation you asked in. `bc watch edit todo --never "things I am waiting on from other people"` switches it off.
- The same thing is not kept twice. Each watch is shown what your lists and reminders already hold. A reminder or entry you add that looks like one already kept is not added, and you are told which (`--anyway` adds it all the same); one a watch adds is marked "may be the same as #173 on School notices". `bc watch tidy <watch>` merges leftovers.

<table>
  <tr><th>In a terminal</th><th>In Telegram</th></tr>
  <tr>
    <td><img src="docs/images/demo-watch.gif" width="560" alt="Watches and their lists, in a terminal"></td>
    <td><img src="docs/images/demo-tg-watch.gif" width="250" alt="Watches and their lists, in Telegram"></td>
  </tr>
</table>

### Daily briefing

One message each morning at 07:00: today, tomorrow, the week ahead, and what is new on each watch. Tap a line's number to mark it done or snooze it.

```sh
bc watch briefing --print
bc watch briefing --at 06:30
bc watch briefing --at 07:00 --at 18:00 --days weekdays
bc watch briefing --off
```

<table>
  <tr><th>In a terminal</th><th>In Telegram</th></tr>
  <tr>
    <td><img src="docs/images/demo-briefing.gif" width="560" alt="The daily briefing, in a terminal"></td>
    <td><img src="docs/images/demo-tg-briefing.gif" width="250" alt="The daily briefing, in Telegram"></td>
  </tr>
</table>

### Checks

A check looks at something on a schedule, tells you when it stops working, and can try a fix first.

```sh
# Is the camera taking pictures? If not, restart it. After two tries, tell me.
bc check add Camera --run "blackcat allsky check" \
  --fix 'sudo systemctl restart allsky' --tries 2 --wait 2m --every 30m \
  --quiet 03:00-03:30          # the nightly update: say nothing then

bc check add "Sky picture" --file ~/camera/latest.jpg --max-age 10m   # a file that should keep changing

bc check list
bc check run camera --dry-run
bc check snooze camera --for 4h    # or --until-fixed
bc check fixed camera              # you fixed it: look now
```

- A check passes when its command exits with 0. With `--look-for "…"` a model judges the output or a picture against your description. Creating a check approves its commands, so the fix runs without asking.
- Each outage is one entry, updated while it lasts and kept with how long it lasted (`bc check show`).
- `--alert` sets when you are told (`now`, `briefing`, `"after 3"` looks, `"after 15m"`), `--quiet` keeps a time of day silent, `--remind 1h` repeats the alert. Alerts in Telegram have Snooze, I fixed it and Try the fix again buttons.
- One check is always there: **blackcat itself** reads blackcat's own activity record every hour, with plain rules and no model. It reports the same thing failing again and again, a command refused by policy, a service that stopped by itself, an unknown account writing to the bot, and scheduled work costing or running far more than usual (`bc activity problems`). It can be paused, not removed.

<table>
  <tr><th>In a terminal</th><th>In Telegram</th></tr>
  <tr>
    <td><img src="docs/images/demo-check.gif" width="560" alt="A check: made, and how it is doing, in a terminal"></td>
    <td><img src="docs/images/demo-tg-check.gif" width="250" alt="A check: made, and how it is doing, in Telegram"></td>
  </tr>
</table>

### Shortcuts

A shortcut runs commands you chose and sends back a file or what they printed. It runs as `/<name>`, with no model involved.

```sh
bc shortcut add uptime --description "NAS uptime" --run "blackcat ssh run nas uptime"

bc shortcut add door --description "Front door camera" \
    --run "blackcat unifi snapshot 'Front Door'" --send ~/blackcat/data/unifi-media/front-door.jpg

bc shortcut schedule door --at 19:00 --days sat,sun    # send it by itself
bc shortcut list
```

A shortcut can have actions, each a word after its name. One made only of actions is a menu: `/music` shows them as buttons.

```sh
bc shortcut action music play  --run 'blackcat ha play "Living room speaker" --media "Dinner playlist" --volume 30'
bc shortcut action music pause --run 'blackcat ha pause "Living room speaker"'
bc shortcut schedule music play --at 18:30
```

<table>
  <tr><th>In a terminal</th><th>In Telegram</th></tr>
  <tr>
    <td><img src="docs/images/demo-shortcut.gif" width="560" alt="Shortcuts: one made by asking, and two used, in a terminal"></td>
    <td><img src="docs/images/demo-tg-shortcut.gif" width="250" alt="Shortcuts: one made by asking, and two used, in Telegram"></td>
  </tr>
</table>

### Messages from your own scripts

Any script or cron job on the machine can send you a message through the channel in use, under a short name of your choosing.

```sh
blackcat notify --from backup "The backup finished"
./build.sh && blackcat notify --from build "Done" || blackcat notify --from build "FAILED"
df -h / | blackcat notify --from disk               # the text can be piped in
```

- Use `blackcat`, not `bc`, in scripts: the alias exists only in your own shell.
- It arrives as `backup: The backup finished`, outside your conversation with the agent, which does not see it. Text only, up to 4,000 characters, quiet hours do not apply.
- It exits with 0 when sent and 3 when there is no channel. Nothing is kept for later.
- The name is a label, not proof: anything running as you on the machine can use the command. The agent cannot.

<table>
  <tr><th>In a terminal</th><th>In Telegram</th></tr>
  <tr>
    <td><img src="docs/images/demo-notify.gif" width="560" alt="A message from a script: sent, and arriving, in a terminal"></td>
    <td><img src="docs/images/demo-tg-notify.gif" width="250" alt="A message from a script: sent, and arriving, in Telegram"></td>
  </tr>
</table>

### Memory and conversations

Tell the agent things worth keeping ("Sam is my brother") and it has them in every later conversation. Forgetting or replacing a memory needs your approval.

```sh
bc memory list
bc memory save coffee --kind user --text "Takes coffee black"
bc memory remove coffee
bc conversations list          # every exchange is kept for 90 days
bc conversations find "school trip"
```

<table>
  <tr><th>In a terminal</th><th>In Telegram</th></tr>
  <tr>
    <td><img src="docs/images/demo-memory.gif" width="560" alt="What is remembered, and past conversations, in a terminal"></td>
    <td><img src="docs/images/demo-tg-memory.gif" width="250" alt="What is remembered, and past conversations, in Telegram"></td>
  </tr>
</table>

### Backups

A nightly copy of everything that cannot be recreated, kept on another machine or disk. You are told only when one fails.

```sh
bc backup setup --place ssh:nas --dir /srv/backups/blackcat --time 03:30 --keep 14 --encrypt
bc backup setup --place here --dir /mnt/usb/blackcat
bc backup now
bc backup list
bc backup restore                 # unpack one into a folder; nothing live is touched
bc backup restore --apply         # put it in place of this installation's data
```

- A backup holds your messages and the logins for your accounts, so encrypt it and keep the passphrase somewhere else too.
- To move to another machine: back up, stop blackcat on the old one, install on the new one, then `bc backup restore --file <file> --apply`.
- `--paused` restores with everything switched off (the agent and each message source), to try a backup while the original still runs. `bc service install <name>` switches one on.
- What a restore replaces is kept in `data/before-restore-<date>` until you delete it.

Into a container, restore with the container stopped, from a container of its own with the backup's folder mounted. The file must be readable by the container's user.

```sh
docker stop blackcat
docker run --rm -it -v blackcat-data:/blackcat/data -v /path/to/backups:/backups:ro blackcat \
  blackcat backup restore --file /backups/<file> --apply
docker start blackcat
```

<table>
  <tr><th>In a terminal</th><th>In Telegram</th></tr>
  <tr>
    <td><img src="docs/images/demo-backup.gif" width="560" alt="Backups: making one, listing them, asking about them, in a terminal"></td>
    <td><img src="docs/images/demo-tg-backup.gif" width="250" alt="Backups: making one, listing them, asking about them, in Telegram"></td>
  </tr>
</table>

### Schedules

Anything that repeats takes cron: `minute hour day-of-month month day-of-week`, local time. `--at`, `--days` and `--repeat` cover the common cases, and blackcat repeats each schedule back in words with its next times.

## Plugins

```sh
bc plugin list                 # what exists and what is on
bc plugin enable ssh           # then: bc restart agent
bc plugin disable ha           # settings and data are kept; --data deletes them
```

| Plugin | Commands | What it does | On by default |
|---|---|---|---|
| `tg-bot` | `bc tg bot` | a channel: the Telegram bot | yes |
| `claude-code` | `bc claude` | runs the model through Claude Code | yes |
| `wa` | `bc wa` | collects WhatsApp messages | yes |
| `tg` | `bc tg account` | collects your own Telegram account's messages | yes |
| `voice` | `bc voice` | turns voice notes into text, on the machine | yes |
| `ocr` | `bc ocr` | reads the text in pictures, on the machine | yes |
| `docs` | `bc docs` | takes the text out of PDFs, Word and text files, on the machine | yes |
| `shortcut` | `bc shortcut` | commands you define | yes |
| `mail` | `bc mail` | collects email over IMAP | no |
| `calendar` | `bc calendar` | reads your calendars | no |
| `ssh` | `bc ssh` | other machines | no |
| `host` | `bc host` | this machine | no |
| `ha` | `bc ha` | Home Assistant | no |
| `unifi` | `bc unifi` | a UniFi network and its cameras | no |
| `allsky` | `bc allsky` | an all-sky camera | no |

"On by default" means switched on; each still needs its own `pair`, `setup` or `add` before it does anything. Mail accounts, calendars and SSH machines have names you choose: adding one under a name already in use asks whether to replace it, and `rename` changes only the name, never what is stored.

### WhatsApp

```sh
bc wa pair        # scan a QR code, choose how far back and which chats
bc wa select      # change what is kept
bc wa status
```

blackcat links as a companion device, like WhatsApp Web, and never sends. Only the chats and days you choose are stored. The history comes from your phone when you link, so choosing more days later does not fetch older messages. What arrives while blackcat is off is delivered when it connects again (a device left off for about two weeks is unlinked). This uses WhatsApp's unofficial protocol, which is against its terms; reading only keeps the risk of a ban low, not zero.

#### When something is missing

Each source has a `recover` command that goes through recent days again and keeps only what is not there yet. The agent can run it too when you ask why something is missing.

| | What it does | How far back |
|---|---|---|
| `bc wa recover` | asks your phone for older messages of each chat, as WhatsApp Web does when you scroll up. The phone has to be on. | `--since 60d` or a date |
| `bc tg account recover` | reads each chat again from Telegram | `--since 60d` or a date |
| `bc mail recover` | a full fetch now | the days kept for the account |

`--chat "a name"` limits it to one chat, which is much quicker. Over every chat it can take a while: the command returns after two minutes and the work carries on; run it again to see how it ended. On WhatsApp a chat is asked about backwards from its newest kept message, so a chat with nothing kept in those days cannot be recovered.

### Telegram account

```sh
bc tg account pair      # needs an api_id and api_hash from https://my.telegram.org
bc tg account select
```

It logs in to your own account as another device to read your chats. Your chat with blackcat's bot is never collected. Other bots, channels and large groups are off unless you choose them. What arrived while blackcat was off is fetched when it is back (new messages only, not edits or deletions).

### Mail

```sh
bc plugin enable mail
bc mail add                        # a name, the address, an app password, how far back
bc mail recent                     # what arrived: kept or skipped, and why
bc mail allow school.example       # always keep mail from a domain or address
bc mail block shop@deals.example
bc mail rename personal home
```

Read-only over IMAP. Newsletters and promotions are skipped by rules, with no model. Mail you send is collected too, from the day collection starts, so a promise you made by mail reaches your watches. Each account appears in the archive as a chat called `Mail: <name>`.

The first 6,000 characters of each mail are kept, a watch is shown the first 3,000, and "Things I need to do" the first 1,500. Quoted earlier mail sits at the bottom, so in a long mail that is what gets cut. Attachments of mail you receive are read like other files (see [Files in messages](#files-in-messages)).

### Calendar

```sh
bc plugin enable calendar
bc calendar add                    # a name and the calendar's iCal address
bc calendar today
bc calendar agenda --days 14
```

Read-only. Events appear in the daily briefing on their day. Google: Settings → the calendar → "Secret address in iCal format". iCloud: share as a public calendar. Outlook: publish the calendar and copy the ICS link.

### SSH

```sh
bc plugin enable ssh
bc ssh add                     # a name, address, user and mode; prints a key to install there
bc ssh run nas 'docker ps'
bc ssh mode nas read           # read | ask | full
```

| Mode | What the agent may do there |
|---|---|
| `read` | commands that only look; the rest is refused |
| `ask` | look freely; anything else needs your approval |
| `full` | anything, without asking |

Each host gets its own key, and every host is also a place a backup can go.

<table>
  <tr><th>In a terminal</th><th>In Telegram</th></tr>
  <tr>
    <td><img src="docs/images/demo-ssh.gif" width="560" alt="Another machine over SSH, in a terminal"></td>
    <td><img src="docs/images/demo-tg-ssh.gif" width="250" alt="Another machine over SSH, in Telegram"></td>
  </tr>
</table>

### This machine

```sh
bc plugin enable host
bc host health                 # temperature, load, memory, disk
bc host run 'df -h'
bc host mode ask               # read | ask | full, as for SSH
bc host setup --alerts --temp-limit 75 --disk-limit 90
```

You get one message when a limit is crossed. `bc host run` is the only way the agent can run a command on this machine.

<table>
  <tr><th>In a terminal</th><th>In Telegram</th></tr>
  <tr>
    <td><img src="docs/images/demo-host.gif" width="560" alt="The health of the machine blackcat runs on, in a terminal"></td>
    <td><img src="docs/images/demo-tg-host.gif" width="250" alt="The health of the machine blackcat runs on, in Telegram"></td>
  </tr>
</table>

### Home Assistant

```sh
bc plugin enable ha
bc ha setup                              # the address and a long-lived access token
bc ha devices living room
bc ha on living room lamp                # also: off, toggle, open, close, lock, unlock
bc ha set ceiling light --brightness 40
bc ha play bedroom speaker --media "rain" --volume 30
```

Lights, switches and media players act freely; climate and blinds ask first; locks, alarms and gates ask every time (`bc ha kind` and `bc ha level` change that). "Kitchen lights on" in the chat is carried out directly, and `/ha` opens a browser of rooms with buttons.

<table>
  <tr><th>In a terminal</th><th>In Telegram</th></tr>
  <tr>
    <td><img src="docs/images/demo-home.gif" width="560" alt="Asking Home Assistant whether a light is on, in a terminal"></td>
    <td><img src="docs/images/demo-tg-home.gif" width="250" alt="Asking Home Assistant whether a light is on, in Telegram"></td>
  </tr>
</table>

### UniFi

```sh
bc plugin enable unifi
bc unifi setup                         # the console's address and an API key
bc unifi status
bc unifi clients --match iphone
bc unifi usage --since 7d
bc unifi snapshot "Living Room"
```

<table>
  <tr><th>In a terminal</th><th>In Telegram</th></tr>
  <tr>
    <td><img src="docs/images/demo-unifi.gif" width="560" alt="Asking how many devices are on the network, in a terminal"></td>
    <td><img src="docs/images/demo-tg-unifi.gif" width="250" alt="Asking how many devices are on the network, in Telegram"></td>
  </tr>
</table>

### Allsky

For an [Allsky](https://github.com/AllskyTeam/allsky) camera, on this machine or another.

```sh
bc plugin enable allsky
bc allsky setup
bc allsky now                            # the latest picture
bc allsky startrails --night yesterday   # also: keogram, timelapse
bc allsky check --max-age 10m            # for a check: fails unless it is taking pictures
```

### Files in messages

Voice notes, pictures and documents in the chats you collect are read when they arrive, in the background, and their words are kept with the message. A search finds them, the chat shows them (🎙, 🔤, 📄), and every watch reads them like a written message. A file is fetched to be read and removed again; only its words stay. For each kind you choose who reads it:

| | |
|---|---|
| `local` | this machine only; nothing leaves it |
| `model` | the model, for every file |
| `both` (the default) | this machine first, and the model only when its reading is not sure enough |
| `off` | not read |

```sh
bc msg reading                         # how it stands, and what is waiting
bc msg reading --pictures local        # also --voice, --documents
bc msg reading --picture-level 75      # also --document-level
bc msg reading --show <message-id>     # how one file was read
bc msg reading --stats --since 30d     # counts, scores, what the model used
bc msg setup                           # the same choices as questions (in the bot: /setup)
```

"Not sure enough" is a score from 0 to 100 that the reading on this machine gives itself, compared with a level you set: 60 for pictures, 90 for a scanned page. `--stats` shows how many files each other level would have sent to the model. When a kind is first switched on, the last 30 days are read for searching; watches do not go back over them.

- Voice notes are transcribed on the machine with Whisper, up to ten minutes each. Claude cannot take audio, so they are never sent anywhere. `bc voice setup` chooses the model size and your language; `bc watch edit <id> --no-voice-notes` has one watch leave them out.
- Pictures are read with Tesseract, twice (as a page and as scattered text), and the agreement between the two gives the score. Under the level, the picture goes to the model, which reads designed graphics far better (about one in five chat pictures in a trial). `bc ocr setup` chooses languages; another needs its package, e.g. `sudo apt install tesseract-ocr-ara`. WhatsApp keeps pictures for about two weeks, so older ones cannot be fetched.
- A PDF (up to 30 pages), a Word file (`.docx` or `.doc`) or a text file has its text taken out exactly, with no model; a page that is a picture is read as pictures are. The whole text is kept for searching; a watch gets the text, or a note of it written by the model when it is long. Spreadsheets and presentations are not read. `bc docs read <file>` shows what it makes of one.

<p align="center">
  <img src="docs/images/demo-tg-voice.gif" width="250" alt="A voice note sent to the bot: its words appear, then the answer">
</p>

## Running it

```sh
bc status                     # what blackcat last saw
bc selftest                   # ask everything that is set up whether it works now
bc logs agent -f
bc restart agent              # after enabling a plugin
cd ~/blackcat && git pull && npm ci && bc restart     # update
```

One process, blackcat's own supervisor, starts the agent and each message source and restarts one that dies. A service whose account is not linked yet waits and starts once it is; one that ends saying it needs you (logged out) stays stopped until you start it.

```sh
bc service install        # start it now and at boot (systemd)
bc service run            # or run it in this terminal until Ctrl+C; also a container's command
bc stop wa                # stop one service until you start it again
bc service uninstall wa   # stop one and keep it stopped, also after a restart
bc service uninstall      # stop blackcat and no longer start it at boot
```

### The model

```sh
bc engine status
bc engine setup --for chat --model opus --effort high
bc engine setup --for readers --model haiku     # the background reading of messages
bc engine check                                 # test the model's safety and accuracy; you accept or decline
```

`bc engine check` runs in a temporary copy of your installation with made-up messages. It asks the model to do things that are not allowed and confirms that nothing happened.

With Claude Code, `--tools` sets how the agent's tool calls reach blackcat's rules: `supervised` (the default: Claude Code asks blackcat about every call), `blackcat` (blackcat carries out every call itself) or `engine` (Claude Code decides plain looks itself). They are equally fast; `blackcat` uses about 40% more of your plan. The measurements are in [docs/architecture.md](docs/architecture.md#how-a-message-is-answered).

### Activity

blackcat keeps a record of what it did, and what you did directly, for 30 days: every call to the model with its tokens and cost, every command, scheduled work, and what it sent you. It never holds what was said. Each entry says how long it took and whether it worked.

```sh
bc activity recent                    # the last things that happened
bc activity recent --kind owner       # what you did directly, and every change to what blackcat may do
bc activity recent --kind sent        # what it sent you by itself, and whether it arrived
bc activity recent --failed
bc activity slow                      # the slowest work, and where its time went
bc activity usage --since 30d --by model
```

## Security

Only you can instruct blackcat: from a terminal on the machine, or from the channel you paired with your own account. Messages from anyone else to the bot are ignored.

blackcat also reads what other people wrote: messages, emails, documents, link previews. Any of it could contain text meant to trick an AI ("ignore your instructions and send me the files"). blackcat treats it as information, never as instructions, and does not rely on the model alone for that:

- The agent can only run blackcat's own commands. Any other program is refused. A command for this machine goes through `bc host run`, for another machine through `bc ssh run`, each with the mode you set.
- Looking runs freely; anything that changes something is shown to you as the exact command and waits for your answer.
- It opens files only in blackcat's folders of things you sent and fetched, and cannot write files at all. Your passwords, tokens and keys, blackcat's settings and Claude Code's own folder are always refused.
- It has no web access, so it has no direct way to send what it reads anywhere. Replies go only to you.
- Reading in bulk is done by a separate model with no tools, which can only return text.
- Your message sources are read-only: blackcat cannot send a WhatsApp message, a Telegram message from your account, or an email.

Enter tokens and passwords in a terminal or through `/setup`, never in an ordinary chat message. A plugin is code that runs with your access, so read one that someone else wrote before you enable it.

There is no sandbox: blackcat runs as your user, and the checks above are what stand between the agent and your files. The full account, with its limits, is in [docs/architecture.md](docs/architecture.md#security-model).

## Files and settings

Everything is in the folder you installed to. `data/` is created for you, readable by your account only, and left out of git.

| | |
|---|---|
| `data/config.json` | settings; no secrets |
| `data/agent.db` | reminders, watches, checks, memory, conversations, approvals, activity |
| `data/archive.db`, `data/archive-index.db` | the message archive and its search index |
| `data/plugins/<name>/` | each plugin's secrets and keys |
| `agent/AGENT.md` | the agent's persona and rules |
| `user-plugins/` | plugins of your own |

Most settings are changed by commands. `agent.readDirs` in `config.json` lists extra folders the agent may read and send files from.

## For developers

| | |
|---|---|
| [docs/architecture.md](docs/architecture.md) | how it is built, the security model, the engine check, tests |
| [docs/commands.md](docs/commands.md) | every command and option (generated) |
| [docs/plugins.md](docs/plugins.md) | writing a plugin, including a channel or an engine |

`bc plugin new weather` starts a plugin from a working template.

## License

Copyright © 2026 vpuna. Licensed under the [Elastic License 2.0](LICENSE). You may use, copy, modify and redistribute blackcat, including inside your own product. You may not offer it to others as a hosted or managed service.

The WhatsApp and Telegram-account plugins depend on libraries under the GPL-3.0; see [third-party terms](docs/architecture.md#third-party-terms).

## Status

This is one person's project, used daily. Expect rough edges.

Found a problem, or want something it does not do? Open an issue at [github.com/vpuna/blackcat](https://github.com/vpuna/blackcat/issues). For a security problem, say only that you have one, and you will be asked how to send the details.
