# Commands

Every `bc` command, with its options. This file is generated from the command line itself (`npm run docs:commands`), so it matches what `--help` prints. Do not edit it by hand.

In a chat channel the same commands work with a slash: `bc backup now` is `/backup now`. What the agent may do with a command is in [brackets]: run it freely, ask you first, or not at all. Nearly every command also takes `--json`, for output a program can read.

## Contents

[chat](#bc-chat) · [channel](#bc-channel) · [notify](#bc-notify) · [permissions](#bc-permissions) · [status](#bc-status) · [selftest](#bc-selftest) · [start](#bc-start) · [stop](#bc-stop) · [restart](#bc-restart) · [logs](#bc-logs) · [service](#bc-service) · [plugin](#bc-plugin) · [allsky](#bc-allsky) · [calendar](#bc-calendar) · [claude](#bc-claude) · [ha](#bc-ha) · [host](#bc-host) · [mail](#bc-mail) · [shortcut](#bc-shortcut) · [ssh](#bc-ssh) · [tg](#bc-tg) · [unifi](#bc-unifi) · [voice](#bc-voice) · [wa](#bc-wa) · [activity](#bc-activity) · [backup](#bc-backup) · [check](#bc-check) · [conversations](#bc-conversations) · [engine](#bc-engine) · [memory](#bc-memory) · [msg](#bc-msg) · [remind](#bc-remind) · [watch](#bc-watch)

## bc chat

- `bc chat [message...]`  
  talk to the agent here in the terminal (its own conversation, separate from the chat)
  - `--new`: start a fresh conversation (memories are kept)
  - `--resume [id]`: carry on an earlier conversation: pick from a list, or give its number (bc conversations list)

## bc channel

how blackcat talks to you: which channel is in use (one at a time; the terminal is always there too)

- `bc channel use <name>`  
  make a channel the one in use
- `bc channel off`  
  use no channel: everything is still kept, and shown in `bc chat`

## bc notify

- `bc notify [text...]`  
  send yourself a message on the channel in use, from a script or another program (text as arguments, or piped in)
  - `--from <name>`: who it is from, a short name of your choosing ("backup"): put before the text, and kept in the activity record

## bc permissions

commands you told the agent it may always, or never, run without asking: list them, remove any

- `bc permissions remove <id>`  
  remove one, so the agent asks again next time
- `bc permissions clear`  
  remove all of them

## bc status

- `bc status`  
  overview: services, the channel, the engine, plugins, the machine's health

## bc selftest

- `bc selftest [part...]`  
  ask everything that is set up whether it works right now: each machine, account, calendar and device, the chat, the engine, the databases (read-only: nothing is changed)

## bc start

- `bc start [service]`  
  start a service, or all of them

## bc stop

- `bc stop [service]`  
  stop a service, or all of them, until started again

## bc restart

- `bc restart [service]`  
  restart a service, or everything (after an update)

## bc logs

- `bc logs [service]`  
  show service logs
  - `-f, --follow`: keep showing new lines (Ctrl+C to stop)
  - `-n, --lines <n>`: how many recent lines (default: 50)

## bc service

run blackcat in the background: at boot, in a container, or in this terminal

- `bc service install [service]`  
  start blackcat now and whenever the machine starts; with a name, put back a service that was switched off
- `bc service uninstall [service]`  
  stop blackcat and no longer start it at boot; with a name, stop one service and keep it stopped
- `bc service run`  
  run blackcat's services in this terminal until stopped (Ctrl+C): what the boot unit and a container run

## bc plugin

plugins: list what is available, enable, disable

- `bc plugin list`  
  available plugins and whether they are enabled
- `bc plugin info <name>`  
  a plugin's commands, access levels and jobs
- `bc plugin enable <name>`  
  turn a plugin on
- `bc plugin disable <name>`  
  turn a plugin off (its settings and data are kept, unless you say otherwise)
  - `--data`: also delete its settings, secrets and stored data: a clean disconnect
- `bc plugin new <name>`  
  start a plugin of your own from a template (in user-plugins/)
- `bc plugin add <git-address>`  
  install a plugin someone else wrote, from a git address
  - `--name <name>`: the folder name to give it (default: from the address)
- `bc plugin remove <name>`  
  delete a plugin you added (its settings and data are kept unless you say otherwise)
  - `--data`: also delete its settings, secrets and data

## bc allsky

Allsky: an all-sky camera: the sky now, at any time of a night, and each night's star trails, keogram and timelapse

- `bc allsky setup`  
  the camera's address, and a login if its pictures ask for one [you only (terminal or /setup)]
  - `--url <value>`: Allsky's address
  - `--user <value>`: User name for its pictures (empty: they need no login)
  - `--max-mb <value>`: Largest file to fetch, in MB (a timelapse can be large; Telegram sends up to 50)
  - `--stale-min <value>`: How old may the latest picture be before the camera counts as stopped? (minutes)
- `bc allsky now`  
  the latest picture of the sky, saved where it can be looked at and sent [agent may run it]
- `bc allsky at <time>`  
  the picture taken closest to a time: the last time it was that time, or on a night you name [agent may run it]
  - `--night <date>`: which night: 2026-10-04 (the day it began), last, yesterday, tonight
- `bc allsky startrails`  
  the star trails of a night (the latest night that has one, unless you name a night), saved where it can be looked at and sent [agent may run it]
  - `--night <date>`: which night: 2026-10-04 (the day it began), last, yesterday, tonight
- `bc allsky keogram`  
  the keogram of a night (the latest night that has one, unless you name a night), saved where it can be looked at and sent [agent may run it]
  - `--night <date>`: which night: 2026-10-04 (the day it began), last, yesterday, tonight
- `bc allsky timelapse`  
  the timelapse of a night (the latest night that has one, unless you name a night), saved where it can be looked at and sent [agent may run it]
  - `--night <date>`: which night: 2026-10-04 (the day it began), last, yesterday, tonight
- `bc allsky nights`  
  the nights the camera has pictures for [agent may run it]
  - `-n, --limit <n>`: how many, latest first (default: 14)
- `bc allsky camera [word]`  
  how the camera itself is set (exposure, gain, location…): all of it, or the settings whose name contains a word [agent may run it]
- `bc allsky check`  
  succeed only if the camera is reachable and its latest picture is recent (made for checks) [agent may run it]
  - `--max-age <time>`: how old the latest picture may be: 10m, 1h (default: what setup says)
- `bc allsky settings`  
  how it is set up (secrets are named, never shown) [agent may run it]
- `bc allsky status`  
  how it is doing right now [agent may run it]

```
Examples:
  bc allsky setup                          the camera's address (and a login, if its pictures ask for one)
  bc allsky now                            the latest picture
  bc allsky at 02:30                       the picture closest to the last time it was 02:30
  bc allsky at 23:00 --night 2026-10-03    … on a night you name (the day the night began)
  bc allsky startrails                     the latest night's star trails (also: keogram, timelapse)
  bc allsky nights                         which nights it has
  bc allsky camera exposure                how the camera itself is set (all of it, or by a word in the name)
  bc allsky check --max-age 10m            for a check: fails unless it is taking pictures

In the bot the same commands send the picture: /allsky now, /allsky startrails.
```

## bc calendar

Calendar: reads your calendars (Google, iCloud, Outlook…) through their private iCal address: what is on, in the briefing and when you ask

- `bc calendar add`  
  connect a calendar by its private iCal address [you only (terminal or /setup)]
  - `--name <value>`: A short name for it (personal, family, work)
- `bc calendar remove <name>`  
  disconnect a calendar [agent must ask you first]
- `bc calendar list`  
  the calendars that are connected [agent may run it]
- `bc calendar today`  
  what is on today and tomorrow [agent may run it]
- `bc calendar agenda`  
  what is coming up [agent may run it]
  - `--days <n>`: how many days (default: 7)
  - `--from <date>`: the first day, YYYY-MM-DD (today if left out)
  - `--calendar <name>`: only this calendar
- `bc calendar find <text...>`  
  search events by words in the title, place or notes, or by who is in them [agent may run it]
- `bc calendar sync`  
  fetch the calendars now [agent may run it]
- `bc calendar settings`  
  how it is set up (secrets are named, never shown) [agent may run it]
- `bc calendar status`  
  how it is doing right now [agent may run it]

```
Examples:
  bc calendar add                    # connect a calendar (asks for a name and its address)
  bc calendar today
  bc calendar agenda --days 14
  bc calendar agenda --from 2026-12-20 --days 10 --calendar family
  bc calendar find dentist
  bc calendar sync                   # fetch now (it is fetched every 30 minutes anyway)

Read-only: the iCal address of a calendar cannot be used to change it.
```

## bc claude

Claude Code: the engine that runs the model: Claude Code, under your own Claude plan (or pointed at a model of your choosing)

- `bc claude setup`  
  where the model is: leave empty for your Claude plan, or give the address of a model served somewhere else [you only (terminal or /setup)]
  - `--endpoint <value>`: Address of the model (empty: your Claude plan)
- `bc claude settings`  
  how it is set up (secrets are named, never shown) [agent may run it]
- `bc claude status`  
  how it is doing right now [agent may run it]

```
Examples:
  bc engine status            which engine and model the agent and the readers use
  bc engine setup             choose the model and how hard it thinks
  bc claude setup      point Claude Code at a model somewhere else (leave empty for your Claude plan)
```

## bc ha

Home Assistant: the things in your home: see what is on, read sensors, switch lights and other devices

- `bc ha setup`  
  connect to Home Assistant [you only (terminal or /setup)]
  - `--url <value>`: Home Assistant's address
  - `--free`: May the agent switch lights, switches, fans, scenes and media players without asking you? (Everything else always asks; locks and alarms ask every time.)
  - `--no-free`: 
- `bc ha sync`  
  fetch the rooms and devices from Home Assistant again [agent may run it]
- `bc ha rooms`  
  your rooms, and how many things in each can be controlled [agent may run it]
- `bc ha devices [room...]`  
  what is in a room (or everything controllable), with its state now [agent may run it]
  - `--all`: include everything: settings, diagnostics, hidden things
- `bc ha find <text...>`  
  search every thing Home Assistant knows by name, including sensors [agent may run it]
- `bc ha state <name...>`  
  what one thing is doing right now [agent may run it]
- `bc ha history <name...>`  
  how a sensor or device has changed over the last hours [agent may run it]
  - `--since <when>`: how far back: 6h, 24h, 7d (default 24h, at most 7d)
  - `--hours <n>`: the same, in hours
- `bc ha on <name...>`  
  switch something on [depends on the arguments]
- `bc ha off <name...>`  
  switch something off [depends on the arguments]
- `bc ha toggle <name...>`  
  switch something to its other state [depends on the arguments]
- `bc ha open <name...>`  
  open a blind, curtain or valve [depends on the arguments]
- `bc ha close <name...>`  
  close a blind, curtain or valve [depends on the arguments]
- `bc ha stop <name...>`  
  stop a blind or curtain where it is, or what a speaker or TV is playing [depends on the arguments]
- `bc ha pause <name...>`  
  pause what a speaker or TV is playing [depends on the arguments]
- `bc ha lock <name...>`  
  lock a lock [depends on the arguments]
- `bc ha unlock <name...>`  
  unlock a lock [depends on the arguments]
- `bc ha run <name...>`  
  run a scene or script, or press a button [depends on the arguments]
- `bc ha media [words...]`  
  the files in Home Assistant's own media folder that a speaker or TV can be asked to play: all of them, or those whose name has these words [agent may run it]
- `bc ha play <name...>`  
  play on a speaker or TV: a file from the media folder (--media, by words of its name), at a volume if you give one; without --media, carry on with what was playing [depends on the arguments]
  - `--media <words>`: which file from the media folder: enough words of its name to mean one (see: bc ha media)
  - `--volume <percent>`: set the volume too: 0 to 100
- `bc ha set <name...>`  
  set a value: brightness, temperature, position, volume, mode [depends on the arguments]
  - `--brightness <percent>`: a light: 0 to 100
  - `--color <name>`: a light: a colour name, e.g. warmwhite, red
  - `--temperature <degrees>`: a thermostat or AC
  - `--mode <mode>`: a thermostat or AC: cool, heat, auto, off, …
  - `--position <percent>`: a blind: 0 (closed) to 100 (open)
  - `--volume <percent>`: a media player
  - `--speed <percent>`: a fan
  - `--value <value>`: a number or a choice (input_number, input_select)
- `bc ha check <name...>`  
  succeed only if a thing is in the state you expect (made for checks) [agent may run it]
  - `--is <state>`: it must be in this state, e.g. off, home, locked
  - `--not <state>`: it must not be in this state
  - `--above <n>`: its value must be above this
  - `--below <n>`: its value must be below this
  - `--grace <duration>`: only fail once it has been wrong for this long, e.g. 10m
- `bc ha kind [kind] [level]`  
  how freely the agent may act on a whole kind of thing (light, cover, lock…): free, ask, guarded or default [you only]
- `bc ha level <level> <name...>`  
  how freely the agent may act on one thing: free, ask or guarded (overrides the rule for its kind) [you only]
- `bc ha settings`  
  how it is set up (secrets are named, never shown) [agent may run it]
- `bc ha status`  
  how it is doing right now [agent may run it]

```
Setup:
  bc ha setup        the address of Home Assistant and a long-lived access token
  bc ha sync         fetch the rooms and devices again (done every night, and after setup)

Examples:
  bc ha rooms
  bc ha devices living room
  bc ha state bedroom temperature
  bc ha off living room light
  bc ha set living room light --brightness 40
  bc ha set bedroom ac --temperature 23
  bc ha run movie night
  bc ha media rain                                   files in Home Assistant's media folder with "rain" in the name
  bc ha play bedroom speaker --media "rain thunder" --volume 30
  bc ha pause bedroom speaker
  bc ha check front door --is off --grace 10m     for: bc check add … --run 'blackcat ha check …'
```

## bc host

This machine: the machine blackcat runs on: its health (with alerts for heat, a full disk or a weak power supply) and running commands on it

- `bc host health`  
  temperature, load, memory, disk and power-supply warnings [agent may run it]
- `bc host run`  
  run a command on this machine: bc host run '<command>' [depends on the arguments]
- `bc host mode [mode]`  
  what the agent may do on this machine: read, ask or full [you only]
- `bc host setup`  
  choose when to be alerted [depends on the arguments]
  - `--alerts`: Send a Telegram alert when this machine runs hot, the disk fills or the power dips?
  - `--no-alerts`: 
  - `--temp-limit <value>`: Alert above this temperature (°C)
  - `--disk-limit <value>`: Alert when the disk is fuller than this (%)
- `bc host settings`  
  how it is set up (secrets are named, never shown) [agent may run it]
- `bc host status`  
  how it is doing right now [agent may run it]

```
Examples:
  bc host health
  bc host run 'df -h'                       a command that only looks runs straight away
  bc host run 'sudo systemctl restart x'    for the agent, anything else needs your approval
  bc host mode ask                          read | ask | full: what the agent may do here
  bc host setup                             when to be alerted
```

## bc mail

Mail: reads your email accounts (Gmail and others, over IMAP), read-only; keeps the mail worth reading and skips newsletters and promotions without any AI

- `bc mail setup`  
  how often new mail is fetched [depends on the arguments]
  - `--every <value>`: How often should new mail be fetched?
- `bc mail add`  
  connect a mail account with an app password [you only (terminal or /setup)]
  - `--name <value>`: A short name for this account (personal, work)
  - `--address <value>`: The email address
  - `--host <value>`: The mail server (leave as it is unless you know otherwise)
  - `--days <value>`: How far back to keep mail?
- `bc mail remove <name>`  
  disconnect an account and forget its mail [agent must ask you first]
- `bc mail list`  
  the accounts that are connected [agent may run it]
- `bc mail sync`  
  fetch new mail now [agent may run it]
  - `--account <name>`: only this account
- `bc mail recent`  
  what arrived lately: kept (●) and skipped (○, with the reason) [agent may run it]
  - `--account <name>`: only this account
  - `-n, --limit <n>`: how many (default: 25)
  - `--kept`: only kept mail
  - `--skipped`: only skipped mail
- `bc mail senders`  
  who sends you mail, most first, and whether it is kept [agent may run it]
  - `--account <name>`: only this account
  - `--skipped`: only senders that are skipped
  - `--kept`: only senders that are kept
  - `-n, --limit <n>`: how many (default: 30)
- `bc mail find <text...>`  
  search senders and subjects, skipped mail included [agent may run it]
  - `--account <name>`: only this account
- `bc mail show <id>`  
  the text of one mail (a skipped one is fetched just for this, and not kept) [agent may run it]
- `bc mail allow <sender...>`  
  always keep mail from an address or a whole domain [agent must ask you first]
- `bc mail block <sender...>`  
  never keep mail from an address or a whole domain [agent must ask you first]
- `bc mail unrule <sender...>`  
  remove a sender from your allow and block lists [agent must ask you first]
- `bc mail rules`  
  how mail is sorted, and your allow and block lists [agent may run it]
- `bc mail settings`  
  how it is set up (secrets are named, never shown) [agent may run it]
- `bc mail status`  
  how it is doing right now [agent may run it]

```
Examples:
  bc mail add                        # connect an account (asks for a name, the address and an app password)
  bc mail recent                     # what arrived: ● kept, ○ skipped (and why)
  bc mail senders --skipped          # who is being skipped, most mail first
  bc mail allow school.example       # always keep mail from this domain or address
  bc mail block shop@deals.example   # never keep it
  bc mail find invoice               # search senders and subjects, skipped mail included
  bc mail show mail:personal:4812    # one mail's text

Kept mail is in the archive as the chat "Mail: <account>":
  bc msg find school trip --source mail
  bc watch add School emails --look-for "anything a parent must act on" --chat "Mail: personal" --from school.example --attachments

Read-only: nothing is sent, deleted, moved or marked as read.
```

## bc shortcut

Shortcuts: commands you define yourself: a recipe of steps run with one tap, with no AI involved

- `bc shortcut add <name>`  
  create a shortcut, or replace one of the same name [depends on the arguments]
  - `--description <text>`: what it does, shown in the bot's menu
  - `--run <command>`: a command to run (repeatable, in order)
  - `--send <file>`: a file to send back afterwards (repeatable)
  - `--caption <text>`: a caption for the file
  - `--at <HH:MM>`: also send it to you by itself at this time (repeatable)
  - `--cron <expr>`: the same, as cron: "0 19 * * 6,0" (repeatable)
  - `--days <list>`: with --at: only on these days (mon,tue… weekdays, weekends)
  - `--reply <what>`: output: also reply with what the last command printed; none: say nothing
  - `--no-test`: don't try it once now
- `bc shortcut list`  
  your shortcuts [agent may run it]
- `bc shortcut run <name> [action]`  
  run a shortcut, or one of its actions [agent may run it]
- `bc shortcut action <name> <action>`  
  give a shortcut an action: a word after its name with steps of its own (/waves pause), or take one away [depends on the arguments]
  - `--run <command>`: a command to run (repeatable, in order)
  - `--send <file>`: a file to send back afterwards (repeatable)
  - `--caption <text>`: a caption for the file
  - `--reply <how>`: output: also reply with what the last command printed; none: say nothing
  - `--description <text>`: what this action does (and, for a new shortcut, what the shortcut is)
  - `--main`: make the shortcut's own steps this action instead, leaving the shortcut as a menu of its actions
  - `--remove`: take this action away
  - `--no-test`: don't try it now
- `bc shortcut schedule <name> [action]`  
  have a shortcut, or one of its actions, sent to you by itself at set times, or stop that [depends on the arguments]
  - `--cron <expr>`: a repeating schedule as cron: "0 8 * * 1-5" is 08:00 on weekdays (repeatable)
  - `--at <HH:MM>`: every day at this time (repeatable)
  - `--days <list>`: with --at: only on these days (mon,tue… weekdays, weekends)
  - `--once <when>`: one time only: "YYYY-MM-DD HH:MM", or "HH:MM" for the next time it comes round (repeatable)
  - `--in <duration>`: one time only, from now: 45m, 3h, 2d
  - `--off`: stop sending it by itself, repeating and one-off
- `bc shortcut remove <name>`  
  delete a shortcut [agent must ask you first]
- `bc shortcut settings`  
  how it is set up (secrets are named, never shown) [agent may run it]
- `bc shortcut status`  
  how it is doing right now [agent may run it]

```
Examples:
  bc shortcut add door --description "Front door camera" \
      --run "blackcat unifi snapshot 'Front Door'" --send ~/blackcat/data/unifi-media/Front_Door.jpg
  bc shortcut add plot --description "Today's power plot" \
      --run "blackcat ssh get nas '/srv/plots/today.png' {dir}/plot.png" --send {dir}/plot.png
  bc shortcut add uptime --description "How long Unraid has been up" --run "blackcat ssh run unraid uptime"
  bc shortcut run door

{dir} is a private folder for that shortcut's files. Steps run in order and stop at the
first that fails. In the bot, a shortcut is /<its name>.
```

## bc ssh

SSH: look at, and with your approval act on, other machines (a NAS, a server, anything with SSH)

- `bc ssh list`  
  the machines blackcat can reach, and what the agent may do on each [agent may run it]
- `bc ssh add`  
  add a machine [you only (terminal or /setup)]
  - `--name <value>`: A short name for this machine (e.g. unraid)
  - `--host <value>`: Its address (IP or hostname)
  - `--user <value>`: Log in as which user
  - `--port <value>`: SSH port
  - `--mode <value>`: What may the agent do there?
- `bc ssh key <host>`  
  show a host's public key again [you only]
- `bc ssh test <host>`  
  check that blackcat can log in to a host [agent may run it]
- `bc ssh mode <host> <mode>`  
  change what the agent may do on a host [you only]
- `bc ssh remove [name]`  
  remove a machine, and delete its key [you only (terminal or /setup)]
  - `--name <value>`: Remove which machine?
  - `--sure`: sure
  - `--no-sure`: 
- `bc ssh close [host]`  
  close the open connection to a host, or to all of them [agent may run it]
- `bc ssh keep-open <minutes>`  
  how long a connection stays open after its last command (0 = connect every time) [you only]
- `bc ssh judge`  
  show how a command would be judged (read-only, sensitive or a change) without running it [agent may run it]
- `bc ssh put <host> <local> <remote>`  
  copy a file from this machine to a host: bc ssh put <host> <local file> <remote path> [you only]
- `bc ssh get <host> <remote> <local>`  
  copy a file from a host to this machine: bc ssh get <host> <remote path> <local file> [you only]
- `bc ssh run`  
  run a command on a host: bc ssh run <host> '<command>' [depends on the arguments]
- `bc ssh settings`  
  how it is set up (secrets are named, never shown) [agent may run it]
- `bc ssh status`  
  how it is doing right now [agent may run it]

```
Connections: the first command to a host logs in, and that connection is kept open in the
background and reused (about 30 ms per command instead of a new login each time). It closes
after 30 minutes without use (bc ssh keep-open <minutes>; 0 turns sharing off), when you change
a host's mode or remove it, with bc ssh close, and when the agent service restarts.
bc ssh test always makes a new login.

Modes, per host:
  read   look only: read-only commands run, everything else is refused
  ask    look freely, ask before changing: anything not read-only needs your Allow in Telegram
  full   no questions asked (only for machines you could afford to lose)

"Read-only" is judged from the command text (bc ssh judge '<command>' shows how one is judged).
That stops mistakes and the obvious tricks, but it is not a guarantee. For one, also restrict
the key on the remote machine: in its authorized_keys, put  command="/path/to/a-wrapper"  before
the key, with a wrapper script that only runs the commands you accept.
Commands that read passwords or keys (docker inspect, files under .ssh, .env, /boot/config…)
count as sensitive: refused in read mode, and need approval in ask mode.
```

## bc tg

- `bc tg account pair`  
  log in to your Telegram account and choose what to collect [you only, in a terminal]
- `bc tg account select`  
  choose how many days back, and which chats [you only, in a terminal]
- `bc tg account status`  
  link, service, what is kept, history progress [agent may run it]
- `bc tg account unpair`  
  log out (optionally delete stored Telegram messages) [you only, in a terminal]
- `bc tg account settings`  
  how it is set up (secrets are named, never shown) [agent may run it]
- `bc tg bot pair`  
  connect a @BotFather token and pair your Telegram account (scan a QR code) [you only, in a terminal]
- `bc tg bot unpair`  
  choose paired accounts to remove [you only, in a terminal]
- `bc tg bot test`  
  test the bot token and list paired accounts [you only, in a terminal]
- `bc tg bot settings`  
  how it is set up (secrets are named, never shown) [agent may run it]
- `bc tg bot status`  
  how it is doing right now [agent may run it]

```
Setup:
  bc tg account pair      log in (needs api_id and api_hash from https://my.telegram.org), choose chats
  bc tg account select    change how far back to keep, and which chats

Searching and reading what it collected is done with the archive's own commands:
  bc msg find <question> --source tg · bc msg chats --source tg

blackcat's own bot is never collected. Other bots, channels and groups over 500 members
are left out unless you choose them.
```

```
Examples:
  bc tg bot pair        connect a bot from @BotFather and pair your Telegram account (scan a QR code)
  bc tg bot test        check the bot token and list paired accounts
  bc tg bot unpair      choose paired accounts to remove
  bc channel            which channel blackcat talks to you through
```

## bc unifi

UniFi: your UniFi network and cameras: what is online, who is connected, who used the most data, what the console logged, camera snapshots

- `bc unifi setup`  
  connect to your UniFi console [you only (terminal or /setup)]
  - `--host <value>`: The console's address (IP or hostname)
- `bc unifi status`  
  is everything online: devices, cameras, how many clients [agent may run it]
- `bc unifi check`  
  succeed only if every device and camera is online (made for checks) [agent may run it]
- `bc unifi devices`  
  your UniFi devices: router, switches, access points [agent may run it]
- `bc unifi device <name...>`  
  one device in detail, with its current statistics (load, uptime, uplink, radios, ports) [agent may run it]
- `bc unifi clients`  
  what is connected to the network right now [agent may run it]
  - `--match <text>`: only clients whose name, address or MAC contains this
  - `--type <type>`: wired, wireless or vpn
  - `-n, --limit <n>`: how many to show (default: 60)
- `bc unifi client <name...>`  
  one connected client in detail [agent may run it]
- `bc unifi usage [client...]`  
  who used the most data: today, or over the last hours or days; name a client for its hours and apps [agent may run it]
  - `--since <when>`: how far back: 6h, 24h, 7d (instead of today)
  - `--hours <n>`: the same, in hours
  - `--days <n>`: the same, in days
  - `-n, --limit <n>`: how many clients to show (default: 10)
- `bc unifi events`  
  what the console logged: anything out of the ordinary, clients that keep dropping, and new devices [agent may run it]
  - `--since <when>`: how far back: 6h, 24h, 7d (default 24h)
  - `--hours <n>`: the same, in hours
  - `--days <n>`: the same, in days
- `bc unifi cameras`  
  your UniFi Protect cameras and whether they are connected [agent may run it]
- `bc unifi snapshot <camera...>`  
  take a picture from a camera now, and save it where the agent can look at it and send it [agent may run it]
- `bc unifi get <app> <path>`  
  read anything else the official API offers: bc unifi get network\|protect <path> [agent may run it]
- `bc unifi restart <device...>`  
  restart a UniFi device [agent must ask you first]
- `bc unifi port-cycle <port> <device...>`  
  switch the power of one PoE port off and on again (restarts whatever it powers) [agent must ask you first]
- `bc unifi settings`  
  how it is set up (secrets are named, never shown) [agent may run it]

```
Setup:
  bc unifi setup      the console's address and an API key (Network → Settings → Control Plane → Integrations)

Examples:
  bc unifi status
  bc unifi clients --match iphone
  bc unifi device "U7 Pro"
  bc unifi snapshot "AI Theta"
  bc unifi get network /sites
  bc unifi check                 exits with an error if anything is offline (for: bc check add … --run 'blackcat unifi check')
```

## bc voice

Voice: voice notes are transcribed on this machine: send one to the bot instead of typing, or have one from your messages read

- `bc voice transcribe <file>`  
  turn an audio file (a voice note, a recording) into text [agent may run it]
  - `--model <name>`: tiny, base or small (default: the one chosen in setup)
  - `--language <name>`: english, auto, hindi, …
- `bc voice setup`  
  which model to use (speed against accuracy) and which language you speak [depends on the arguments]
  - `--model <value>`: Which model? Larger ones are more accurate and slower.
  - `--language <value>`: Which language do you speak in voice notes?
- `bc voice settings`  
  how it is set up (secrets are named, never shown) [agent may run it]
- `bc voice status`  
  how it is doing right now [agent may run it]

```
Examples:
  bc voice transcribe ~/blackcat/data/inbox/voice.ogg
  bc voice setup          which model (speed against accuracy) and which language
```

## bc wa

WhatsApp: collects your WhatsApp messages into the archive, read-only (it can never send)

- `bc wa pair`  
  link WhatsApp, receive history, and pick chats [you only, in a terminal]
- `bc wa select`  
  choose how many days back, and all chats or only picked ones [you only, in a terminal]
- `bc wa status`  
  link, service, what is kept, archive size [agent may run it]
- `bc wa unpair`  
  unlink from WhatsApp (optionally delete stored messages) [you only, in a terminal]
- `bc wa settings`  
  how it is set up (secrets are named, never shown) [agent may run it]

```
Setup:
  bc wa pair      link WhatsApp (QR code or link code), pull history, pick chats
  bc wa select    change how far back to keep, and which chats

Searching and reading what it collected is done with the archive's own commands:
  bc msg find <question> --source wa · bc msg chats --source wa
```

## bc activity

Activity: a record of what blackcat did and what it used: every call to the model with its tokens, each command the agent ran, scheduled work

- `bc activity recent`  
  what happened lately: calls to the model, commands the agent ran, scheduled work, events [agent may run it]
  - `--kind <kind>`: only one kind: model, command, job, event, owner, sent
  - `--category <text>`: only entries whose category contains this ("watch", "msg", "chat")
  - `--since <when>`: how far back: 2h, 24h, 7d
  - `--failed`: only what failed or was refused
  - `-n, --limit <n>`: how many (default: 30)
- `bc activity usage`  
  what used the model, in tokens and cost: by what it was for, by model, or by day [agent may run it]
  - `--since <when>`: how far back: 24h, 7d, 30d (default 7d, today included)
  - `--days <n>`: the same, in days
  - `--by <what>`: category (default), model, day or kind (default: category)
- `bc activity setup`  
  what is recorded and for how long [depends on the arguments]
  - `--on`: Keep the record?
  - `--no-on`: 
  - `--days <value>`: How long to keep the entries? (Daily totals are kept for a year.)
  - `--commands <value>`: How much of each command the agent runs to keep?
  - `--cost`: Show cost in dollars? (It is the list price of each call, a measure of how much of your plan it used, not a charge.)
  - `--no-cost`: 
- `bc activity clear`  
  delete the whole record [you only]
- `bc activity settings`  
  how it is set up (secrets are named, never shown) [agent may run it]
- `bc activity status`  
  how it is doing right now [agent may run it]

```
Examples:
  bc activity recent                          the last things that happened
  bc activity recent --kind command --since 24h
  bc activity recent --failed
  bc activity usage                           what used the model this week, by what it was for
  bc activity usage --days 30 --by model
  bc activity usage --by day
```

## bc backup

Backups: a nightly copy of your messages, lists, settings and logins, kept somewhere else

- `bc backup setup`  
  where backups go, when, how many to keep, and whether to encrypt them [you only (terminal or /setup)]
  - `--place <value>`: Keep backups where?
  - `--dir <value>`: Which folder there should backups go in?
  - `--time <value>`: At what time each day? (24-hour HH:MM)
  - `--keep <value>`: How many backups to keep?
  - `--encrypt`: Encrypt the backups? They contain your messages and the logins for your accounts.
  - `--no-encrypt`: 
- `bc backup now`  
  make a backup now and send it [agent may run it]
- `bc backup list`  
  the backups that are kept [agent may run it]
- `bc backup restore [name]`  
  fetch a backup and unpack it; with --apply, put it in place of the current data [you only]
  - `--file <path>`: restore from a backup file that is already on this machine (copied by hand, a USB stick, a mounted folder) instead of fetching one; needs no backup setup
  - `--apply`: replace this installation's data with the backup (the current data is kept aside)
  - `--to <dir>`: without --apply: where to unpack it (default: ~/blackcat-restore-<date>)
  - `--yes`: with --apply: don't ask for confirmation
  - `--paused`: with --apply: leave every service switched off afterwards (the agent, and each message source), so that nothing logs in, sends or runs on a schedule until you say: for trying a backup while the installation it came from is still running
- `bc backup settings`  
  how it is set up (secrets are named, never shown) [agent may run it]
- `bc backup status`  
  how it is doing right now [agent may run it]

```
Where backups are kept is a place and a folder there: one
a plugin offers (the SSH plugin: every machine added with bc ssh add), or a folder on
this one (a USB disk, a mounted share).
  bc backup setup      where, which folder, when, how many to keep, and whether to encrypt

  bc backup now        make one now
  bc backup list       the backups that are kept, from this and any other machine
  bc backup restore    choose one and unpack it; add --apply to put it in place

Moving to another machine: install blackcat there, add the same place, run bc backup setup with the same folder and passphrase, then bc backup restore --apply.
```

## bc check

Checks: have something looked at on a schedule: you are told when it stops working, a fix can be tried, and when it recovers

- `bc check add <name...>`  
  set up a check [depends on the arguments]
  - `--run <command>`: a shell command to run; failing (a non-zero exit) means "not working". Often a plugin's own check: "blackcat unifi check"
  - `--file <path>`: a file to look at, e.g. a camera's latest image
  - `--max-age <duration>`: the file must have changed within this long, e.g. 20m
  - `--fix <command>`: a shell command to run when it is not working
  - `--tries <n>`: how many times to try the fix before giving up (default 2)
  - `--wait <duration>`: how long to wait after the fix before looking again (default 90s)
  - `--look-for <text>`: what "working" looks like, in your words: a reader then judges the picture or the output against it
  - `--every <when>`: when it looks: "30m" (default), "1h", times like "08:00,20:00", or cron. Never more often than every 5 minutes
- `bc check list`  
  every check and how it is doing [agent may run it]
- `bc check show <check>`  
  one check: what it looks at, how it is doing, and what has gone wrong before [agent may run it]
- `bc check edit <check>`  
  change a check: what it looks at, its fix, when it looks; or pause it [depends on the arguments]
  - `--run <command>`: a shell command to run; failing (a non-zero exit) means "not working". Often a plugin's own check: "blackcat unifi check"
  - `--file <path>`: a file to look at, e.g. a camera's latest image
  - `--max-age <duration>`: the file must have changed within this long, e.g. 20m
  - `--fix <command>`: a shell command to run when it is not working
  - `--tries <n>`: how many times to try the fix before giving up (default 2)
  - `--wait <duration>`: how long to wait after the fix before looking again (default 90s)
  - `--look-for <text>`: what "working" looks like, in your words: a reader then judges the picture or the output against it
  - `--no-fix`: remove the fix
  - `--no-look-for`: drop the description, so only the plain rules decide
  - `--every <when>`: when it looks
  - `--name <name>`: a new name
  - `--pause`: stop looking
  - `--resume`: start looking again
- `bc check remove <check>`  
  delete a check [agent must ask you first]
- `bc check run [check]`  
  look now, without waiting for its turn: one check, or all of them (a fix that is permitted is run if it is not working) [agent may run it]
  - `--dry-run`: only look: nothing is fixed, and its state is not changed
  - `--due`: only the checks whose turn it is
- `bc check settings`  
  how it is set up (secrets are named, never shown) [agent may run it]
- `bc check status`  
  how it is doing right now [agent may run it]

```
Examples:
  bc check add "Front door" --run "blackcat ha check 'front door' --is closed" --every 30m
  bc check add "Media server" --run "blackcat ssh run nas 'docker inspect -f {{.State.Running}} media | grep -q true'" --fix "blackcat ssh run nas 'docker restart media'"
  bc check add "Sky picture" --file ~/camera/latest.jpg --max-age 20m --look-for "a picture of the sky, not black or garbled"
  bc check list                               every check and how it is doing
  bc check run camera --dry-run               look once now; nothing is fixed, and its state is not changed

A check asks; what it asks is usually a plugin's own "check" command, which knows how to
tell whether its system is well (bc ha check, bc unifi check, and so on).
```

## bc conversations

Conversations: your conversations with the agent, kept so they can be listed, read, searched and continued

- `bc conversations list`  
  recent conversations, most recently used first [agent may run it]
  - `--channel <name>`: only from one place: terminal, or a channel by name (tg-bot)
  - `-n, --limit <n>`: how many (default: 15)
- `bc conversations show <id>`  
  what was said in a conversation, with how long each turn took and what it ran [agent may run it]
  - `--last <n>`: only the last n turns
- `bc conversations find <text...>`  
  turns whose question or answer mentions something, newest first, with what each took [agent may run it]
  - `--since <when>`: how far back: 24h, 7d
  - `-n, --limit <n>`: how many (default: 8)
- `bc conversations setup`  
  whether conversations are kept, and for how long [depends on the arguments]
  - `--on`: Keep conversations?
  - `--no-on`: 
  - `--days <value>`: For how long after a conversation was last used?
  - `--summary`: When a long conversation is continued from this record, summarise the part too long to hand over whole? (A reader, with no tools, writes it once; without this, only the latest part is handed over.)
  - `--no-summary`: 
- `bc conversations forget <id>`  
  delete one conversation [you only]
- `bc conversations clear`  
  delete every conversation that was kept [you only]
- `bc conversations settings`  
  how it is set up (secrets are named, never shown) [agent may run it]
- `bc conversations status`  
  how it is doing right now [agent may run it]

```
Examples:
  bc conversations list                       recent conversations, from the bot and the terminal
  bc conversations show 12                    what was said in one, with what each turn took
  bc conversations find "school trip"         turns that mention something
  bc chat --resume                            pick one from the terminal and carry on (in the bot: /resume)
```

## bc engine

Engine: what runs the model, for the agent you talk to and for the background readers: which engine, which model, how hard it thinks

- `bc engine status`  
  which engine and model the chat and the readers use, whether it is ready, and what can be chosen [agent may run it]
- `bc engine setup`  
  choose the model, and options such as how hard it thinks, for the chat or for the readers [depends on the arguments]
  - `--for <value>`: which one this is for: chat (the agent you talk to) or readers (the background readers)
  - `--model <value>`: a model the engine lists (bc engine status), "(default)" for the engine's own choice, or other with --name. Left out, it stays as it is
  - `--name <value>`: with --model other: the model's name, exactly as the engine knows it
  - `--effort <value>`: How hard it thinks: low, medium, high, xhigh, max, or "(default)". Left out, it stays as it is
  - `--tools <value>`: Whose tools the agent works with, and who is in charge of each call: supervised, blackcat, engine, or "(default)" (chat only). Left out, it stays as it is
- `bc engine check`  
  check what is in use for security, accuracy and speed, in a temporary copy with made-up messages; you decide whether to accept what it shows [you only]
  - `--for <which>`: chat, readers or both (default: both)
  - `--quick`: one request for each plugin instead of all of them
  - `--yes`: start without asking
- `bc engine accept`  
  accept the last check for what is in use (one that found a broken safeguard can only be accepted in a terminal) [you only]
  - `--for <which>`: chat, readers or both (default: both)
- `bc engine use <name>`  
  use a different engine for the chat, the readers or both: it is checked first, and starts from its own defaults [you only]
  - `--for <which>`: chat, readers or both (default: both)
  - `--no-check`: switch without checking it first
- `bc engine settings`  
  how it is set up (secrets are named, never shown) [agent may run it]

```
Examples:
  bc engine status                              what is in use, and what can be chosen
  bc engine setup                               choose the model (and options) for the chat or the readers
  bc engine setup --for readers --model haiku   the readers only; the chat is not touched
  bc engine setup --for chat --model opus --effort high
  bc engine setup --for chat --model other --name qwen3:14b     any model the engine can reach
  bc engine setup --for chat --model "(default)" --effort "(default)"   back to the engine's own choice
  bc engine setup --for chat --tools blackcat   whose tools the agent works with (yours alone to change)

The chat and the readers are set separately. An option that is left out stays as it is.
A change for the chat is taken up by your next message; for the readers, by the next thing
they read. After a change, what was checked no longer stands: bc engine check
  bc engine check                             check what is in use: security, accuracy, speed; then you decide
  bc engine use <name>                        a different engine: checked first (in a terminal only)
```

## bc memory

Memory: what the agent remembers from one conversation to the next: a few facts you told it, kept by blackcat

- `bc memory list`  
  everything remembered, most recently changed first [agent may run it]
  - `--kind <kind>`: only one kind: user, feedback, project, reference
- `bc memory show <name>`  
  one memory, whole [agent may run it]
- `bc memory save <name>`  
  remember something, or change a memory there already (what is not given stays as it was) [depends on the arguments]
  - `--kind <kind>`: what it is about: user, feedback, project, reference
  - `--summary <text>`: one line saying what it is about
  - `--text <text>`: the fact itself
  - `--append`: add --text to what is there, instead of replacing it
- `bc memory remove <name>`  
  forget one memory [depends on the arguments]
- `bc memory settings`  
  how it is set up (secrets are named, never shown) [agent may run it]
- `bc memory status`  
  how it is doing right now [agent may run it]

```
Examples:
  bc memory list                              everything it remembers
  bc memory show family-and-nicknames         one of them
  bc memory remove family-and-nicknames       make it forget one
  bc memory save coffee --kind user --text "Takes coffee black, no sugar"
```

## bc msg

Messages: search and read your message archive, across every source that is connected, by keyword or by meaning

- `bc msg chats`  
  list chats, most recent activity first (50 per page) [agent may run it]
  - `--source <which>`: only one source, by its short name: wa (WhatsApp), tg (Telegram), or one a plugin adds (mail)
  - `-p, --page <n>`: page number (default: 1)
  - `-n, --limit <n>`: chats per page (default: 50)
  - `--since <time>`: only chats active since, e.g. 7d
  - `--match <text>`: only chats whose name contains this
  - `--all`: also chats that are known but have no stored messages
- `bc msg find <question...>`  
  search by meaning as well as keywords; returns the matching bits of conversation [agent may run it]
  - `--source <which>`: only one source, by its short name: wa (WhatsApp), tg (Telegram), or one a plugin adds (mail)
  - `--also <phrasing>`: another way of saying it: synonyms, abbreviations, likely wording (repeatable)
  - `--chat <name>`: only in chats whose name contains this (or an id)
  - `--since <time>`: only after, e.g. 7d or 2026-09-01
  - `--until <time>`: only before
  - `-n, --limit <n>`: max results (default: 8)
- `bc msg search <words...>`  
  keyword search across stored messages [agent may run it]
  - `--source <which>`: only one source, by its short name: wa (WhatsApp), tg (Telegram), or one a plugin adds (mail)
  - `--chat <name>`: only in chats whose name contains this (or an id)
  - `--from <name>`: only from this sender ("me" for your own messages)
  - `--since <time>`: only after, e.g. 7d or 2026-09-01
  - `--until <time>`: only before
  - `--any`: match any word instead of all words
  - `--sort <order>`: relevance or time (default: relevance)
  - `-n, --limit <n>`: max results (default: 20)
- `bc msg thread <chat>`  
  read messages from one chat [agent may run it]
  - `--source <which>`: only one source, by its short name: wa (WhatsApp), tg (Telegram), or one a plugin adds (mail)
  - `--around <id>`: show the conversation around this message id
  - `-c, --context <n>`: messages either side with --around (default: 10)
  - `--last <n>`: latest N messages (default: 30)
  - `--since <time>`: only after
  - `--until <time>`: only before
- `bc msg media <messageId>`  
  fetch a photo, video, voice note or document on demand (falls back to its thumbnail) [depends on the arguments]
  - `--thumb`: only the small thumbnail stored with the message (no download)
  - `-o, --out <file>`: also copy the file here
- `bc msg preview <messageId>`  
  a message's link preview: title, description, URL, thumbnail [depends on the arguments]
  - `-o, --out <file>`: save the thumbnail JPEG here
- `bc msg index`  
  update the meaning-based search index (done automatically every 15 minutes, and before a search when new messages have arrived) [you only]
  - `--rebuild`: throw the index away and build it again (needed after changing the embedding model)
  - `--quiet`: no output
- `bc msg settings`  
  how it is set up (secrets are named, never shown) [agent may run it]
- `bc msg status`  
  how it is doing right now [agent may run it]

```
Examples:
  bc msg find when did we decide on the holiday --also "trip booking flights"
  bc msg search visa --chat Mum --since 30d
  bc msg thread Family --around <message-id>
  bc msg media <message-id>

Times: 12h, 7d, 2w, 3m, or a date like 2026-09-01. Add --json for machine-readable output.
```

## bc remind

Reminders: reminders and nudges delivered here: ones you set, and ones from your watches

- `bc remind add <text...>`  
  create a reminder [agent may run it]
  - `--at <time>`: "YYYY-MM-DD HH:MM", "YYYY-MM-DD" (9:00) or "HH:MM" (next time it comes round)
  - `--in <duration>`: from now: 45m, 3h, 2d, 1w
  - `--msg <messageId>`: attach a message from the archive (its chat, sender and text are quoted in the reminder)
  - `--repeat <how>`: daily, weekdays, weekly or monthly
  - `--cron <expr>`: repeat on a schedule, as cron: "0 20 * * 1,4" is 20:00 on Monday and Thursday (repeatable; with no --at it is first due the next time that comes round)
  - `--file <path>`: a picture or document to send along when it arrives
- `bc remind list`  
  upcoming reminders [agent may run it]
  - `--all`: include done and cancelled ones
- `bc remind done <id>`  
  mark a reminder done [agent may run it]
- `bc remind cancel <id>`  
  cancel a reminder [agent may run it]
- `bc remind snooze <id>`  
  move a reminder to a later time [agent may run it]
  - `--at <time>`: "YYYY-MM-DD HH:MM", "YYYY-MM-DD" (9:00) or "HH:MM" (next time it comes round)
  - `--in <duration>`: from now: 45m, 3h, 2d, 1w
- `bc remind setup`  
  quiet hours: when nudges wait (what is picked up from your messages is set with: bc watch setup) [depends on the arguments]
  - `--quiet <value>`: Quiet hours
- `bc remind settings`  
  how it is set up (secrets are named, never shown) [agent may run it]
- `bc remind status`  
  how it is doing right now [agent may run it]

```
Examples:
  bc remind add Call the bank --in 2d
  bc remind add Reply to Mum about Saturday --at 18:30 --msg <message-id>
  bc remind add Take out the bins --at 20:00 --repeat weekly
  bc remind snooze 4 --in 1h

Things to do are picked up from your messages by the built-in "Things I need to do" watch:
  bc watch setup             on or off, when it looks, which chats, email (also in the bot: /setup)
  bc watch show todo         what it has found
Quiet hours, when nudges wait:  bc remind setup
```

## bc watch

Watches: keep a tab on certain messages: collect what fits into a list and report on a schedule

- `bc watch add <name...>`  
  create a watch [agent may run it]
  - `--look-for <what>`: what belongs on the list, in plain words
  - `--chat <name>`: a chat to watch (repeatable); with no chat it is a plain list you add to by hand
  - `--from <person>`: in group chats, only messages from this person
  - `--self`: also messages you send to yourself
  - `--no-also-mine`: leave out your own messages in the watched chats (they are read unless you say so)
  - `--links-only`: only messages that contain a link
  - `--attachments`: also read the pictures, PDFs and documents sent in these chats
  - `--no-voice-notes`: do not listen to voice notes in these chats (they are, when the voice plugin is on, unless you say so)
  - `--mode <mode>`: how new items reach you: briefing (in the daily briefing, the default), digest (its own report on --days at --at), alert (straight away)
  - `--days <days>`: digest days: thu, "fri,sat", daily, weekdays
  - `--at <time>`: digest time, HH:MM
  - `--cron <expr>`: when its own report goes out, as cron: "0 18 * * 4" (repeatable)
  - `--nudge <when>`: a ping before a dated item: off, or "<days>d HH:MM", e.g. "2d 18:00" (default), "0d 07:00" for the morning of
  - `--scan <when>`: when it looks for new messages: "15m" (default), "1h", times like "08:00,20:00", or cron like "0 8,20 * * 1-5"
  - `--history <which>`: all: start with everything already in the archive; none: only new messages (default: all)
  - `--quiet <list>`: a list to keep out of reports (repeatable)
- `bc watch list`  
  all watches [agent may run it]
- `bc watch show <watch>`  
  what's on a watch's list [agent may run it]
  - `--status <which>`: new, kept, done, dropped, expired, or all (comma-separated) (default: new,kept)
  - `--list <name>`: only one of its lists, e.g. restaurants
- `bc watch lists <watch>`  
  a watch's lists and how many items each has [agent may run it]
- `bc watch setup`  
  "Things I need to do", the watch that is always there: on or off, when it looks, which chats, email [depends on the arguments]
  - `--auto`: Pick up things you need to do from your messages?
  - `--no-auto`: 
  - `--scan <value>`: When should it look? A length (1h), times of day, comma-separated (08:00, 20:00), or a cron expression (0 8,20 * * 1-5)
  - `--chats <value>`: Which chats should it look at? (Chats with a watch of their own are always left to that watch.)
  - `--mail`: Also look at your email? (Only the mail that is kept: from people, and from senders you chose. Mail another watch reads is left to that watch.)
  - `--no-mail`: 
  - `--calendar`: Include your calendar? (The coming week's events are put on the list as they are, on their day.)
  - `--no-calendar`: 
  - `--also <value>`: "Things I need to do": something more for it to pick up, in your own words
  - `--never <value>`: "Things I need to do": something it is never to pick up, in your own words
- `bc watch chats`  
  pick exactly which chats "Things I need to do" looks at [you only, in a terminal]
- `bc watch edit <watch>`  
  change a watch: what it looks for, where, and when it reports [depends on the arguments]
  - `--name <name>`: a new name
  - `--look-for <what>`: what belongs on the list
  - `--also <text>`: "Things I need to do" only: something more for it to pick up, in your own words ("" takes it away)
  - `--never <text>`: "Things I need to do" only: something it is never to pick up ("" takes it away)
  - `--add-chat <name>`: watch another chat (repeatable)
  - `--remove-chat <name>`: stop watching a chat (repeatable)
  - `--from <person>`: for the group chats or mail accounts being added: only this sender, or several separated by commas
  - `--self`: include messages you send to yourself
  - `--no-self`: stop including them
  - `--also-mine`: read your own messages in the watched chats too, from now on (the default for a new watch)
  - `--no-also-mine`: leave them out
  - `--links-only`: only messages with a link
  - `--no-links-only`: any message
  - `--attachments`: also read pictures, PDFs and documents
  - `--no-attachments`: stop reading them
  - `--voice-notes`: listen to voice notes in the watched chats (the default)
  - `--no-voice-notes`: do not listen to them
  - `--mail`: "Things I need to do" only: read kept email (it does by default)
  - `--no-mail`: stop reading email
  - `--calendar`: "Things I need to do" only: include your calendar (it does by default)
  - `--no-calendar`: leave the calendar out
  - `--with <source>`: "Things I need to do" only: cover this as well (mail, calendar, or any source a plugin adds; repeatable)
  - `--without <source>`: leave it out (repeatable)
  - `--covers <which>`: "Things I need to do" only: all (every chat) or direct (one-to-one chats)
  - `--mode <mode>`: briefing, digest or alert
  - `--days <days>`: digest days
  - `--at <time>`: digest time
  - `--cron <expr>`: when its own report goes out, as cron (repeatable)
  - `--nudge <when>`: off, suggested, or "<days>d HH:MM"
  - `--scan <when>`: "15m", "1h", times like "08:00,20:00", or cron
  - `--pause`: stop collecting and reporting
  - `--resume`: start again
  - `--quiet <list>`: keep this list out of reports: it is only shown when asked for (repeatable)
  - `--unquiet <list>`: report it again (repeatable)
- `bc watch remove <watch>`  
  delete a watch and its list [agent must ask you first]
- `bc watch item <itemId> <action> [list...]`  
  mark an item done, keep or drop; or move it to another list [agent may run it]
- `bc watch add-item <watch>`  
  put something on a list by hand [agent may run it]
  - `--msg <messageId>`: a message from the archive (its link and preview title are used)
  - `--title <title>`: what it is
  - `--url <url>`: a link
  - `--list <name>`: which of the watch's lists it goes on (a new name starts a new list)
  - `--file <path>`: a picture or document that belongs with it
  - `--category <category>`: same as --list (older name)
  - `--place <place>`: venue
  - `--area <area>`: neighbourhood or city
  - `--date <date>`: YYYY-MM-DD, if it happens on a day
  - `--summary <text>`: one line
- `bc watch edit-item <itemId>`  
  change an entry that is on a list: what it is called, its day, place, link or one-line note (it stays the same entry, with the message it came from) [agent may run it]
  - `--title <title>`: what it is
  - `--date <date>`: YYYY-MM-DD; "" for no particular day
  - `--summary <text>`: one line, with the details as they now are (a new time, a new place)
  - `--place <place>`: venue
  - `--area <area>`: neighbourhood or city
  - `--url <url>`: a link; "" to take it away
  - `--list <name>`: which of the watch's lists it is on
- `bc watch scan [watch]`  
  look now, without waiting for its turn: one watch, or all of them (each otherwise looks when its own schedule says) [agent may run it]
  - `--dry-run`: show what would be added, but don't save
  - `--due`: only the watches whose turn it is
- `bc watch tidy <watch>`  
  merge entries on a list that are the same thing announced more than once [agent may run it]
  - `--dry-run`: show what would be merged, but don't change anything
- `bc watch briefing`  
  the briefing: send it to your chat now, or show it here with --print; --cron (or --at and --days), --off and --on change when it arrives [depends on the arguments]
  - `--cron <expr>`: when it arrives, as cron: "0 7,18 * * 1-5" is 07:00 and 18:00 on weekdays (repeatable, for schedules that need more than one)
  - `--at <time>`: a time of day, HH:MM (repeatable)
  - `--days <days>`: with --at: daily (default), weekdays, weekend, or "mon,wed,fri"
  - `--off`: stop sending it
  - `--on`: send it again
  - `--show`: just say when it arrives
  - `--print`: show it here instead of sending it (the default when no channel is in use)
  - `--peek`: with no channel: leave new items marked as new
- `bc watch digest <watch>`  
  send a watch's report to your chat now [agent may run it]
- `bc watch settings`  
  how it is set up (secrets are named, never shown) [agent may run it]
- `bc watch status`  
  how it is doing right now [agent may run it]

```
Example: links Maya sends about things to do, reported every Thursday evening
  bc watch add Weekend ideas from Maya \
      --look-for "restaurants, shows, events and things to do in town that she'd like us to try" \
      --chat "Maya Lopez" --self --links-only --days thu --at 18:00

Sources: --chat can be repeated. In a group, --from limits it to one person. --self adds
messages you send to yourself. Your own messages in the watched chats are read too, so that
a plan you proposed or something you said you would do is picked up; --no-also-mine leaves them out.
```
