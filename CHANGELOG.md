# Changes

## 0.3.0

### New
- **A check that watches for something** (`--no-working-again`): told each time it happens,
  never "working again" when it stops, and each time kept on its own. For "tell me when the
  TV turns itself on", where the TV going off (you turning it off) is no news.
- **A shortcut said in words** ("turn tv on" for `/tv_on`, "play the waves" for `/waves play`)
  runs at once, with no model, when the words are its name and nothing more. Shortcuts are
  asked before Home Assistant's "kitchen lights on", so your own name for something comes
  first. For plugin authors: `chat.quickFirst`, and a quick route can answer in the chat
  itself (`answer`).
- **The mail you send keeps its attachments,** like the mail you get: each is stored beside
  its mail, read as it arrives, and opened with `bc msg media` (`bc mail show` lists them).

### Changed
- **A repeating reminder is one entry in the briefing,** not one for each time it went
  unanswered ("Time to go walking" three days running). One left unanswered when the next
  comes is marked missed. Done and cancel are for that time only; `bc remind stop` and a
  🛑 Stop repeating button end it. Cancelling the next one before it was due used to end
  the series without saying so. A repeating one is snoozed only to before its next time (no
  "Tomorrow 9:00" for a daily walk), and one opened from the briefing before it is due has no
  snooze buttons (they could only move it earlier).
- **The mail you sent is collected as far back as the account's days** (`bc mail history`),
  not only from the day that began. What is older is history: "Things I need to do" reads mail
  only from the day it began to, and a watch that follows senders never reads your own.
- **The agent's Claude Code is blackcat's alone:** it is started without your own Claude
  Code settings, hooks and plugins (`--setting-sources` none) and without its memory of
  your sessions. Only the tools, instructions and settings blackcat gives it are there.
- **Backups include `check-history.db`**, what checks saw over time.
- **Every `bc` command starts about 15% faster:** the TV's connection library and the
  terminal questions are loaded only by the commands that use them.
- **The tests take about 8½ minutes instead of 13:** more files run at once (many spend
  their time waiting), lint and format look again only at what changed, and one test
  puts 120 entries on a list directly instead of with 120 commands.
- **Tests that could not fail now can:** each was seen to fail with the code it guards
  broken. A test file with no tests in it, or lint and format not installed, fails the run.
- **A shortcut is tried, when it is made, without changing anything:** steps that only look
  are run, a step with its own `--dry` (a routine) is run that way, and from the first step
  that changes something (a light, a restart, a message) the rest are looked over and run
  only when it is used. Before, every new shortcut was run for real once.
- **The agent service leaves nothing running when it stops:** what it started is given a
  moment, then ended with all it started, and said in its log; one that does not stop
  cleanly ends with an error instead of passing for a clean stop.
- **The mail self-test says how long logging in and the mailbox took.**

