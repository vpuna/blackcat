// What a plugin adds to the chat, whichever channel is in use: `chat` in its manifest.
//
//   chat: {
//     commands: [{ command, description }] | (ctx) => [...],   shown in /help and the channel's menu
//     install: (ui, { ctx }) => { ui.command(…); ui.action(…) },  once, when the agent service starts
//     tick: (ui, s) => { … },          every scheduler tick; ui is null when no channel is active
//                                      (s.chat is the owner's chat, for what you send them by yourself)
//     quick: (text, { ctx }) => null | { text, note? } | { confirm, run },   answer without the agent
//   }
export const chatHooks = (p) => p.manifest.chat ?? {};
