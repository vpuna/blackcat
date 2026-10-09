// A second channel, for the tests: nothing but two files. What the owner "writes" is a line
// appended to in.jsonl; what blackcat "sends" is a line appended to out.jsonl. It has no
// buttons, no editing, no formatting, nothing: the least a channel can be. If reminders,
// approvals, setup and watches all work through it, the chat is not tied to Telegram.
export const FILE_CHANNEL = `
import fs from 'node:fs';
import path from 'node:path';
const dir = (ctx) => ctx.dataDir;
const paired = (ctx) => !!ctx.config.get().owner;
function carrier(ctx) {
  fs.mkdirSync(dir(ctx), { recursive: true });
  const out = path.join(dir(ctx), 'out.jsonl');
  let n = 0;
  return {
    label: 'the file channel',
    can: { maxChars: 500, ...(ctx.config.get().can ?? {}) },
    send: async (chat, m) => { fs.appendFileSync(out, JSON.stringify({ chat, ...m }) + '\\n'); return ++n; },
    sendFile: async (chat, file, o) => { fs.appendFileSync(out, JSON.stringify({ chat, file, caption: o?.caption ?? null }) + '\\n'); },
  };
}
export default {
  api: 1, name: 'filechan', title: 'File channel', description: 'a channel made of two files, for the tests',
  commands: { pair: { summary: 'pair it', access: 'owner', run: (ctx) => { ctx.config.set({ owner: { chat: 'me', name: 'Ana' } }); return 'paired'; } } },
  channel: {
    label: 'the file channel',
    paired,
    open: async (ctx) => carrier(ctx),
    start: async (ctx, host) => {
      const c = carrier(ctx);
      const file = path.join(dir(ctx), 'in.jsonl');
      let read = 0; let timer; let done;
      const poll = async () => {
        let lines = [];
        try { lines = fs.readFileSync(file, 'utf8').split('\\n').filter(Boolean); } catch {}
        for (const line of lines.slice(read)) {
          read++;
          const ev = JSON.parse(line);
          // Only the owner gets through: that is the channel's job.
          if (ev.from !== ctx.config.get().owner.chat) continue;
          await host.incoming({ chat: ev.from, who: 'Ana', ref: read, text: ev.text }).catch((e) => host.log('error: ' + e.message));
        }
      };
      return { ...c,
        run: () => new Promise((resolve) => { done = resolve; timer = setInterval(poll, 40); host.log('file channel running · paired: ' + ctx.config.get().owner.name); }),
        stop: () => { clearInterval(timer); done?.(); } };
    },
  },
};`;
