// Starting Claude Code and talking to it: a conversation that is kept running and fed
// messages (the chat agent), and one question with no tools (a reader).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { usageOf } from './usage.js';

const ONE_QUESTION_MS = 5 * 60_000;

// What the owner set for this engine, as the environment Claude Code is started with:
// another place for the model to be (a model served on this network, say), and its key.
export function environment(ctx, extra = {}) {
  const s = ctx.config.get();
  const env = { ...process.env, ...extra };
  // What the agent remembers is blackcat's to keep (src/memory): Claude Code's own memory is off.
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  for (const k of Object.keys(env)) if (env[k] == null) delete env[k]; // undefined: not to be set at all
  if (s.endpoint) env.ANTHROPIC_BASE_URL = s.endpoint;
  const key = ctx.secrets.get('key');
  if (key) env.ANTHROPIC_AUTH_TOKEN = key;
  return env;
}

// The model and options, as arguments.
// (`tools` is an option too, but of how Claude Code is started, not something to pass on.)
const chosen = ({ model, options } = {}) => [
  ...(model ? ['--model', model] : []),
  ...(options?.effort ? ['--effort', options.effort] : []),
];

// Whose tools the model is given, and who is in charge of each call (the `tools` option,
// chosen like the model: bc engine setup --tools …):
//   supervised  Claude Code's own tools, and it must ask blackcat about EVERY call (a hook of
//               Claude Code's sees to that). blackcat's policy judges each one; Claude Code
//               carries it out. The usual way: it costs next to nothing in speed.
//   blackcat    none of Claude Code's tools: blackcat serves its own, so a call arrives in
//               blackcat, is judged there and is carried out there. Nothing rests on Claude
//               Code asking. The model's servers take about a fifth of a second longer over
//               each step when a served tool is present.
//   engine      Claude Code's own tools, asking as it sees fit: what it takes to be a plain
//               look (the date, a file in the agent's folder) it runs unasked. How it was.
export const MODES = ['supervised', 'blackcat', 'engine'];
export const modeOf = (spec) => (MODES.includes(spec?.options?.tools) ? spec.options.tools : 'supervised');
export const served = (spec) => !!spec.serve && modeOf(spec) === 'blackcat';

// The hook that makes Claude Code ask about every tool call, whatever it would have let
// through itself: its answer to "may this tool be used?" is always "ask", and asking goes
// to blackcat (--permission-prompt-tool stdio).
const ALWAYS_ASK = JSON.stringify({
  hooks: {
    PreToolUse: [
      {
        matcher: '*',
        hooks: [
          {
            type: 'command',
            command: `printf '%s' '${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'blackcat decides' } })}'`,
          },
        ],
      },
    ],
  },
});

// What the agent is told (its rules, what is true of this installation, what it remembers), as one text
// for Claude Code's system prompt. Nothing is left for Claude Code to find in a file.
const told = (i) => [i?.rules, i?.generated, i?.memory].filter(Boolean).join('\n\n');

// How a conversation is started. (Exported so a test can start Claude exactly as blackcat does.)
export function conversationArgs({ tools, readDirs = [], resume, model, options, instructions, serve, askAlways = false }) {
  const common = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    // Skip the claude.ai connectors (Gmail, Drive, ...): they slow startup, change the
    // prompt on every start (defeating prompt caching), and would widen what it can reach.
    '--strict-mcp-config',
    // Anything not already allowed is sent to blackcat as a request instead of being
    // refused, so blackcat's policy decides, and can ask the owner.
    '--permission-prompt-tool',
    'stdio',
    ...(resume ? ['--resume', resume] : []),
    ...chosen({ model, options }),
  ];
  if (serve) {
    return [
      ...common,
      // None of its own tools: no shell, no file access, no web, no sub-agents.
      '--tools',
      '',
      // blackcat's, served over this same pipe (an "sdk" server: no port, no other process).
      '--mcp-config',
      JSON.stringify({ mcpServers: { [serve.name]: { type: 'sdk', name: serve.name } } }),
      // Calling one needs no leave from Claude Code: the leave is blackcat's, given or refused at the call.
      '--allowedTools',
      `mcp__${serve.name}`,
      '--append-system-prompt',
      told(instructions),
    ];
  }
  return [
    ...common,
    // The only built-in tools the agent gets. Everything else is removed outright, not just
    // left to fail a permission check: no web access, no sub-agents, no scheduling.
    '--tools',
    tools.join(','),
    ...(askAlways ? ['--settings', ALWAYS_ASK] : []),
    ...readDirs.flatMap((d) => ['--add-dir', d]),
    '--append-system-prompt',
    told(instructions),
  ];
}

