// The six tools, carried out by blackcat itself (src/tools/). These tests are about doing
// the thing within limits: what a command may see and how long it may run, what a file read
// gives back, and that a path is made plain before it is judged or opened.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { home } from './helpers.js';

const dir = home();
process.env.HOME = dir;
process.env.ANTHROPIC_AUTH_TOKEN = 'ENGINE-KEY';
process.env.MY_API_KEY = 'ANOTHER-KEY';
process.env.PLAIN_SETTING = 'visible';
const agent = path.join(dir, 'agent');
fs.mkdirSync(agent, { recursive: true });
fs.writeFileSync(path.join(agent, 'AGENT.md'), 'Rules.\nSecond line.\n');
const { save } = await import('../src/config.js');
save({});
await (await import('../src/plugins/registry.js')).loadPlugins();
const { LIMITS, ToolError, clip, realPath, run, settle } = await import('../src/tools/run.js');
const { DEFS, POLICY_NAME } = await import('../src/tools/defs.js');
const { toolServer } = await import('../src/tools/server.js');
const { decide, plainLook } = await import('../src/agent/policy.js');

// As the conversation code does it: the path is made plain (a call that names none is told so), then it is carried out.
const call = async (tool, input, env = {}) => {
  let c;
  try {
    c = settle(tool, input, agent);
  } catch (e) {
    if (e instanceof ToolError) return { content: [{ type: 'text', text: e.message }], isError: true };
    throw e;
  }
  return run(tool, c, { cwd: agent, ...env });
};
const said = (r) => r.content.map((c) => c.text ?? `[${c.type}]`).join('\n');

test("bash: one command, in the agent's folder, with what it printed and how it ended", async () => {
  let r = await call('bash', { command: 'pwd; echo out; echo err >&2' });
  assert.equal(said(r), `${agent}\nout\nerr`);
  assert.equal(r.isError, false);
  r = await call('bash', { command: 'echo nearly; exit 3' });
  assert.deepEqual([said(r), r.isError], ['nearly\n\nExit code 3', true]);
  assert.equal(said(await call('bash', { command: 'true' })), '(no output)');
  // each command starts fresh: nothing carries over
  await call('bash', { command: 'cd /tmp; export CARRIED=yes' });
  assert.equal(said(await call('bash', { command: 'pwd; echo "[$CARRIED]"' })), `${agent}\n[]`);
  assert.match(said(await call('bash', { command: '   ' })), /Which command\?/);
});

test('bash: a command sees who is asking, and none of the keys blackcat was started with', async () => {
  const r = await call(
    'bash',
    { command: 'echo "$BLACKCAT_CALLER|$BLACKCAT_CHAT_ID|$PLAIN_SETTING|$ANTHROPIC_AUTH_TOKEN|$MY_API_KEY|"; env | grep -c KEY' },
    { env: { BLACKCAT_CALLER: 'agent', BLACKCAT_CHAT_ID: '42' } },
  );
  assert.equal(said(r).split('\n')[0], 'agent|42|visible|||');
  assert.doesNotMatch(said(r), /ENGINE-KEY|ANOTHER-KEY/);
  // the terminal chat has no chat id: it is not set at all
  assert.equal(
    said(await call('bash', { command: 'echo "[${BLACKCAT_CHAT_ID-unset}]"' }, { env: { BLACKCAT_CHAT_ID: undefined } })),
    '[unset]',
  );
});

test('bash: a command that runs too long is stopped, with everything it started', async () => {
  const marker = path.join(dir, 'still-running');
  const t0 = Date.now();
  const r = await call('bash', { command: `(sleep 30; touch ${marker}) & echo started; sleep 30`, timeout: 1 });
  assert.ok(Date.now() - t0 < 6000, 'it did not wait for the command');
  assert.deepEqual([said(r), r.isError], ['started\n\nIt was stopped after 1 seconds.', true]);
  // and when the conversation ends, so does what is still going
  const running = new Set();
  const going = call('bash', { command: 'echo begun; sleep 30' }, { running });
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(running.size, 1);
  for (const x of running) x.stop();
  assert.match(said(await going), /begun\n\nIt was stopped: the conversation ended\./);
  assert.equal(running.size, 0);
  await new Promise((res) => setTimeout(res, 2500));
  assert.ok(!fs.existsSync(marker), 'what it had put in the background went with it');
  assert.equal(LIMITS.commandMaxS < 300, true, 'a command cannot outlast the turn it is part of');
});

