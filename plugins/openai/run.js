// The engine's work: blackcat holds the conversation itself and speaks to the model over the
// OpenAI chat API (`/v1/chat/completions`, with tools). The loop is short: send what was said
// and the tools, and while the model asks for a tool, hand the call to blackcat's tool server
// (which puts it to the policy and carries it out), send back what came of it, and ask again.
// Nothing is done here that the tool server did not do.
import { randomUUID } from 'node:crypto';
import { sleep } from '../../src/api.js';

// How long one request to the model may take: a local model reads a long prompt slowly.
const STEP_MS = 5 * 60_000;
// How many times the model may ask for tools in one turn before it is stopped.
const MAX_STEPS = 25;
// What the model may write in one step.
const MAX_OUT = 4096;
// About how many characters a token is, to judge how full a conversation is (on the safe side).
const CHARS_PER_TOKEN = 3;
const LEFT_OUT = '[An earlier result, left out to make room.]';

export const settings = (ctx) => ({
  endpoint: String(ctx.config.get().endpoint ?? '').replace(/\/+$/, ''),
  key: ctx.secrets.get('key') ?? null,
  context: Number(ctx.config.get().context) || null,
});

const headers = (key) => ({ 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) });

// One call to the server, tried again after a moment when it is busy or briefly away.
// → the JSON it answered, or throws with what it said.
async function call(ctx, route, { body, signal, ms = STEP_MS } = {}) {
  const { endpoint, key } = settings(ctx);
  if (!endpoint) throw Object.assign(new Error('no address is set: bc openai setup'), { reason: 'not set up' });
  for (let attempt = 0; ; attempt++) {
    const timeout = AbortSignal.timeout(ms);
    let res;
    try {
      res = await fetch(`${endpoint}${route}`, {
        method: body ? 'POST' : 'GET',
        headers: headers(key),
        body: body ? JSON.stringify(body) : undefined,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (e) {
      if (signal?.aborted) throw Object.assign(new Error('stopped'), { reason: 'stopped' });
      if (timeout.aborted) throw Object.assign(new Error(`no answer from ${endpoint} in ${ms / 1000} s`), { reason: 'no answer in time' });
      if (attempt < 2) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      throw Object.assign(new Error(`could not reach ${endpoint}: ${e.cause?.message ?? e.message}`), { reason: 'could not reach it' });
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    const text = await res.text();
    if (!res.ok)
      throw Object.assign(new Error(`${endpoint} said ${res.status}: ${text.slice(0, 300)}`), { reason: `refused (${res.status})` });
    try {
      return JSON.parse(text);
    } catch {
      throw Object.assign(new Error(`${endpoint} did not answer in JSON`), { reason: 'no usable answer' });
    }
  }
}

// The options the owner chose → what is added to a request. Thinking is switched with the
// chat template (llama.cpp, vLLM); it is sent only when chosen, as other servers refuse it.
const extras = (options = {}) =>
  options.thinking === 'off' || options.thinking === 'on' ? { chat_template_kwargs: { enable_thinking: options.thinking === 'on' } } : {};

// What the server reports of a request → blackcat's usage record.
function usageOf(r, ms, steps = 1) {
  const u = r?.usage ?? {};
  return {
    ok: true,
    model: r?.model ?? null,
    tokensIn: (u.prompt_tokens ?? 0) - (u.prompt_tokens_details?.cached_tokens ?? 0),
    tokensOut: u.completion_tokens ?? 0,
    cacheRead: u.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWrite: 0,
    cost: typeof u.cost === 'number' ? u.cost : null,
    data: { apiMs: ms, steps },
  };
}
const add = (a, b) => ({
  ...b,
  tokensIn: a.tokensIn + b.tokensIn,
  tokensOut: a.tokensOut + b.tokensOut,
  cacheRead: a.cacheRead + b.cacheRead,
  cost: a.cost == null && b.cost == null ? null : (a.cost ?? 0) + (b.cost ?? 0),
  data: { apiMs: a.data.apiMs + b.data.apiMs, steps: a.data.steps + b.data.steps },
});

// A reply's words, without the thinking some models write inline.
const wordsOf = (m) =>
  String(m?.content ?? '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .trim();

// A content block as blackcat gives it (Anthropic's shape) → the OpenAI one.
function part(b) {
  if (b.type === 'text') return { type: 'text', text: b.text };
  if (b.type === 'image' && b.source?.type === 'base64')
    return { type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } };
  throw Object.assign(new Error(`this engine can't be given a ${b.type}`), { reason: `no ${b.type}s` });
}
const contentOf = (content) => (typeof content === 'string' ? content : content.map(part));

// One question with NO tools. → { text, data?, isError, usage }
export async function ask(ctx, { system, content, model, options, schema }) {
  const t0 = Date.now();
  const r = await call(ctx, '/chat/completions', {
    body: {
      ...(model ? { model } : {}),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: contentOf(content) },
      ],
      max_tokens: MAX_OUT,
      ...(schema ? { response_format: { type: 'json_schema', json_schema: { name: 'answer', schema } } } : {}),
      ...extras(options),
    },
  });
  const text = wordsOf(r.choices?.[0]?.message);
  let data;
  if (schema)
    try {
      data = JSON.parse(text);
    } catch {}
  return { text, ...(data !== undefined ? { data } : {}), isError: false, usage: usageOf(r, Date.now() - t0) };
}

// Is the server there? → { ok, why?, detail? }
export async function ready(ctx) {
  const { endpoint } = settings(ctx);
  if (!endpoint) return { ok: false, why: 'no address is set: bc openai setup' };
  try {
    const r = await call(ctx, '/models', { ms: 10_000 });
    const n = r.data?.length ?? 0;
    return { ok: true, detail: `${endpoint}, serving ${n} model${n === 1 ? '' : 's'}` };
  } catch (e) {
    return { ok: false, why: e.message };
  }
}

// The models it serves, by name. → ['…'] (empty when it can't be asked)
export async function models(ctx) {
  try {
    return ((await call(ctx, '/models', { ms: 10_000 })).data ?? []).map((m) => m.id).filter(Boolean);
  } catch {
    return [];
  }
}

// How many tokens the server holds for a conversation, where it says (llama.cpp does). → number or null
export async function contextOf(ctx) {
  const { endpoint, key } = settings(ctx);
  try {
    const res = await fetch(`${endpoint.replace(/\/v1$/, '')}/props`, { headers: headers(key), signal: AbortSignal.timeout(10_000) });
    const p = await res.json();
    return Number(p.default_generation_settings?.n_ctx) || null;
  } catch {
    return null;
  }
}

// ---- the conversation ----
// Kept in the plugin's store, so that a conversation goes on after blackcat restarts:
// `conv:<id>` → { workdir, messages } (the system message first).
const keyOf = (id) => `conv:${id}`;

export const has = (ctx, sessionId) => !!sessionId && ctx.store.get(keyOf(sessionId)) !== undefined;

export function forget(ctx, workdir) {
  for (const k of ctx.store.keys()) if (k.startsWith('conv:') && ctx.store.get(k)?.workdir === workdir) ctx.store.delete(k);
}

// What the model is told: blackcat's rules, what is true of this installation, what it remembers,
// and the day (which a model can't know, and blackcat's text leaves to the engine).
const told = (i, now = new Date()) =>
  [
    i?.rules,
    i?.generated,
    i?.memory,
    `Today is ${now.toLocaleDateString('en-CA')} (${now.toLocaleDateString('en-GB', { weekday: 'long' })}).`,
  ]
    .filter(Boolean)
    .join('\n\n');

// The tools blackcat serves → the OpenAI shape.
async function toolsOf(serve) {
  const r = await serve.handle({ jsonrpc: '2.0', id: 'tools', method: 'tools/list' });
  return (r?.result?.tools ?? []).map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

const size = (messages) =>
  messages.reduce((n, m) => n + JSON.stringify(m.content ?? '').length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0) /
  CHARS_PER_TOKEN;

// A conversation too long for the model's context is made to fit: first the results of
// earlier commands are left out, oldest first, then the oldest exchanges are dropped whole
// (from one message of the owner's to the next). The system message and the turn in
// progress (from `from`, the owner's message that began it) are kept.
export function fit(messages, room, from = messages.length) {
  if (!room || size(messages) <= room) return messages;
  const out = messages.map((m) => ({ ...m }));
  let start = from;
  for (let i = 1; i < start && size(out) > room; i++) if (out[i].role === 'tool') out[i].content = LEFT_OUT;
  while (size(out) > room) {
    const next = out.findIndex((m, i) => i > 1 && m.role === 'user');
    if (next < 0 || next > start) break;
    out.splice(1, next - 1);
    start -= next - 1;
  }
  return out;
}

export async function converse(ctx, spec, on) {
  const serve = spec.serve;
  if (!serve) throw new Error('this engine works only with the tools blackcat serves');
  const tools = await toolsOf(serve);
  const kept = spec.resume ? ctx.store.get(keyOf(spec.resume)) : undefined;
  const sessionId = kept ? spec.resume : `oa-${randomUUID()}`;
  // (A conversation carried on is told today's date, and its instructions as they are now.)
  const messages = [{ role: 'system', content: told(spec.instructions) }, ...(kept?.messages.slice(1) ?? [])];
  const { context } = settings(ctx);
  const room = context ? context - MAX_OUT : null;
  let closed = false;
  let stop = new AbortController();
  queueMicrotask(() => on.ready());

  // One turn: what the owner said, and the steps until the model answers in words.
  async function turn(text) {
    const from = messages.length;
    messages.push({ role: 'user', content: text });
    let used = null;
    const t0 = Date.now();
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        const s0 = Date.now();
        const r = await call(ctx, '/chat/completions', {
          signal: stop.signal,
          body: {
            ...(spec.model ? { model: spec.model } : {}),
            messages: fit(messages, room, from),
            tools,
            max_tokens: MAX_OUT,
            ...extras(spec.options),
          },
        });
        const u = usageOf(r, Date.now() - s0);
        used = used ? add(used, u) : u;
        const m = r.choices?.[0]?.message ?? {};
        const calls = m.tool_calls ?? [];
        messages.push({ role: 'assistant', content: m.content ?? null, ...(calls.length ? { tool_calls: calls } : {}) });
        if (!calls.length) return finish({ text: wordsOf(m), usage: used });
        for (const c of calls) {
          if (closed) return undefined;
          messages.push({ role: 'tool', tool_call_id: c.id, content: await carryOut(c) });
        }
      }
      return finish({ text: `I stopped after ${MAX_STEPS} steps without an answer.`, isError: true, usage: used });
    } catch (e) {
      if (closed) return undefined;
      return finish({ text: `The model could not be asked: ${e.message}`, isError: true, usage: used });
    }

    function finish({ text: said, isError = false, usage }) {
      ctx.store.set(keyOf(sessionId), { workdir: spec.workdir, messages });
      const u = usage ?? usageOf(null, 0, 0);
      on.result({ text: said, isError, sessionId, usage: { ...u, ok: !isError, data: { ...u.data, turnMs: Date.now() - t0 } } });
    }
  }

  // A tool the model asked for, handed to blackcat. → what came of it, as text for the model.
  async function carryOut(c) {
    let args;
    try {
      args = JSON.parse(c.function?.arguments || '{}');
    } catch {
      return `The arguments were not JSON: ${String(c.function?.arguments).slice(0, 200)}`;
    }
    const r = await serve.handle({ jsonrpc: '2.0', id: c.id, method: 'tools/call', params: { name: c.function?.name, arguments: args } });
    const body = (r?.result?.content ?? []).map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n');
    const said = body || r?.error?.message || '(no output)';
    return r?.result?.isError ? `Error: ${said}` : said;
  }

  let queue = Promise.resolve();
  return {
    get closed() {
      return closed;
    },
    send(text) {
      queue = queue.then(() => (closed ? undefined : turn(text)));
    },
    stop() {
      if (closed) return;
      closed = true;
      stop.abort();
      stop = null;
      on.exit({ code: 0, stderr: '' });
    },
  };
}
