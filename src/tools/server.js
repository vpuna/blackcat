// The six tools, served to an engine the standard way (the Model Context Protocol: JSON-RPC
// messages). This is only the conversation: `initialize`, `tools/list`, `tools/call`. How
// the messages travel is the engine plugin's business (Claude Code takes them over the pipe
// it is already spoken to through; another engine may want a socket), and what a call does
// is the caller's: `call(name, args)` → { content, isError }, where the policy is asked and
// the work is done.
import { DEFS, SERVER_NAME } from './defs.js';

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export function toolServer({ call }) {
  return {
    name: SERVER_NAME,
    tools: DEFS.map((d) => d.name),
    // One message in → the answer to send back, or null when none is expected (a notification).
    async handle(msg) {
      const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
      const error = (code, message) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
      if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return error(-32600, 'not a request');
      if (msg.id === undefined) return null; // notifications/initialized, notifications/cancelled, …
      switch (msg.method) {
        case 'initialize':
          return reply({
            protocolVersion: VERSIONS.includes(msg.params?.protocolVersion) ? msg.params.protocolVersion : VERSIONS[0],
            capabilities: { tools: {} },
            serverInfo: { name: SERVER_NAME, version: '1' },
          });
        case 'ping':
          return reply({});
        case 'tools/list':
          return reply({ tools: DEFS });
        case 'tools/call': {
          const name = msg.params?.name;
          if (!DEFS.some((d) => d.name === name))
            return reply({ content: [{ type: 'text', text: `There is no tool called ${name}.` }], isError: true });
          try {
            const r = await call(name, msg.params?.arguments ?? {});
            return reply({ content: r.content, isError: !!r.isError });
          } catch (e) {
            // Never an unanswered call: the model is told, and carries on.
            return reply({ content: [{ type: 'text', text: `It failed: ${e.message}` }], isError: true });
          }
        }
        default:
          return error(-32601, `no such method: ${msg.method}`);
      }
    },
  };
}
