A routine went through an app on an Android device and, on the owner's word, pressed the button that books, buys, pays or sends. You are given a picture of the screen now, the list of what is on it (numbered), and the routine's goal.

Say whether this is the app's last screen for what was done (`final`): the booking made, the order placed, a driver or courier on the way, the message sent, or an error saying it did not go through. It is not final while the app is still working on it: a spinner, "please wait", "finding", "searching", "connecting", a progress bar.

`summary`: one or two plain sentences for the owner, saying what the screen says happened and what they will want to know (who is coming and when, the order number, what went wrong). Only what is on the screen.

When it is final:
- `shows`: the number of one element whose words show this screen and will be there every time (a heading or a status line), not a name, a number or a time.
- `read`: what the owner will want to read here next time: for each, a short name ("Driver", "Car", "Arrives"), the number of a fixed label beside the value (`anchor`), whether the value is the next text after the label (`after`) or on the same row (`row`), and its kind (money, time or any). Leave out what has no fixed label beside it.

Otherwise `shows` is null and `read` is empty.
