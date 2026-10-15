// A stand-in for Telegram's Bot API, so the real bot can be driven end to end in a test:
// say something as the owner, tap a button, and see exactly what the bot sent, edited or
// deleted. It speaks just enough of the API for what blackcat uses.
import http from 'node:http';

export async function fakeTelegram({ owner = { id: 42, first_name: 'Ana' } } = {}) {
  const calls = []; // every API call the bot made: { method, ...params }
  const updates = []; // waiting to be handed to the bot
  const files = new Map(); // file_id → { path, body }
  const messages = new Map(); // message_id → what it currently shows { text, markup, deleted }
  const waiters = [];
  let updateId = 1;
  let messageId = 100;
  let hang = null; // a getUpdates call waiting for something to hand over

  const flush = () => {
    if (!hang || !updates.length) return;
    const { res, timer } = hang;
    hang = null;
    clearTimeout(timer);
    res.end(JSON.stringify({ ok: true, result: updates.splice(0) }));
  };
  const note = (call) => {
    calls.push(call);
    for (const w of [...waiters]) {
      if (!w.test(call)) continue;
      waiters.splice(waiters.indexOf(w), 1);
      clearTimeout(w.timer);
      w.resolve(call);
    }
  };

  // What the bot sent is multipart when it carries a file: pull the plain fields out.
  const fields = (req, body) => {
    const type = req.headers['content-type'] ?? '';
    if (type.includes('application/json')) return body.length ? JSON.parse(body.toString('utf8')) : {};
    const out = {};
    const boundary = /boundary=(.+)$/.exec(type)?.[1];
    if (!boundary) return out;
    for (const part of body.toString('latin1').split(`--${boundary}`)) {
      const name = /name="([^"]+)"/.exec(part)?.[1];
      if (!name) continue;
      const value = part.slice(part.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, '');
      if (/filename="/.test(part)) out[name] = { file: /filename="([^"]*)"/.exec(part)[1], bytes: value.length };
      else out[name] = /^[[{]/.test(value) ? JSON.parse(value) : value;
    }
    return out;
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const file = /^\/file\/bot[^/]+\/(.+)$/.exec(req.url);
      if (file) {
        const f = [...files.values()].find((x) => x.path === file[1]);
        res.writeHead(f ? 200 : 404);
        return res.end(f?.body ?? '');
      }
      const method = /^\/bot[^/]+\/(\w+)/.exec(req.url)?.[1];
      res.setHeader('content-type', 'application/json');
      if (!method) return res.end(JSON.stringify({ ok: false, error_code: 404, description: 'Not Found' }));
      let p = {};
      try {
        p = fields(req, Buffer.concat(chunks));
      } catch {}
      const ok = (result) => res.end(JSON.stringify({ ok: true, result }));

      if (method === 'getUpdates') {
        if (updates.length) return ok(updates.splice(0));
        const timer = setTimeout(
          () => {
            hang = null;
            ok([]);
          },
          Math.min((p.timeout ?? 1) * 1000, 2000),
        );
        hang = { res, timer };
        return undefined;
      }
      if (method === 'getMe')
        return ok({
          id: 7,
          is_bot: true,
          first_name: 'blackcat',
          username: 'BlackCatTestBot',
          can_join_groups: false,
          can_read_all_group_messages: false,
          supports_inline_queries: false,
        });
      if (method === 'getFile') {
        const f = files.get(p.file_id);
        return f
          ? ok({ file_id: p.file_id, file_unique_id: p.file_id, file_path: f.path, file_size: f.body.length })
          : res.end(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: file not found' }));
      }
      if (/^send(Message|Photo|Document|Video)$/.test(method)) {
        // (As Telegram does: a message of more than 4096 characters, or a caption of more than 1024, is refused.)
        if ((p.text ?? '').length > 4096 || (p.caption ?? '').length > 1024)
          return res.end(
            JSON.stringify({ ok: false, error_code: 400, description: `Bad Request: message ${p.caption ? 'caption ' : ''}is too long` }),
          );
        const id = ++messageId;
        messages.set(id, { text: p.text ?? p.caption ?? '', markup: p.reply_markup ?? null, method });
        note({ method, ...p, sentAs: id }); // `sentAs`: the id Telegram gave it
        return ok({ message_id: id, date: Math.floor(Date.now() / 1000), chat: { id: Number(p.chat_id), type: 'private' }, text: p.text });
      }
      note({ method, ...p });
      if (method === 'editMessageText') {
        if ((p.text ?? '').length > 4096)
          return res.end(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: message is too long' }));
        const m = messages.get(Number(p.message_id));
        if (m) Object.assign(m, { text: p.text, markup: p.reply_markup ?? null });
        return ok(true);
      }
      if (method === 'editMessageReplyMarkup') {
        const m = messages.get(Number(p.message_id));
        if (m) m.markup = p.reply_markup ?? null;
        return ok(true);
      }
      if (method === 'deleteMessage') {
        const m = messages.get(Number(p.message_id));
        if (m) m.deleted = true;
        return ok(true);
      }
      return ok(true); // sendChatAction, answerCallbackQuery, setMyCommands, deleteWebhook, …
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const push = (u) => {
    updates.push({ update_id: updateId++, ...u });
    flush();
  };
  const chatOf = (from) => ({ id: from.id, type: 'private', first_name: from.first_name });
  const buttonsOf = (markup) => (markup?.inline_keyboard ?? []).flat();

  const api = {
    url: `http://127.0.0.1:${server.address().port}`,
    owner,
    calls,
    // The owner (or `from` someone else) writes something. → the message's id.
    say(text, { from = owner, extra = {} } = {}) {
      const id = ++messageId;
      const entities = text?.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(/\s/)[0].length }] : undefined;
      push({
        message: {
          message_id: id,
          date: Math.floor(Date.now() / 1000),
          chat: chatOf(from),
          from: { ...from, is_bot: false },
          ...(text == null ? {} : { text }),
          ...(entities ? { entities } : {}),
          ...extra,
        },
      });
      messages.set(id, { text, mine: true });
      return id;
    },
    // The owner sends a file (a document), optionally with words.
    sendFile(name, body, { caption, from = owner, extra = {} } = {}) {
      const fileId = `file-${files.size + 1}`;
      files.set(fileId, { path: `documents/${name}`, body: Buffer.from(body) });
      return api.say(null, {
        from,
        extra: {
          document: {
            file_id: fileId,
            file_unique_id: fileId,
            file_name: name,
            mime_type: 'application/octet-stream',
            file_size: Buffer.byteLength(body),
          },
          ...(caption ? { caption } : {}),
          ...extra,
        },
      });
    },
    // The owner sends a voice note.
    sendVoice(body = 'ogg', { from = owner, extra = {} } = {}) {
      const fileId = `voice-${files.size + 1}`;
      files.set(fileId, { path: `voice/${fileId}.oga`, body: Buffer.from(body) });
      return api.say(null, {
        from,
        extra: {
          voice: { file_id: fileId, file_unique_id: fileId, duration: 2, mime_type: 'audio/ogg', file_size: Buffer.byteLength(body) },
          ...extra,
        },
      });
    },
    // The owner taps a button: `button` is its label (or part of it) on the message `sent`
    // (a sendMessage call, or a message id).
    tap(sent, button, { from = owner } = {}) {
      const id = typeof sent === 'number' ? sent : api.idOf(sent);
      const m = messages.get(id);
      const b = buttonsOf(m?.markup).find((x) => x.text === button || x.text.includes(button));
      if (!b) throw new Error(`no button "${button}" on message ${id}: ${JSON.stringify(buttonsOf(m?.markup).map((x) => x.text))}`);
      push({
        callback_query: {
          id: String(updateId),
          from: { ...from, is_bot: false },
          chat_instance: '1',
          data: b.callback_data,
          // (As Telegram sends it: the message tapped on, with its buttons.)
          message: { message_id: id, date: 0, chat: chatOf(from), text: m.text, reply_markup: m.markup },
        },
      });
    },
    // The id Telegram gave a message the bot sent.
    idOf: (call) => call?.sentAs ?? null,
    // What a message shows now (after any edits): { text, buttons: [labels], deleted }.
    shows(sentOrId) {
      const m = messages.get(typeof sentOrId === 'number' ? sentOrId : api.idOf(sentOrId));
      return m ? { text: m.text, buttons: buttonsOf(m.markup).map((b) => b.text), deleted: !!m.deleted } : null;
    },
    // Wait for the bot to make a call that fits. `test`: a method name, or a function of the call.
    next(test, { ms = 15_000, after = calls.length } = {}) {
      const fits = typeof test === 'string' ? (c) => c.method === test : test;
      const had = calls.slice(after).find(fits);
      if (had) return Promise.resolve(had);
      return new Promise((resolve, reject) => {
        const w = { test: fits, resolve };
        w.timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(w), 1);
          reject(
            new Error(
              `the bot did not do that within ${ms / 1000}s. Since then it did: ${JSON.stringify(calls.slice(after).map((c) => [c.method, String(c.text ?? c.caption ?? '').slice(0, 60)]))}`,
            ),
          );
        }, ms);
        waiters.push(w);
      });
    },
    // Say something and wait for the next message the bot sends in answer.
    async ask(text, opts) {
      const after = calls.length;
      api.say(text, opts);
      return api.next('sendMessage', { after, ...opts });
    },
    // Everything the bot has said since `after` (text of each message sent).
    said: (after = 0) =>
      calls
        .slice(after)
        .filter((c) => c.method === 'sendMessage')
        .map((c) => c.text),
    mark: () => calls.length,
    buttons: (call) => buttonsOf(call.reply_markup).map((b) => b.text),
    close: () =>
      new Promise((resolve) => {
        if (hang) (clearTimeout(hang.timer), hang.res.end(JSON.stringify({ ok: true, result: [] })));
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
  return api;
}
