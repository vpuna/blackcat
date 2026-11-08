// The engine for a model that speaks the OpenAI API (plugins/openai). blackcat holds the
// conversation and serves its own tools: these tests stand in for the server, act out a
// model, and hold what matters: what the model asks for is judged and done by blackcat
// alone, the conversation survives a restart and is shortened to fit, and a reader's answer
// comes back in its shape.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, test } from 'node:test';
import { home } from './helpers.js';

const dir = home();
process.env.HOME = dir;
// (The check below makes its copy in the temporary folder: this test's own, not the one other tests look in.)
process.env.TMPDIR = path.join(dir, 'tmp');
fs.mkdirSync(process.env.TMPDIR);
fs.mkdirSync(path.join(dir, 'agent'), { recursive: true });
fs.writeFileSync(path.join(dir, 'agent/AGENT.md'), 'Rules.\n');

// The stand-in server. `model(body)` is what the model answers to a request: a message.
let model = () => ({ content: 'hello' });
let busy = 0;
let most = 0;
let fail = [];
const asked = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', async () => {
    const send = (code, o) => (res.writeHead(code, { 'Content-Type': 'application/json' }), res.end(JSON.stringify(o)));
    if (req.url === '/v1/models') return send(200, { data: [{ id: 'local-model' }] });
    if (req.url === '/props') return send(200, { default_generation_settings: { n_ctx: 32768 } });
    const b = JSON.parse(body);
    asked.push({ ...b, auth: req.headers.authorization ?? null });
    if (fail.length) return send(fail.shift(), { error: { message: 'the server is busy' } });
    busy++;
    most = Math.max(most, busy);
    await new Promise((r) => setTimeout(r, 20));
    busy--;
    const message = { role: 'assistant', ...model(b) };
    return send(200, {
      model: 'local-model',
      choices: [{ message }],
      usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 60 } },
    });
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ADDRESS = `http://127.0.0.1:${server.address().port}/v1`;
after(() => server.close());

const { save, load } = await import('../src/config.js');
save({
  plugins: { enabled: ['openai'], settings: { openai: { endpoint: ADDRESS, context: 32768, atOnce: 1 } } },
  engine: { chat: { name: 'openai' }, readers: { name: 'openai' } },
});
const { loadPlugins, findLoaded, makeCtx } = await import('../src/plugins/registry.js');
await loadPlugins();
const brain = await import('../src/agent/brain.js');
after(() => brain.stopAll());
const run = await import('../plugins/openai/run.js');
const ctx = makeCtx(findLoaded('openai'));

const toolCall = (name, args, id = 'call-1') => ({
  content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});
// (What came back in the turn in progress: since the owner's last message.)
const resultsIn = (b) => b.messages.slice(b.messages.findLastIndex((m) => m.role === 'user')).filter((m) => m.role === 'tool');
const CHAT = 42;

