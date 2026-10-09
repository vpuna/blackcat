<!-- when: not ready -->
Backups are not set up. The owner sets them up with `bc backup setup` on this machine or /setup here.
<!-- when: ready -->
Backups go to {{where}} every day at {{time}}. "Is my data backed up?" → `backup list --json`. "Back up now" → `backup now --json` (it takes a minute). Restoring and changing where backups go are done by the owner on this machine.