test('bash: a flood of output keeps its start and its end, and does not fill memory', async () => {
  const r = await call('bash', { command: 'echo THE-START; yes "a line of output that goes on" | head -c 3000000; echo THE-END' });
  const t = said(r);
  assert.ok(t.length < LIMITS.output + 400, `kept ${t.length} characters`);
  assert.match(t, /^THE-START\n/);
  assert.match(t, /characters left out of the middle/);
  assert.match(t, /THE-END\n\[\d+ more characters were not kept\.\]$/);
  assert.equal(clip('short'), 'short');
});

test('read: text with line numbers, in pieces when it is long', async () => {
  assert.equal(said(await call('read', { file_path: 'AGENT.md' })), '     1\tRules.\n     2\tSecond line.');
  fs.writeFileSync(path.join(agent, 'long.txt'), Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join('\n'));
  let t = said(await call('read', { file_path: 'long.txt' }));
  assert.match(t, /^ {5}1\tline 1\n/);
  assert.match(t, /\n {2}2000\tline 2000\n\n\[Lines 1 to 2000 of 5000\. For more: offset 2001\.\]$/);
  t = said(await call('read', { file_path: 'long.txt', offset: 4999, limit: 10 }));
  assert.equal(t, '  4999\tline 4999\n  5000\tline 5000');
  assert.match(said(await call('read', { file_path: 'long.txt', offset: 9000 })), /the file has 5000 lines: nothing at line 9000/);
  fs.writeFileSync(path.join(agent, 'wide.txt'), 'x'.repeat(5000));
  assert.match(said(await call('read', { file_path: 'wide.txt' })), /x{2000}… \[line cut\]$/);
  fs.writeFileSync(path.join(agent, 'empty.txt'), '');
  assert.equal(said(await call('read', { file_path: 'empty.txt' })), '(the file is empty)');
});

test('read: what is not there, not a file, or not text is said plainly', async () => {
  const no = await call('read', { file_path: 'nothing.txt' });
  assert.deepEqual([no.isError, said(no)], [true, `There is no file at ${agent}/nothing.txt.`]);
  assert.match(said(await call('read', { file_path: '.' })), /is a folder\. To see what is in it, use glob/);
  fs.writeFileSync(path.join(agent, 'blob.bin'), Buffer.from([1, 2, 0, 3, 4]));
  assert.match(said(await call('read', { file_path: 'blob.bin' })), /is not text \(5 bytes of something else\)/);
  assert.match(said(await call('read', {})), /Which file\?/);
});

test('read: a picture is shown, made small enough to look at; a PDF comes back as its text', async () => {
  const { default: sharp } = await import('sharp');
  await sharp({ create: { width: 4000, height: 3000, channels: 3, background: { r: 10, g: 20, b: 200 } } })
    .jpeg()
    .toFile(path.join(agent, 'big.jpg'));
  await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 200, g: 20, b: 10 } } })
    .png()
    .toFile(path.join(agent, 'small.png'));
  const big = await call('read', { file_path: 'big.jpg' });
  assert.deepEqual(
    big.content.map((c) => c.type),
    ['text', 'image'],
  );
  assert.match(big.content[0].text, /big\.jpg \(4000×3000, shown smaller\)/);
  const shown = await sharp(Buffer.from(big.content[1].data, 'base64')).metadata();
  assert.deepEqual([shown.width, shown.height, big.content[1].mimeType], [1568, 1176, 'image/jpeg']);
  assert.ok(big.content[1].data.length < 400_000);
  const small = await call('read', { file_path: 'small.png' });
  assert.match(small.content[0].text, /small\.png \(300×200\):/);
  assert.equal((await sharp(Buffer.from(small.content[1].data, 'base64')).metadata()).width, 300);
  fs.writeFileSync(path.join(agent, 'broken.jpg'), 'not a picture');
  assert.match(said(await call('read', { file_path: 'broken.jpg' })), /could not be read as a picture/);
  // a PDF, made by hand
  const pdf =
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 44>>stream\nBT /F1 12 Tf 20 50 Td (The trip form) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF';
  fs.writeFileSync(path.join(agent, 'form.pdf'), pdf);
  assert.match(said(await call('read', { file_path: 'form.pdf' })), /The trip form/);
});

