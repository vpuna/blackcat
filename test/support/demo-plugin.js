// A plugin written the way someone else's would be, used by the end-to-end bot tests: it
// has a setup form with every kind of question, a quick route, a command that notifies,
// a voice hook, and a screen of its own with a button.
export const DEMO_PLUGIN = `
export default {
  api: 1, name: 'demo', title: 'Demo', description: 'a plugin for the tests',
  commands: {
    hello: { summary: 'says hello', access: 'allow', run: () => 'hello from demo' },
    picture: { summary: 'fetches a picture', access: 'allow', sends: true, usage: '[what...]',
      run: async (ctx, i) => { i.what = (i.what ?? []).join(' ') || undefined; if (i.what === 'nothing') ctx.fail('There is no picture of nothing.'); const fs = await import('node:fs'); const path = await import('node:path'); const dir = path.join(process.env.BLACKCAT_HOME, 'data/demo-media'); fs.mkdirSync(dir, { recursive: true }); const file = path.join(dir, 'picture.txt'); fs.writeFileSync(file, 'a picture of ' + (i.what ?? 'the sky')); return { text: 'Saved ' + file, data: { path: file, caption: 'A picture of ' + (i.what ?? 'the sky') } }; } },
    change: { summary: 'changes something', access: 'ask', run: (ctx) => { ctx.config.set({ changed: true }); return 'changed it'; } },
    slow: { summary: 'takes a while', access: 'allow', long: true, usage: '<seconds>', run: async (ctx, i) => { await new Promise((r) => setTimeout(r, Number(i.seconds) * 1000)); return 'slow is done'; } },
    notify: { summary: 'tells the owner something', access: 'allow', run: async (ctx) => ((await ctx.notify('a note from the demo plugin')) ? 'told' : 'could not tell') },
    setup: {
      summary: 'set the demo up',
      access: 'ask',
      form: [
        { type: 'note', message: 'This is the demo setup.' },
        { id: 'name', type: 'text', message: 'What is it called?', default: (a, ctx) => ctx.config.get().name ?? 'kettle' },
        { id: 'key', type: 'secret', message: 'Its secret key', keep: true },
        { id: 'size', type: 'select', message: 'How big?', default: (a, ctx) => ctx.config.get().size ?? 'm', options: [{ value: 's', label: 'Small' }, { value: 'm', label: 'Medium', hint: 'the usual' }, { value: 'l', label: 'Large' }] },
        { id: 'loud', type: 'confirm', message: 'Make it loud?', default: (a, ctx) => ctx.config.get().loud, when: (a) => a.size !== 's' },
      ],
      run: (ctx, a) => { ctx.config.set({ name: a.name, size: a.size, loud: a.loud }); if (a.key) ctx.secrets.set('key', a.key); return 'Saved: ' + a.name + ', ' + a.size + ', ' + (a.loud ? 'loud' : 'quiet') + ', key of ' + ctx.secrets.get('key').length + ' characters.'; },
    },
  },
  agent: { readDirs: () => [process.env.BLACKCAT_HOME + '/data/demo-media'] },
  chat: {
    commands: [{ command: 'demoscreen', description: 'The demo screen' }],
    install: (ui) => {
      const B = (label, id) => ({ label, id });
      ui.command('demoscreen', (c) => c.reply('<b>Demo</b> screen', { html: true, actions: [[B('Press me', 'demo:press'), B('Clear', 'demo:clear')]] }));
      ui.action('demo:press', async (c) => { await c.toast('pressed'); await c.edit('Pressed at last', { actions: [[B('Again', 'demo:press')]] }); });
      ui.action('demo:clear', (c) => c.clearActions());
    },
    quick: async (text) => {
      if (text === 'demo quick') return { text: 'done quickly', note: 'the demo did something quick' };
      if (text === 'demo careful') return { confirm: 'Really do the careful thing?', run: async () => ({ text: 'did the careful thing' }) };
      return null;
    },
    voice: async () => ({ text: 'demo quick', seconds: 2, took: 1 }),
  },
};`;

// A stand-in for \`claude\` that behaves like one in the ways the bot cares about. What it
// does depends on what the owner wrote (the last line of what it was sent):
//   "please delete …"   asks permission to run a delete, and says how it went
//   "send it back"      replies with a [[send: …]] line for the first file it was told about
//   "long please"       replies with about 9,000 characters
//   anything else       "echo: <that line>"
// Everything it was sent is appended to sent.log beside it.
export const CLAUDE = (logFile) => `
import fs from 'node:fs'; import readline from 'node:readline';
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const args = process.argv.slice(2);
const session = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : 'sess-' + process.pid;
const waiting = new Map();
fs.appendFileSync(${JSON.stringify(logFile + '.starts')}, process.pid + '\\n'); // that it was started, and when
let n = 0; let total = 0;
const done = (result) => out({ type: 'result', is_error: false, result, session_id: session, total_cost_usd: 0.01 * ++total, duration_api_ms: 5 * total, usage: { input_tokens: 1, output_tokens: 1 } });
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.type === 'control_response') return void waiting.get(m.response?.request_id)?.(m.response?.response);
  if (m.type !== 'user') return;
  if (++n === 1) out({ type: 'system', subtype: 'init' });
  const text = typeof m.message.content === 'string' ? m.message.content : JSON.stringify(m.message.content);
  fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ session, text }) + '\\n');
  const last = text.split('\\n').at(-1);
  if (/please delete/.test(last)) {
    const input = { command: 'rm -rf /tmp/blackcat-test-target' };
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't' + n, name: process.argv.includes('--mcp-config') ? 'mcp__blackcat__bash' : 'Bash', input }] } });
    // Started with blackcat's tools (the usual way): the command is a call to blackcat's
    // bash tool, which asks the owner and runs it. Started the earlier way: it asks first.
    const served = process.argv.includes('--mcp-config');
    const request = served ? { subtype: 'mcp_message', server_name: 'blackcat', message: { jsonrpc: '2.0', id: n, method: 'tools/call', params: { name: 'bash', arguments: input } } }
      : { subtype: 'can_use_tool', tool_name: 'Bash', input, tool_use_id: 't' + n };
    const answer = await new Promise((resolve) => { waiting.set('r' + n, resolve); out({ type: 'control_request', request_id: 'r' + n, request }); });
    const allowed = served ? !answer.mcp_response?.result?.isError : answer.behavior === 'allow';
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't' + n, is_error: !allowed, content: '' }] } });
    return done(allowed ? 'It is deleted.' : 'I did not delete it.');
  }
  if (/send it back/.test(last)) return done('Here it is.\\n[[send: ' + (/^- (\\S+) \\(/m.exec(text)?.[1] ?? '/nowhere') + ']]');
  if (/long please/.test(last)) return done(Array.from({ length: 90 }, (_, i) => 'line ' + i + ' ' + 'x'.repeat(90)).join('\\n'));
  done('echo: ' + last);
});`;
