// What went wrong in a way the person can do something about: its message is put to them as
// it is, not as a stack trace. `ctx.fail(message)` throws one; a plugin's own kind of error
// may extend it.
export class PluginError extends Error {}