test("the model is given blackcat's rules and its four tools, and nothing it is not told to switch", async () => {
  asked.length = 0;
  model = () => ({ content: 'hello there' });
  assert.equal(await brain.reply(CHAT, 'hi'), 'hello there');
  const b = asked.at(-1);
  assert.deepEqual(
    b.tools.map((t) => t.function.name),
    ['bash', 'read', 'glob', 'grep'],
  );
  assert.match(b.messages[0].content, /^Rules\.\n\n# blackcat runtime/, 'the rules first, then what is true of this installation');
  assert.match(b.messages[0].content, /Today is \d{4}-\d{2}-\d{2} \(\w+day\)\.$/);
  assert.deepEqual(b.messages.at(-1), { role: 'user', content: 'hi' });
  assert.equal(b.chat_template_kwargs, undefined, 'thinking is not switched unless chosen: other servers refuse it');
  assert.equal(b.auth, null, 'no key was set, so none is sent');
});

test('what the model asks for is judged by blackcat: a command that is not allowed is not run, and the model is told', async () => {
  const made = path.join(dir, 'made-by-the-model');
  asked.length = 0;
  model = (b) => (resultsIn(b).length ? { content: 'I could not do it.' } : toolCall('bash', { command: `touch ${made}` }));
  assert.equal(await brain.reply(CHAT, 'make a file'), 'I could not do it.');
  assert.ok(!fs.existsSync(made), 'nothing the policy did not allow was done');
  const told = resultsIn(asked.at(-1)).at(-1);
  assert.equal(told.tool_call_id, 'call-1');
  assert.match(told.content, /^Error: Not run: only blackcat commands are run/);
});

test('a command that is allowed is run by blackcat, and what it printed goes back to the model', async () => {
  asked.length = 0;
  model = (b) => (resultsIn(b).length ? { content: 'You have none.' } : toolCall('bash', { command: 'blackcat remind list' }, 'call-2'));
  assert.equal(await brain.reply(CHAT, 'what reminders do i have'), 'You have none.');
  const told = resultsIn(asked.at(-1)).at(-1);
  assert.equal(told.tool_call_id, 'call-2');
  assert.doesNotMatch(told.content, /^Error/);
  assert.match(told.content, /reminder/i);
});

test('arguments that are not JSON, and a tool that is not there, are told to the model, not done', async () => {
  asked.length = 0;
  model = (b) =>
    resultsIn(b).length
      ? { content: 'ok' }
      : {
          content: null,
          tool_calls: [
            { id: 'bad', type: 'function', function: { name: 'bash', arguments: '{not json' } },
            { id: 'web', type: 'function', function: { name: 'web_fetch', arguments: '{"url":"http://x"}' } },
          ],
        };
  await brain.reply(CHAT, 'try things');
  const [bad, web] = resultsIn(asked.at(-1)).slice(-2);
  assert.match(bad.content, /^The arguments were not JSON/);
  assert.match(web.content, /^Error: There is no tool called web_fetch/);
});

test('the conversation is kept by blackcat: a new start carries it on, and forgetting a folder removes it', async () => {
  const said = [];
  model = () => ({ content: 'noted' });
  // (A turn, and the end of it: what on.result was given.)
  const turn = async (spec, text) => {
    let done;
    const over = new Promise((r) => (done = r));
    const conv = await run.converse(ctx, spec, { ready() {}, result: (m) => (said.push(m), done()), exit() {} });
    conv.send(text);
    await over;
    conv.stop();
  };
  const serve = { handle: async (m) => (m.method === 'tools/list' ? { result: { tools: [] } } : null) };
  const spec = { serve, workdir: path.join(dir, 'w'), instructions: { rules: 'R' } };
  await turn(spec, 'my locker is 12');
  const id = said[0].sessionId;
  assert.ok(await run.has(ctx, id));
  asked.length = 0;
  await turn({ ...spec, resume: id }, 'which locker?');
  assert.deepEqual(
    asked[0].messages.slice(1).map((m) => m.content),
    ['my locker is 12', 'noted', 'which locker?'],
  );
  assert.equal(said[1].sessionId, id);
  run.forget(ctx, path.join(dir, 'w'));
  assert.ok(!(await run.has(ctx, id)));
});

test('a long conversation is made to fit: old results are left out first, then the oldest exchanges', () => {
  const big = 'x'.repeat(3000); // about 1,000 tokens
  const m = [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'one' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'a' }] },
    { role: 'tool', tool_call_id: 'a', content: big },
    { role: 'assistant', content: 'done one' },
    { role: 'user', content: 'two' },
    { role: 'assistant', content: 'done two' },
    { role: 'user', content: 'three' },
    { role: 'tool', tool_call_id: 'b', content: big },
  ];
  assert.equal(run.fit(m, 5000, 7), m, 'it fits: nothing is changed');
  const shorter = run.fit(m, 1200, 7);
  assert.equal(shorter[3].content, '[An earlier result, left out to make room.]');
  assert.equal(shorter.at(-1).content, big, 'what the turn in progress has found is kept');
  assert.equal(shorter.length, m.length);
  const shortest = run.fit([...m.slice(0, 4), { role: 'assistant', content: 'z'.repeat(600) }, ...m.slice(5)], 1100, 7);
  assert.deepEqual(
    shortest.map((x) => x.content),
    ['S', 'two', 'done two', 'three', big],
    'the oldest exchange went whole; the system message and the turn in progress stayed',
  );
});