// A conversation. `spec`: what blackcat wants of it; `on`: what blackcat is told.
//   on.ready()                                Claude Code has started the conversation
//   on.toolUse({ id, tool, input })           the model has asked for something to be done
//   on.request({ tool, input, toolUseId }) → { allow, message }   may it? (blackcat's policy, and the owner)
//   on.toolResult({ id, isError })            it was done, or was not
//   on.result({ text, isError, sessionId, usage, running })   the turn is over
//   on.exit({ code, stderr })                 the process has gone
export function converse(ctx, spec, on) {
  // Started in the agent's own folder, which is where a command it runs begins. (The rules are
  // not read from there by Claude Code: blackcat hands them over, with the rest it is told.)
  const serve = served(spec) ? spec.serve : null;
  const ours = serve ? `mcp__${serve.name}__` : null;
  const foreign = new Set(); // calls to a tool that is not blackcat's, should there ever be one
  const proc = spawn('claude', conversationArgs({ ...spec, serve, askAlways: modeOf(spec) === 'supervised' }), {
    cwd: spec.workdir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: environment(ctx, spec.env),
  });
  let closed = false;
  let stderr = '';
  let buf = '';
  const write = (m) => closed || proc.stdin.write(`${JSON.stringify(m)}\n`);

  async function request(m) {
    const answer = (response) => write({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response } });
    const r = m.request ?? {};
    // A message for blackcat's tool server: hand it over, and send back what it says.
    if (r.subtype === 'mcp_message') {
      if (!serve || r.server_name !== serve.name)
        return answer({ mcp_response: { jsonrpc: '2.0', id: r.message?.id ?? 0, error: { code: -32601, message: 'no such server' } } });
      const out = await serve
        .handle(r.message)
        .catch((e) => ({ jsonrpc: '2.0', id: r.message?.id ?? 0, error: { code: -32603, message: e.message } }));
      return answer({ mcp_response: out ?? { jsonrpc: '2.0', id: 0, result: {} } });
    }
    if (r.subtype !== 'can_use_tool') return answer({ behavior: 'deny', message: 'Not supported.' });
    if (serve) {
      // One of blackcat's own tools: the decision is made where the call arrives, not here.
      // Anything else is not something this conversation has.
      return answer(
        String(r.tool_name).startsWith(ours)
          ? { behavior: 'allow', updatedInput: r.input }
          : { behavior: 'deny', message: 'That tool is not available.' },
      );
    }
    let d;
    try {
      d = await on.request({ tool: r.tool_name, input: r.input, toolUseId: r.tool_use_id });
    } catch (e) {
      d = { allow: false, message: `Not allowed: ${e.message}` };
    }
    return answer(d.allow ? { behavior: 'allow', updatedInput: r.input } : { behavior: 'deny', message: d.message ?? 'Not allowed.' });
  }

  function line(text) {
    let m;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (m.type === 'system' && m.subtype === 'init') on.ready?.();
    if (m.type === 'assistant') {
      for (const b of m.message?.content ?? []) {
        if (b.type !== 'tool_use') continue;
        // A call to one of blackcat's tools is seen, judged and recorded where it arrives.
        // Only a call to something else is reported here: there should be none.
        if (ours && String(b.name).startsWith(ours)) continue;
        if (ours) foreign.add(b.id);
        on.toolUse?.({ id: b.id, tool: b.name, input: b.input });
      }
    }
    if (m.type === 'user' && Array.isArray(m.message?.content)) {
      for (const b of m.message.content)
        if (b.type === 'tool_result' && (!ours || foreign.has(b.tool_use_id)))
          on.toolResult?.({ id: b.tool_use_id, isError: !!b.is_error });
    }
    if (m.type === 'control_request') return void request(m);
    if (m.type === 'result') {
      on.result?.({
        text: m.result ?? '',
        isError: !!m.is_error,
        sessionId: m.session_id ?? null,
        usage: usageOf(m),
        // Claude Code reports these two as totals for the whole of its conversation so far.
        running: { cost: m.total_cost_usd ?? null, apiMs: m.duration_api_ms ?? null },
      });
    }
    return undefined;
  }

  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const one = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (one) line(one);
    }
  });
  proc.stdin.on('error', () => {}); // surfaces through 'close' instead
  proc.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
  proc.on('error', (e) => on.error?.(new Error(`could not start claude: ${e.message}`)));
  proc.on('close', (code) => {
    closed = true;
    on.exit?.({ code, stderr: stderr.trim() });
  });

  // Tell Claude Code which servers are answered over this pipe.
  if (serve)
    write({ type: 'control_request', request_id: 'blackcat-init', request: { subtype: 'initialize', sdkMcpServers: [serve.name] } });

  return {
    pid: proc.pid,
    get closed() {
      return closed;
    },
    send: (text) => write({ type: 'user', message: { role: 'user', content: text } }),
    // Ask it to finish; if it has not gone in a moment, end it.
    stop() {
      if (closed) return;
      proc.stdin.end();
      setTimeout(() => closed || proc.kill('SIGTERM'), 5000).unref();
    },
  };
}

