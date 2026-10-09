// A second engine, nothing to do with Claude Code, written as a plugin anyone could write.
// It runs in this process and does what its message tells it to, the way a model would:
//   DO <Tool> <json input>     ask for something to be done (one per line)
//   anything else              is answered with what it was given
// What it "does" is written to a file ONLY when blackcat said it may: so a test can tell
// what was really carried out from what was only asked for.
export const parrotPlugin = ({ doneLog, startsLog }) => `
import fs from 'node:fs';
const note = (file, o) => fs.appendFileSync(file, JSON.stringify(o) + '\\n');
let n = 0;
export default {
  api: 1, name: 'parrot', title: 'Parrot', description: 'a test engine',
  commands: { hello: { summary: 'says hello', access: 'allow', run: () => 'hello' } },
  engine: {
    label: 'Parrot',
    choices: () => ({ models: [{ id: 'grey', label: 'Grey' }, { id: 'green', label: 'Green' }], options: [{ id: 'volume', label: 'How loud', values: ['soft', 'loud'] }],
      defaults: { chat: { model: 'grey' }, readers: { model: 'green', options: { volume: 'soft' } } } }),
    ready: async () => ({ ok: true, detail: 'perched' }),
    where: () => 'in this process',
    has: () => false, // it keeps nothing of a conversation itself: blackcat's record is what carries one on
    converse: async (ctx, spec, on) => {
      const id = 'parrot-' + (++n);
      note(${JSON.stringify(startsLog)}, { id, model: spec.model, options: spec.options, tools: spec.tools, resume: spec.resume ?? null, env: spec.env, instructions: spec.instructions.generated.length });
      let closed = false;
      queueMicrotask(() => on.ready());
      return {
        get closed() { return closed; },
        async send(text) {
          let k = 0;
          const said = [];
          for (const line of String(text).split('\\n')) {
            const m = /^DO (\\w+) (.*)$/.exec(line);
            if (!m) continue;
            const call = { id: id + '-' + (++k), tool: m[1], input: JSON.parse(m[2]) };
            on.toolUse(call);
            const d = await on.request({ tool: call.tool, input: call.input, toolUseId: call.id });
            if (d.allow) note(${JSON.stringify(doneLog)}, { tool: call.tool, input: call.input });
            on.toolResult({ id: call.id, isError: !d.allow });
            said.push(d.allow ? 'did ' + call.tool : 'refused ' + call.tool + ': ' + d.message);
          }
          on.result({ text: said.length ? said.join(' | ') : 'parrot heard: ' + text, isError: false, sessionId: id,
            usage: { ok: true, model: 'parrot-' + (spec.model ?? 'none'), tokensIn: 10, tokensOut: 5, cacheRead: 0, cacheWrite: 0, cost: null, data: { steps: k + 1 } } });
        },
        stop() { if (closed) return; closed = true; on.exit({ code: 0, stderr: '' }); },
      };
    },
    // One question. It is given no tools, and there is no way to give it any.
    ask: async (ctx, spec) => ({ text: 'parrot read ' + (typeof spec.content === 'string' ? spec.content.length : 'a file') + ' with ' + spec.model + ' ' + JSON.stringify(spec.options) + ' keys:' + Object.keys(spec).sort().join(','), isError: false,
      usage: { ok: true, model: 'parrot-' + spec.model, tokensIn: 7, tokensOut: 3, cacheRead: 0, cacheWrite: 0, cost: null, data: {} } }),
  },
};
`;