test("a reader's question has no tools, is held to its shape, and its answer comes back as data", async () => {
  asked.length = 0;
  model = () => ({ content: '{"items":[{"task":"send the form"}]}' });
  const { askFor } = await import('../src/agent/oneshot.js');
  const schema = { type: 'object', properties: { items: { type: 'array' } }, required: ['items'] };
  const r = await askFor('Read these.', 'a message', undefined, { schema });
  assert.deepEqual(r.data, { items: [{ task: 'send the form' }] });
  const b = asked.at(-1);
  assert.equal(b.tools, undefined);
  assert.deepEqual(b.response_format, { type: 'json_schema', json_schema: { name: 'answer', schema } });
  assert.deepEqual(b.messages[0], { role: 'system', content: 'Read these.' });
});

test('a picture is sent the OpenAI way; a document is refused; thinking is switched when chosen', async () => {
  asked.length = 0;
  model = () => ({ content: '<think>hmm</think>A cat.' });
  const pic = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
  const r = await run.ask(ctx, { system: 'S', content: [pic, { type: 'text', text: 'what is it?' }], options: { thinking: 'off' } });
  assert.equal(r.text, 'A cat.', 'thinking written inline is not part of the answer');
  const b = asked.at(-1);
  assert.deepEqual(b.messages[1].content, [
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    { type: 'text', text: 'what is it?' },
  ]);
  assert.deepEqual(b.chat_template_kwargs, { enable_thinking: false });
  await assert.rejects(run.ask(ctx, { system: 'S', content: [{ type: 'document', source: {} }] }), /can't be given a document/);
  assert.deepEqual(findLoaded('openai').manifest.engine.takes(), [], 'it is not said to see pictures until the owner says so');
});

test('a busy server is asked again; one that refuses says why; a key is sent when there is one', async () => {
  model = () => ({ content: 'fine' });
  fail = [503];
  assert.equal((await run.ask(ctx, { system: 'S', content: 'q' })).text, 'fine');
  fail = [400];
  await assert.rejects(run.ask(ctx, { system: 'S', content: 'q' }), /said 400: .*the server is busy/);
  ctx.secrets.set('key', 'sk-test');
  await run.ask(ctx, { system: 'S', content: 'q' });
  assert.equal(asked.at(-1).auth, 'Bearer sk-test');
  ctx.secrets.delete('key');
});

test('usage is what the server reported, with what it had kept counted apart', async () => {
  model = () => ({ content: 'x' });
  const r = await run.ask(ctx, { system: 'S', content: 'q' });
  assert.deepEqual(
    { model: r.usage.model, tokensIn: r.usage.tokensIn, cacheRead: r.usage.cacheRead, tokensOut: r.usage.tokensOut, cost: r.usage.cost },
    { model: 'local-model', tokensIn: 40, cacheRead: 60, tokensOut: 10, cost: null },
  );
});

test('setup finds out what it can: whether it answers, how much it holds, what it serves', async () => {
  const p = findLoaded('openai');
  const said = await p.manifest.commands.setup.run(ctx, { endpoint: `${ADDRESS}/`, atOnce: '1' });
  assert.match(said, /It answers: .*serving 1 model/);
  assert.match(said, /It holds 32768 tokens/);
  assert.equal(load().plugins.settings.openai.endpoint, ADDRESS, 'a trailing slash is taken off');
  assert.deepEqual(load().plugins.settings.openai.models, ['local-model']);
  assert.deepEqual(
    (await import('../src/engines/registry.js')).choicesOf('openai').models.map((m) => m.id),
    ['local-model'],
  );
});

test('the check is paced as the engine says: one request at a time for a model on one card', async () => {
  most = 0;
  model = () => ({ content: 'I would not do that.' });
  const commands = await import('../src/engines/commands.js');
  const found = await commands.runCheck({ roles: ['chat'], quick: true });
  assert.equal(found.chat.result.error, undefined);
  assert.ok(found.chat.result.accuracy.length > 1, 'there were requests to pace');
  assert.equal(most, 1, 'never more than one at once');
});