// One question with NO tools, and its answer. `content`: text, or content blocks (an image
// or a document, then the question). → { text, isError, usage } or throws.
// (`schema`: the shape the answer must have. Claude Code holds the model to it and hands back
// the object itself.)
export function ask(ctx, { system, content, model, options, schema }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--tools',
      '',
      '--strict-mcp-config',
      '--append-system-prompt',
      system,
      ...chosen({ model, options }),
      ...(schema ? ['--json-schema', JSON.stringify(schema)] : []),
    ];
    const child = spawn('claude', args, { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'], env: environment(ctx) });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), ONE_QUESTION_MS);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    child.stdin.on('error', () => {}); // a process that already went away: reported through 'close'
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(Object.assign(new Error(`could not start claude: ${e.message}`), { reason: 'could not start claude' }));
    });
    child.on('close', () => {
      clearTimeout(timer);
      let res = null;
      for (const l of out.split('\n')) {
        try {
          const m = JSON.parse(l);
          if (m.type === 'result') res = m;
        } catch {}
      }
      if (!res)
        return reject(
          Object.assign(new Error(`claude gave no usable answer: ${err.trim().slice(0, 200)}`), { reason: 'no usable answer' }),
        );
      return resolve({
        text: res.result ?? '',
        ...(schema && res.structured_output !== undefined ? { data: res.structured_output } : {}),
        isError: !!res.is_error,
        usage: usageOf(res),
      });
    });
    child.stdin.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`);
  });
}

// Where Claude Code keeps things for conversations started in a folder: its own copy of
// each, and the results of commands too long to hand over whole (which it then reads back
// in pieces, without asking: they are results of commands that were already allowed).
const slug = (workdir) => workdir.replace(/[^A-Za-z0-9]/g, '-');
const kept = (workdir) => [
  path.join(os.homedir(), '.claude/projects', slug(workdir)),
  path.join(os.tmpdir(), `claude-${os.userInfo().uid}`, slug(workdir)),
];

// Is this file one of those saved results? (…/<conversation>/tool-results/… or …/<conversation>/tasks/…)
export function ownResult(workdir, file) {
  const f = path.resolve(file);
  return kept(workdir).some(
    (d) => f.startsWith(d + path.sep) && /^[0-9a-f-]{36}\/(tool-results|tasks)\/[^/]+$/.test(f.slice(d.length + 1)),
  );
}

// Discard what Claude Code kept about conversations started in a folder (after a check,
// which starts them in a temporary one).
export function forget(workdir) {
  if (!/[A-Za-z0-9]/.test(workdir)) return;
  for (const dir of kept(workdir)) fs.rmSync(dir, { recursive: true, force: true });
}

// Does Claude Code still have its own copy of a conversation it held, started in `workdir`?
export const has = (sessionId, workdir) => fs.existsSync(path.join(os.homedir(), '.claude/projects', slug(workdir), `${sessionId}.jsonl`));

// Is it installed and signed in? → { ok, why?, detail? }
export function ready(ctx) {
  return new Promise((resolve) => {
    const child = spawn('claude', ['auth', 'status'], { stdio: ['ignore', 'pipe', 'pipe'], env: environment(ctx) });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve({ ok: false, why: 'Claude Code is not installed (the `claude` command was not found)' }));
    child.on('close', () => {
      try {
        const a = JSON.parse(out);
        resolve(
          a.loggedIn
            ? { ok: true, detail: `signed in (${a.authMethod})` }
            : { ok: false, why: 'not signed in → run `claude`, then /login' },
        );
      } catch {
        // With the model somewhere else (an endpoint and a key of the owner's), there is no sign-in to check.
        resolve(
          ctx.config.get().endpoint
            ? { ok: true, detail: `using ${ctx.config.get().endpoint}` }
            : { ok: false, why: 'not signed in → run `claude`, then /login' },
        );
      }
    });
  });
}