### Fixed
- **On a kernel without `/proc/…/children`** (Unraid's, for one), a service that stopped
  could leave what it had started running: none were found. They are now found by their
  parent, which every Linux kernel shows.
- **A message could plant a lasting "owner" instruction:** after reading other people's
  messages or files, the agent could save a memory unasked, and every later conversation
  takes memories as what you said. Saving one then asks you, showing what it would keep.
- **An answer followed by a long talk about other things was missed** (a receipt sent as a
  photo, then thirty messages about the permit): only the last 24 messages were read. All
  that has not been read yet is now.
- **Something you were waiting on stayed open when the answer came after "No reply yet"**
  (paid back days later). It is still read after that nudge and ticked off when the answer
  comes; it is never nudged twice.
- **Snoozing a repeating reminder after it went made its next time twice** (two walks on
  Monday). Its next time is now made once.
- **A shortcut that takes a while** (a routine booking a ride) showed "typing…" for its first
  few seconds only, and seemed stuck. It is shown for as long as it runs, and not while a
  question waits for your tap.
- **Android: a keyboard the app brings up by itself** (a ride app's pick-up map, with its search
  box) hid what the next step waited for, which was then passed over. When what a step waits
  for has not come in 1½ seconds and the keyboard is up, it is closed (not after a step that
  keeps it open).
- **Android: the first tap in an app just opened was lost** when the app drew a first home
  screen and then swapped it for its real one (a ride app, opened cold: its first button never pressed). The
  first step now waits until the app's screen has stayed the same for 2 seconds (10 at most). A
  known pop-up is cleared before what is under it is tapped, not only when that cannot be
  found. When a tap is not made again because the screen changed, a few of the things that
  went are named.
- **A file whose sender called it only "a file"** (`application/octet-stream`, as some mail
  programs do of every attachment) was never read. Its name now says what it is: "scan.pdf"
  is read as a PDF. Those already kept are given their kind when the archive is next opened.
- **"Turn TV on" switched on the wrong TV:** Home Assistant's quick route counted only what
  answered, so with the living room TV in standby the dining room's was the one TV. It now
  counts everything with the name, and leaves one it cannot reach to the agent.
- **A check's alert could say "Falling" when it was rising,** when its command took over a
  second (an SSH look, say): it compared with the look before, not the one just made.
- **A shortcut that runs an Android routine** said the routine's answer again after the
  screen after the press had been sent, with the picture's path. It now says nothing more.
  A step can print `[[told]]` to say the owner has its result already.
- **A repeating reminder that went late** (blackcat was off when it was due) came again a
  minute later. The next one is now the next time still to come.
- **A check a model judges, with no model set up,** said why with its last word cut off.
- **A check that went wrong again within minutes of being fixed** said it had run its fix
  again ("I ran … 1 time; it worked"), even when nothing was run (its fix had been taken
  away meanwhile). It now says the fix worked before but the problem was back minutes later,
  in the alert and in its history.
- **Android:** a text field with no id is found again (it was named by what it held, which
  it is never found by); a tap made again is held to the booking guard too; the screen
  server is started again only when it really cannot look at the screen (not on any error a
  request gives), and a start that fails says why; the app's own parts of the confirmation
  screen are kept to recognise it; a label starting with a number is kept, and what cannot
  be kept to read is said; the picture at the end is taken once the screen is still, and
  one that cannot be taken says why.
- **"Running far more often than usual"** missed a job that runs a lot but finds nothing to
  do (it is counted, never listed): the daily totals now count what a schedule set off.
- **The briefing, when too long for one message,** could be cut inside a tag, and Telegram
  then refused it whole. It is cut at a line; what is cut is not numbered or marked as told.
- **A snoozed check's self-test** no longer hides that its fix was taken away or that it
  stopped looking.
- **A question closed by the owner writing instead** is recorded as such (`withdrawn`), not
  as answered.
- **The agent is given dates** for every kind of time field (a standing permission's,
  first seen, last run, snoozed until), and in a command's output without `--json` too.
- **What the bot did directly** is kept for the agent before it replies, so the owner's next
  message always comes with it.

### Upgrading
The message archive, the mail plugin's store and the reminders each take one step when first
opened (reminders: the times of a repeating one that were left unanswered, all but the last,
become missed). Make a backup first (`bc backup now`). Your sent mail is then fetched again, with its attachments,
over the next few fetches.

## 0.2.0

### New
- **Android** (`bc android`): apps on Android phones and TVs over adb. A routine
  goes through an app the way you would and stops before anything is booked, bought
  or sent: only your ✅ presses it. Routines are learned from a sentence or from
  pictures of the screen, take values, can be changed in words, and read what the
  app shows after the press. A step that goes wrong is looked at by a model and got
  past where it is safe. Any adb command can be run too, judged like `ssh run`. The
  small server it puts on a device answers only this machine, and only with a key.
- **LG TVs** (`bc webos`): power (it is woken over the network), volume, inputs,
  apps, the remote's buttons and a message on the screen, for several TVs.
- **Shortcuts:** a step can wait for something to be true before the next one runs
  (`bc webos check`, `bc android check`), and steps can be named. A long shortcut
  shows its steps ticked as they go, in one message; a routine it runs is called by
  the shortcut's description, and its picture comes after the last step.
- **Routines** can also go on from what an app is showing (`"start": "running"`),
  press a number such as a TV channel (`digits`), and send the screen at the end
  (`"picture": true`), so a TV box's channels are routines too.
- **Accounts:** every message says which of your accounts it came in on (which
  WhatsApp number, Telegram account or mail account), so you can ask.
- Plugins can ask you a question with buttons while they work (`ctx.askOwner`).
- **WhatsApp and Telegram:** `select` can collect all chats and leave out the ones you
  pick (a bot used for testing, say); their stored messages can be deleted then.
- **Use at your own risk, said plainly:** in the README, and before linking. `bc wa pair`
  says what WhatsApp may do to an account linked this way and links only on a yes;
  `bc tg account pair` says the same, shorter. A test holds that neither plugin calls
  anything that sends, marks as read or shows you online.
- **Checks keep what they saw:** `--limit "temp>75"` (and `--measure`) keeps the figures a
  check's command prints, and past a limit it is not working; `--context '<command>'` keeps
  what was going on when it goes wrong. Alerts say which way it was going and how long it
  lasted last time; "working again" says the peak. `bc check history` shows it all, for you
  or the agent ("why was the server hot last night?"). Kept 30 days (`--keep`), in
  `data/check-history.db`.
- **Checks ready to add:** `bc check offered` lists the ones the plugins you use have ready
  (each SSH host's heat, this machine's health, the network's devices, the sky camera);
  `bc check add --from <ref>` adds one, with your own limits.
- **"Things I need to do" ticks off what you have done:** an answer you owed, or something
  you said you would do, once your own messages plainly show it done (a file sent, "paid
  it"). Said once in the briefing, with a button to undo it. Not sure, and it stays.
- **Bookings and things on their way**, in "Things I need to do" with nothing to set up:
  flights, stays and tickets, parcels and refunds, kept with their reference and shown under
  "Coming up". A later message with that number, from anyone, ticks one off when it arrived
  or was cancelled, or moves it to its new day. Something not here by its day is asked about.
- **What the model used, in the briefing:** yesterday's calls and their cost at list price,
  in a few groups (talking to you, each watch, reading files, checks), and the week's daily
  average. Your own development sessions are left out. A plugin's `briefing` can give a
  `note` like it, shown at the end every time.

### Changed
- **Messages are kept however old.** The days you choose only say how far back
  history is fetched. Choosing fewer deletes nothing, and a chat you stop collecting
  keeps its messages unless you say to delete them.
- **WhatsApp:** choosing more days in `bc wa select` offers to link again, since that
  is how the phone sends history; chats that do not reach back far enough are then
  topped up from the phone, and you are told how it went.
- **`recover`** always goes through the days you chose (`--since` is gone). One that
  takes long carries on, and you are sent how it ended.
- **Mail:** `bc mail history <account> <days>`, up to six months, fetched at once.
  Mail is no longer dropped as it gets older. The calendar keeps six months of past
  events.
- The activity record says what changed when chats, days or links change, when
  history is fetched, and when an Android device's screen server starts.
- The Telegram bot goes on reading while a command waits for your tap.
- **Android:** entering text closes the keyboard after it; a tap an app ignored while
  starting is made again, only on the same screen; the screen server is started
  again when it can no longer read the screen. Trouble a run got past is kept on the
  activity record rather than sent, and after a cancel the agent says so in a line.
- **Docker:** adb is in the image. To wake a TV, run the container with
  `--network host`.
- **The check "blackcat itself" is now "blackcat health"**, renamed where it still had its
  first name. "Running far more often than usual" counts every run, from the daily totals,
  for yesterday: a check that was not working no longer seemed to run more often.
- **For plugin authors:** the manifest key for the engine check's requests is now `trials`
  (and `readerTrials`); `checks` now means checks a plugin offers.

### Fixed
- `bc wa unpair`, asked to delete the stored messages, deleted every source's
  messages. It now deletes only WhatsApp's.
- A shortcut whose last command printed nothing said "(nothing printed)".
- A routine with nothing to confirm could not be approved.
- The agent was given times as Unix numbers (when a message came, when the briefing goes
  next), which it cannot read; it now gets dates. Scripts still get the numbers.
- **The chat:** a message that reaches blackcat more than 10 minutes after you sent it
  (Telegram keeps what you send while blackcat is off) is no longer acted on as if just
  said. It is shown with when you sent it, and done only if you tap *Do it now*.
- **Android:** the picture of the app's last screen after the press could be of the
  screen before it, when a notice with the same words slid in first. Only the app's own
  screen counts now, and it is taken once it has stayed the same for a few seconds. A
  routine can also name a screen the app shows while still working (`"waiting"`, or a
  picture of it), to wait past.
- **Android:** a tap the app ignored while starting is made again also when the element
  moved as the screen finished loading (on the same screen, the same size). When it is not
  made again, why is said with the step that failed.

### Upgrading
The message archive is brought up to date once when 0.2.0 first opens it. Make a
backup first (`bc backup now`) and stop the WhatsApp and Telegram services while
you update. The checks and the watch databases gain a few columns then as well.

## 0.1.0

The first public version.
