#!/usr/bin/env node
// A stand-in for `claude` started with no tools of its own and blackcat's served to it over
// the pipe. It speaks Claude Code's side of that: it asks the tool server what it has, and
// for a message with lines of the form
//   DO <tool> <json input>
// it calls each tool in turn and answers with what came back. It notes how it was started.
import fs from 'node:fs';
import readline from 'node:readline';

const args = process.argv.slice(2);
if (args[0] === 'auth') {
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'test' }));
  process.exit(0);
}
const out = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const after = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const server = Object.keys(JSON.parse(after('--mcp-config') ?? '{"mcpServers":{}}').mcpServers)[0] ?? null;
if (process.env.FAKE_CLAUDE_LOG)
  fs.appendFileSync(
    process.env.FAKE_CLAUDE_LOG,
    `${JSON.stringify({ args, server, tools: after('--tools'), allowed: after('--allowedTools') })}\n`,
  );

const waiting = new Map();
let n = 0;
const ask = (request) =>
  new Promise((resolve) => {
    const id = `r${++n}`;
    waiting.set(id, resolve);
    out({ type: 'control_request', request_id: id, request });
  });
const rpc = async (method, params) =>
  (await ask({ subtype: 'mcp_message', server_name: server, message: { jsonrpc: '2.0', id: ++n, method, ...(params ? { params } : {}) } }))
    .response?.response?.mcp_response;

let offered = [];
let told = false;
async function hello() {
  if (!server) return;
  await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fake-claude' } });
  out({
    type: 'control_request',
    request_id: `n${++n}`,
    request: { subtype: 'mcp_message', server_name: server, message: { jsonrpc: '2.0', method: 'notifications/initialized' } },
  });
  offered = (await rpc('tools/list')).result.tools.map((t) => t.name);
}
const ready = hello();

let turns = 0;
async function turn(text) {
  await ready;
  if (!told) {
    told = true;
    out({ type: 'system', subtype: 'init', tools: offered.map((t) => `mcp__${server}__${t}`) });
  }
  turns++;
  const said = [];
  let k = 0;
  for (const line of String(text).split('\n')) {
    const m = /^DO (\w+) (.*)$/.exec(line);
    if (!m) continue;
    const id = `toolu_${turns}_${++k}`;
    const input = JSON.parse(m[2]);
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: `mcp__${server}__${m[1]}`, input }] } });
    const r = (await rpc('tools/call', { name: m[1], arguments: input })).result;
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: !!r.isError, content: r.content }] } });
    said.push(`${m[1]}${r.isError ? ' FAILED' : ''}: ${r.content.map((c) => c.text ?? `[${c.type} ${c.mimeType}]`).join(' ')}`);
  }
  out({
    type: 'result',
    is_error: false,
    result: said.length ? said.join('\n---\n') : `heard: ${String(text).split('\n').at(-1)}`,
    session_id: 'sess-served',
    duration_ms: 20,
    duration_api_ms: 10,
    num_turns: k + 1,
    total_cost_usd: 0.01 * turns,
    usage: { input_tokens: 5, output_tokens: 7 },
    modelUsage: { 'claude-test': { costUSD: 0.01 * turns, contextWindow: 1000 } },
  });
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.type === 'control_response') return void waiting.get(m.response?.request_id)?.(m);
  if (m.type === 'control_request')
    return void out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
  if (m.type === 'user') turn(m.message.content);
});
