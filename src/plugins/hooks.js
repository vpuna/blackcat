// Asking every part and plugin the same thing: each that has the hook answers.

// Call a hook on every loaded plugin and part that has it. → what each returned
export async function eachHook(hook, arg) {
  const { loaded, makeCtx } = await import('./registry.js');
  const out = [];
  for (const p of loaded()) {
    if (!p.manifest[hook]) continue;
    out.push((await p.manifest[hook](makeCtx(p, { caller: 'owner', surface: 'job' }), arg)) ?? []);
  }
  return out;
}
