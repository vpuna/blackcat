#!/usr/bin/env node
// A stand-in for `claude` in a chat session: it plays one scripted turn, asking permission
// for three commands the way Claude Code does, and ends with a usage report.
import readline from 'node:readline';

const out = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const waiting = new Map();
const rl = readline.createInterface({ input: process.stdin });
const ask = (id, tool, input, withId) =>
  new Promise((resolve) => {
    waiting.set(`r${id}`, resolve);
    out({
      type: 'control_request',
      request_id: `r${id}`,
      request: { subtype: 'can_use_tool', tool_name: tool, input, ...(withId ? { tool_use_id: id } : {}) },
    });
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let turns = 0;
async function turn() {
  turns++;
  if (turns > 1) {
    // A later turn in the same conversation: no commands, and the cost reported is the total so far.
    return out({
      type: 'result',
      is_error: false,
      result: 'PRIVATE REPLY',
      session_id: 'sess-1',
      duration_ms: 300,
      num_turns: 1,
      stop_reason: 'end_turn',
      total_cost_usd: 0.05 + 0.02 * (turns - 1),
      usage: { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 30100, output_tokens: 40 },
      modelUsage: { 'claude-opus-5-5': { costUSD: 0.05 + 0.02 * (turns - 1), contextWindow: 1000000 } },
    });
  }
  out({ type: 'system', subtype: 'init' });
  const calls = [
    ['t1', 'Bash', { command: "blackcat watch show 'the PRIVATE QUESTION watch' --status new --json" }, true],
    ['t2', 'Bash', { command: 'rm -rf /tmp/some-folder' }, false], // no id on the request: matched by its content
    ['t3', 'Bash', { command: 'cat /home/someone/.ssh/id_ed25519' }, true],
    ['t4', 'Read', { file_path: '/etc/hostname' }, true],
  ];
  for (const [id, tool, input, withId] of calls) {
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: tool, input }] } });
    const res = await ask(id, tool, input, withId);
    await sleep(30);
    const allowed = res.response?.response?.behavior === 'allow';
    out({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: id, is_error: !allowed, content: allowed ? 'PRIVATE RESULT CONTENT' : 'denied' }],
      },
    });
  }
  out({
    type: 'result',
    is_error: false,
    result: 'PRIVATE REPLY',
    session_id: 'sess-1',
    duration_ms: 900,
    duration_api_ms: 700,
    num_turns: 5,
    stop_reason: 'end_turn',
    total_cost_usd: 0.05,
    usage: { input_tokens: 20, cache_creation_input_tokens: 100, cache_read_input_tokens: 30000, output_tokens: 300 },
    modelUsage: { 'claude-opus-5-5': { costUSD: 0.05, contextWindow: 1000000 } },
  });
}

rl.on('line', (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.type === 'control_response') return void waiting.get(m.response?.request_id)?.(m);
  if (m.type === 'user') turn();
});
