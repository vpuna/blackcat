# Changes

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