test('glob and grep: files by name, newest first; lines by what they say', async () => {
  fs.mkdirSync(path.join(agent, 'notes/deep'), { recursive: true });
  fs.writeFileSync(path.join(agent, 'notes/a.md'), 'alpha\nthe Heron flies\n');
  fs.writeFileSync(path.join(agent, 'notes/deep/b.md'), 'beta\nno bird here\n');
  fs.utimesSync(path.join(agent, 'notes/a.md'), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  assert.equal(said(await call('glob', { pattern: '**/*.md', path: 'notes' })), `${agent}/notes/deep/b.md\n${agent}/notes/a.md`);
  assert.match(said(await call('glob', { pattern: '*', path: 'notes' })), /notes\/deep\/$/m);
  assert.equal(said(await call('glob', { pattern: '*.zip' })), `Nothing in ${agent} matches *.zip.`);
  // a pattern cannot leave the folder it is asked of
  for (const pattern of ['../*', '/etc/*', 'notes/../../*']) assert.match(said(await call('glob', { pattern })), /cannot leave it/);
  assert.equal(said(await call('grep', { pattern: 'heron', path: 'notes', ignore_case: true })), `${agent}/notes/a.md:2:the Heron flies`);
  assert.equal(said(await call('grep', { pattern: 'heron', path: 'notes' })), `Nothing in ${agent}/notes matches.`);
  assert.equal(
    said(await call('grep', { pattern: 'a$', files_only: true, glob: '*.md', path: 'notes' })),
    `${agent}/notes/a.md\n${agent}/notes/deep/b.md`,
  );
  // a pattern is a pattern, never part of a command
  assert.match(said(await call('grep', { pattern: '-e x; touch /tmp/blackcat-grep-injected', path: 'notes' })), /Nothing in/);
  assert.match(said(await call('grep', { pattern: '(' })), /The search failed/);
  // a link inside the folder is not followed out of it
  fs.writeFileSync(path.join(dir, 'outside.txt'), 'the Heron is outside\n');
  fs.symlinkSync(path.join(dir, 'outside.txt'), path.join(agent, 'notes/link.md'));
  assert.doesNotMatch(said(await call('grep', { pattern: 'Heron', path: 'notes' })), /outside/);
});

test('write and edit: a file made, replaced, and changed in one place', async () => {
  const r = await call('write', { file_path: 'notes/new.md', content: 'one\ntwo\ntwo\n' });
  assert.equal(said(r), `Wrote ${agent}/notes/new.md (4 lines).`);
  assert.equal(fs.statSync(path.join(agent, 'notes/new.md')).mode & 0o077, 0, "a new file is this account's only");
  assert.match(said(await call('write', { file_path: 'nowhere/x.md', content: 'x' })), /There is no folder/);
  assert.match(
    said(await call('edit', { file_path: 'notes/new.md', old_string: 'two', new_string: '2' })),
    /is in .* 2 times\. Give more of what is around it/,
  );
  assert.equal(
    said(await call('edit', { file_path: 'notes/new.md', old_string: 'one\ntwo', new_string: '1\n$&' })),
    `Changed ${agent}/notes/new.md.`,
  );
  assert.equal(fs.readFileSync(path.join(agent, 'notes/new.md'), 'utf8'), '1\n$&\ntwo\n', 'what is written is exactly what was given');
  assert.match(said(await call('edit', { file_path: 'notes/new.md', old_string: 'three', new_string: '3' })), /old_string is not in/);
  assert.match(said(await call('edit', { file_path: 'notes/new.md', old_string: '', new_string: '3' })), /old_string is empty/);
  assert.match(said(await call('edit', { file_path: 'notes/none.md', old_string: 'a', new_string: 'b' })), /There is no file/);
  await call('write', { file_path: 'notes/new.md', content: 'x x x' });
  assert.equal(
    said(await call('edit', { file_path: 'notes/new.md', old_string: 'x', new_string: 'y', replace_all: true })),
    `Changed ${agent}/notes/new.md in 3 places.`,
  );
  assert.equal(fs.readFileSync(path.join(agent, 'notes/new.md'), 'utf8'), 'y y y');
});

test('a path is made plain before it is judged: a link is the file it leads to', async () => {
  fs.mkdirSync(path.join(dir, 'data/plugins/x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data/plugins/x/secrets.json'), '{"token":"S3CRET"}');
  fs.symlinkSync(path.join(dir, 'data/plugins/x/secrets.json'), path.join(agent, 'innocent.txt'));
  fs.symlinkSync(path.join(dir, 'data'), path.join(agent, 'folder-link'));
  const s = settle('read', { file_path: 'innocent.txt' }, agent);
  assert.equal(s.file, path.join(dir, 'data/plugins/x/secrets.json'));
  assert.equal(s.input.file_path, s.file, 'the policy is shown where it leads');
  assert.equal(decide('Read', s.input).action, 'deny');
  assert.equal(decide('Read', settle('read', { file_path: 'folder-link/config.json' }, agent).input).action, 'deny');
  assert.equal(decide('Grep', settle('grep', { pattern: 'token', path: 'folder-link/plugins' }, agent).input).action, 'deny');
  assert.equal(decide('Write', settle('write', { file_path: 'folder-link/config.json', content: '{}' }, agent).input).action, 'deny');
  // even handed the link as written, the policy follows it
  assert.equal(decide('Read', { file_path: path.join(agent, 'innocent.txt') }).action, 'deny');
  assert.equal(realPath('~/x', agent), path.join(dir, 'x'));
  assert.equal(realPath('../agent/./AGENT.md', agent), path.join(agent, 'AGENT.md'));
  assert.throws(() => realPath('a\0b', agent), /not a file name/);
  // a file that is not there yet is judged by the folder it would be made in
  assert.equal(settle('write', { file_path: 'folder-link/new.json', content: '' }, agent).file, path.join(dir, 'data/new.json'));
});

test("what needs nobody's say: looking in its own folders, and a few harmless commands", async () => {
  // (What it remembers is no folder: it is kept by blackcat, and a folder an engine keeps of its own is like any other.)
  const MEMORY_DIR = path.join(dir, '.claude/projects/x/memory');
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  fs.mkdirSync(path.join(dir, 'data/inbox'), { recursive: true });
  const act = (tool, input) => decide(tool, input).action;
  for (const f of [path.join(agent, 'AGENT.md'), path.join(dir, 'data/inbox/photo.jpg')])
    assert.equal(act('Read', { file_path: f }), 'allow', f);
  assert.equal(act('Glob', { pattern: '*', path: agent }), 'allow');
  for (const [tool, input] of [
    ['Grep', { pattern: 'x', path: MEMORY_DIR }],
    ['Write', { file_path: path.join(MEMORY_DIR, 'likes-tea.md'), content: 'x' }],
    ['Edit', { file_path: path.join(MEMORY_DIR, 'MEMORY.md') }],
  ])
    assert.notEqual(act(tool, input), 'allow', tool);
  // anywhere else: the owner is asked, as before; its own rules it can never change
  assert.equal(act('Read', { file_path: '/etc/hostname' }), 'ask');
  assert.equal(act('Glob', { pattern: '*', path: dir }), 'ask');
  assert.equal(act('Write', { file_path: path.join(dir, 'data/inbox/x.txt') }), 'deny');
  assert.equal(act('Write', { file_path: path.join(agent, 'AGENT.md') }), 'deny');
  assert.equal(act('Edit', { file_path: path.join(agent, 'AGENT.md') }), 'deny');
  assert.equal(act('Write', { file_path: '/tmp/x.txt' }), 'ask');
  // commands that only say something about the moment or the machine
  for (const c of [
    'date',
    'date -u',
    'date +%Y-%m-%d',
    "date '+%A %d %B %H:%M'",
    'date -d tomorrow +%F',
    'date -d "next friday" +%A',
    'date --date="2 days ago" -I',
    'pwd',
    'whoami',
    'hostname',
    'hostname -I',
    'uname -a',
    'uname -sr',
    'uptime',
    'uptime -p',
    'id',
    'id -un',
    'true',
  ]) {
    assert.equal(plainLook(c), true, c);
    assert.equal(act('Bash', { command: c }), 'allow', c);
  }
  // anything that could do more is not one of them
  for (const c of [
    'date -s 12:00',
    'date --set=2020-01-01',
    'date -f /etc/passwd',
    'date -r /etc/shadow',
    'date; rm -rf x',
    'date && touch x',
    'date > x',
    'date | sh',
    'date $(touch x)',
    'date `touch x`',
    'date +$HOME',
    'date +%F\ntouch x',
    'hostname newname',
    'hostname -F /tmp/x',
    'id root',
    'whoami x',
    'pwd -P x',
    'uname -a; ls',
    '/bin/date',
    './date',
    'env date',
    'sudo date',
    'DATE=x date',
    'ls',
    'cat AGENT.md',
    'echo hi',
    'df -h',
    'ps -ef',
    'history',
    'uptime -x',
    'true x',
    '',
  ]) {
    assert.equal(plainLook(c), false, JSON.stringify(c));
    assert.notEqual(act('Bash', { command: c }), 'allow', JSON.stringify(c));
  }
});

test('the tools are named and shaped as the policy knows them', () => {
  assert.deepEqual(
    DEFS.map((d) => d.name),
    ['bash', 'read', 'glob', 'grep', 'write', 'edit'],
  );
  assert.deepEqual(Object.values(POLICY_NAME), ['Bash', 'Read', 'Glob', 'Grep', 'Write', 'Edit']);
  for (const d of DEFS) {
    assert.equal(d.inputSchema.type, 'object');
    assert.equal(d.inputSchema.additionalProperties, false);
    assert.ok(d.description.length > 30 && d.description.length < 500, `${d.name}: said briefly`);
    for (const r of d.inputSchema.required) assert.ok(d.inputSchema.properties[r], `${d.name}.${r}`);
  }
  // what a model is told about all six, in all: a fraction of what an engine's own tools take
  assert.ok(JSON.stringify(DEFS).length < 5000, `${JSON.stringify(DEFS).length} characters`);
});

test('the tool server: the conversation an engine has with it', async () => {
  const calls = [];
  const s = toolServer({
    call: async (name, args) => (
      calls.push([name, args]),
      name === 'bash' && args.command === 'boom'
        ? Promise.reject(new Error('it broke'))
        : { content: [{ type: 'text', text: `did ${name}` }], isError: false }
    ),
  });
  const ask = (method, params, id = 1) => s.handle({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
  assert.deepEqual([s.name, s.tools], ['blackcat', ['bash', 'read', 'glob', 'grep', 'write', 'edit']]);
  const init = await ask('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x' } });
  assert.deepEqual(init.result, {
    protocolVersion: '2025-06-18',
    capabilities: { tools: {} },
    serverInfo: { name: 'blackcat', version: '1' },
  });
  assert.equal(
    (await ask('initialize', { protocolVersion: '2099-01-01' })).result.protocolVersion,
    '2025-11-25',
    'a version it does not know: its own newest',
  );
  assert.equal(await s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null, 'a notification is not answered');
  assert.deepEqual((await ask('ping')).result, {});
  assert.deepEqual(
    (await ask('tools/list')).result.tools.map((t) => t.name),
    s.tools,
  );
  assert.deepEqual(await ask('tools/call', { name: 'read', arguments: { file_path: 'x' } }, 7), {
    jsonrpc: '2.0',
    id: 7,
    result: { content: [{ type: 'text', text: 'did read' }], isError: false },
  });
  assert.deepEqual(calls, [['read', { file_path: 'x' }]]);
  // a tool that is not one of the six never reaches the caller
  const other = await ask('tools/call', { name: 'web_fetch', arguments: { url: 'http://x' } });
  assert.deepEqual([other.result.isError, other.result.content[0].text], [true, 'There is no tool called web_fetch.']);
  assert.equal(calls.length, 1);
  // a failure is an answer, never silence
  assert.deepEqual((await ask('tools/call', { name: 'bash', arguments: { command: 'boom' } })).result, {
    content: [{ type: 'text', text: 'It failed: it broke' }],
    isError: true,
  });
  assert.equal((await ask('resources/list')).error.code, -32601);
  assert.equal((await s.handle({ nonsense: true })).error.code, -32600);
});
