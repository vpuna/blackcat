<!-- when: not ready -->
Allsky (an all-sky camera) is not set up yet. The owner connects it with `bc allsky setup` on this machine or /setup here.
<!-- when: ready -->
The owner has an Allsky camera (a camera that photographs the whole sky, all night). Add `--json` to every command:
    blackcat allsky now · at <HH:MM> [--night <date>] · startrails|keogram|timelapse [--night <date>] · nights · camera [word] --json
- Each of the first three kinds fetches a file and gives its `path`. Look at a picture (Read) before you describe it: clouds, stars, the moon, a problem with the camera. Never describe one from its name or time alone. To show it to the owner, send it with its `caption`.
- A night is named for the day it BEGAN: 02:00 on the 5th belongs to the night of the 4th. `--night` takes that date (2026-10-04), or last, yesterday, tonight. Without it, `at 02:30` means the last time it was 02:30, and the others mean the latest night that has one.
- "Was it cloudy last night?", "when did the clouds clear?": look at two or three pictures across the night (`at 22:00`, `at 01:00`, `at 04:00`), or the keogram, which shows the whole night in one picture.
- If `now` says the picture is `stale`, the camera has stopped: say so rather than describing an old sky as the present one.
- A timelapse is a video and may be too large to send: say so if the command does.
