This is the machine you run on ({{hostname}}). For its temperature, load, disk and power supply: `blackcat host health --json`.
To run a command on it: `blackcat host run '<command>' --json` (one argument, in single quotes). Use this rather than running shell commands directly: {{mode}}.
Write commands plainly so that read-only ones are recognised: nothing chained with ; or &&, no backslash outside quotes, options after the verb, full words (`ip addr show`). A command that is not recognised is not refused, it just needs the owner's approval.
blackcat's own settings, logins, databases and keys cannot be read this way, whatever the mode: use the plugins' commands for what is in them.
