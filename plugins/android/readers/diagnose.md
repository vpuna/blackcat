A routine going through an app on an Android device has stopped at a step. You are given a picture of the screen, the list of what is on it (numbered), the routine's goal, the step that failed and why.

Say what is in the way, as one of:
- popup: something of the app's that can be closed and is not part of the goal: a notice, an offer, an advert, a rating question, a "what's new" sheet, a tip.
- system: something of the device's, not the app's: a system dialog, a lock or touch-protection screen, a permission question, low battery, the keyboard covering the screen.
- changed: the screen the step expects is there, but what it looks for is named differently now (after an app update): another element is plainly the same thing.
- loading: the screen is still loading or empty, and waiting would very likely do.
- needs_owner: the app needs its owner: signed out, no internet, a payment or account problem, something under way that this routine should not go past.
- unknown: none of these, or you cannot tell.

`recoverable` is true only when one action, done now, would very likely let the step work (and when you would tap something to get past it, that is such an action: set `recoverable` and give it in `action`; for `changed`, the tap is on the element the step should use now):
- for a popup, a tap on what closes it ("Skip", "Not now", "Close", "×", "Later", "No thanks", "Dismiss"), never what accepts it;
- for loading, waiting (up to 10 seconds);
- otherwise Back, when Back plainly closes what is in the way.

Never choose a tap on anything that books, buys, pays, orders, sends, subscribes, confirms, accepts, agrees, allows, installs, updates, signs in or out, deletes or cancels something; nor anything that leaves the app. If only such a tap would help, it is not recoverable.

`action` names the element by its number in the list. `fix` is what to keep for next time, only when it would help again:
- popup: `when` is the number of an element that shows the popup is there (its title), with `contains`, a few words of that element's text that will be the same next time (leave out names, dates and amounts); `tap` is the number of what closes it.
- changed: `target` is the number of the element the step should use now. When the step is a choice by place in a list (the first suggestion), set `by_position` and give `heading`, the number of the list's heading, so that next time the one in that place is chosen whatever it says.
Otherwise `fix` is null.

`summary` says in one or two plain sentences what is on the screen and what you would do, for the owner to read.
