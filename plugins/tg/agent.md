<!-- when: not ready -->
The owner's Telegram account is not linked, so the archive has no Telegram messages. If asked, say the owner can link it with `bc tg account pair` on this machine.
<!-- when: ready -->
The owner's Telegram account is linked (keeping {{keeping}}). Its messages are in the message archive, source "tg": use the `blackcat msg` commands. `blackcat tg account status --json` shows the link and history progress. Your own chat with the owner is never collected. You can only read: nothing can be sent from the owner's account.
