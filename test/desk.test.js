// The desk: where what the owner writes or taps arrives, and what they are shown leaves
// from, whichever channel carries it. These are its rules, tested with a carrier that only
// records what it is asked to do.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { home } from './helpers.js';

home();
const { desk, resetDesk, setCarrier, ui } = await import('../src/channels/desk.js');
const { actions, chunks, message, plain } = await import('../src/channels/kit.js');

function carrier(can = { buttons: true, edit: true, html: true }) {
  const did = [];
  let n = 0;
  const c = {
    did,
    can,
    label: 'a test',
    send: async (chat, m) => (
      did.push(['send', chat, m.text, m.html, m.actions?.map((r) => r.map((a) => a.label)) ?? null, m.preview]),
      ++n
    ),
    edit: async (chat, ref, m) => void did.push(['edit', chat, ref, m.text, m.actions?.map((r) => r.map((a) => a.label)) ?? null]),
    setActions: async (chat, ref, rows) => void did.push(['setActions', chat, ref, rows?.map((r) => r.map((a) => a.label)) ?? null]),
    remove: async (chat, ref) => void did.push(['remove', chat, ref]),
    toast: async (ev, text) => void did.push(['toast', ev.id, text ?? null]),
    sendFile: async (chat, file, o) => void did.push(['file', chat, file, o?.caption ?? null]),
  };
  return c;
}
// `bare`: a channel with no way to acknowledge a tap or take a message back either.
const fresh = (can, { bare = false } = {}) => {
  resetDesk();
  const c = carrier(can);
  if (bare) (delete c.toast, delete c.remove);
  setCarrier(c);
  return c.did;
};

test('a message is text, optional formatting, and rows of actions', () => {
  const kb = actions().add('Yes', 'a:y').add('No', 'a:n').row().add('Later', 'a:l');
  assert.deepEqual(message('<b>Hi</b>', { html: true, actions: kb, preview: false }), {
    text: '<b>Hi</b>',
    html: true,
    preview: false,
    actions: [
      [
        { label: 'Yes', id: 'a:y' },
        { label: 'No', id: 'a:n' },
      ],
      [{ label: 'Later', id: 'a:l' }],
    ],
  });
  assert.deepEqual(message('plain'), { text: 'plain', html: false, actions: null, preview: true });
  assert.equal(message('x', { actions: actions() }).actions, null, 'no buttons added: none');
  assert.equal(plain('<b>Bold</b> &amp; <i>more</i>\n<pre>a &lt; b</pre>'), 'Bold & more\na < b');
  assert.deepEqual(chunks('a\nb\nc', 3), ['a\nb', 'c']);
  assert.deepEqual(chunks('abcdefgh', 3), ['abc', 'def', 'gh']);
});

test('a command goes to whoever answers to it, in the order they were added, each able to pass it on', async () => {
  const did = fresh();
  const seen = [];
  ui.command('ha', (c, next) => (c.args ? next() : c.reply('the browser')));
  ui.command('ha', (c) => c.reply(`run: ha ${c.args}`));
  ui.command('ping', (c) => c.reply('pong'));
  ui.text((c, next) => (seen.push(c.text), c.text === 'mine' ? c.reply('taken') : next()));
  desk.setFallback((c) => c.reply(`claude: ${c.text}`));
  await desk.text({ chat: 1, who: 'Ana', text: '/ha' });
  await desk.text({ chat: 1, who: 'Ana', text: '/ha off kitchen light' });
  await desk.text({ chat: 1, who: 'Ana', text: '/PING@SomeBot' });
  await desk.text({ chat: 1, who: 'Ana', text: 'mine' });
  await desk.text({ chat: 1, who: 'Ana', text: 'anything else' });
  // not a command anyone answers to: a path typed during setup, say
  await desk.text({ chat: 1, who: 'Ana', text: '/mnt/user/backups' });
  await desk.text({ chat: 1, who: 'Ana', text: '/ping/extra' });
  assert.deepEqual(
    did.map((d) => d[2]),
    [
      'the browser',
      'run: ha off kitchen light',
      'pong',
      'taken',
      'claude: anything else',
      'claude: /mnt/user/backups',
      'claude: /ping/extra',
    ],
  );
  assert.deepEqual(
    seen,
    ['mine', 'anything else', '/mnt/user/backups', '/ping/extra'],
    'text handlers are not asked about a command that was answered',
  );
});

test('a tap goes to the first action that fits, and is always acknowledged', async () => {
  const did = fresh();
  ui.action(/^rm:(\d+):d$/, async (c) => {
    await c.toast(`done ${c.match[1]}`);
    await c.edit('Finished', { html: true });
  });
  ui.action('plain:id', async (c) => void (await c.clearActions()));
  ui.action(/^slow:/, async () => {
    throw new Error('it broke');
  });
  await desk.action({ chat: 1, who: 'Ana', id: 'rm:12:d', ref: 7 });
  await desk.action({ chat: 1, who: 'Ana', id: 'plain:id', ref: 8 });
  await assert.rejects(() => desk.action({ chat: 1, who: 'Ana', id: 'slow:1', ref: 9 }), /it broke/);
  await desk.action({ chat: 1, who: 'Ana', id: 'nobody:knows', ref: 10 });
  assert.deepEqual(did, [
    ['toast', 'rm:12:d', 'done 12'],
    ['edit', 1, 7, 'Finished', null],
    ['setActions', 1, 8, null],
    ['toast', 'plain:id', null], // it did not acknowledge the tap itself: the desk does
    ['toast', 'slow:1', null], // even when it fails
    ['toast', 'nobody:knows', null],
  ]);
});

test('on a channel that can do less, nothing is lost: numbers for buttons, a new message for an edit, text without tags', async () => {
  const did = fresh({}, { bare: true });
  ui.action(/^pick:(\w+)$/, async (c) => {
    await c.toast(`You chose ${c.match[1]}`);
    await c.edit('<b>Chosen</b>', { html: true });
  });
  desk.setFallback((c) => c.reply(`claude: ${c.text}`));
  const ref = await ui.send(5, '<b>Tea</b> or coffee?', {
    html: true,
    actions: actions().add('Tea', 'pick:tea').row().add('Coffee', 'pick:coffee'),
  });
  assert.deepEqual(did.at(-1), ['send', 5, 'Tea or coffee?\n\n1. Tea\n2. Coffee\n(Answer with a number.)', false, null, true]);
  await desk.text({ chat: 6, who: 'Bo', text: '2' }); // another chat was offered nothing
  assert.equal(did.at(-1)[2], 'claude: 2');
  await desk.text({ chat: 5, who: 'Ana', text: ' 2 ' });
  assert.deepEqual(
    did.slice(-2).map((d) => [d[0], d[2]]),
    [
      ['send', 'You chose coffee'],
      ['send', 'Chosen'],
    ],
  );
  await desk.text({ chat: 5, who: 'Ana', text: '2' });
  assert.equal(did.at(-1)[2], 'claude: 2', 'the choice was used up');
  // taking the buttons away withdraws the offer
  await ui.send(5, 'Sure?', { actions: actions().add('Yes', 'pick:yes') });
  await ui.setActions(5, ref, null);
  await desk.text({ chat: 5, who: 'Ana', text: '1' });
  assert.equal(did.at(-1)[2], 'claude: 1');
  // a message cannot be taken back here, and the caller is told
  await assert.rejects(() => ui.remove(5, 1), /cannot be taken back/);
});

test('with no channel in use there is nowhere to send, and that is an error, not a silence', async () => {
  resetDesk();
  await assert.rejects(() => ui.send(1, 'hello'), /no channel is active/);
  const { notifyOwner, tellChat } = await import('../src/channels/send.js');
  assert.equal(await notifyOwner('hello'), false);
  assert.equal(await tellChat('hello'), false);
});

test('a message too long for the channel goes as several, cut at line ends, with the buttons under the last', async () => {
  const did = fresh({ buttons: true, edit: true, html: true, maxChars: 100 });
  const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1} of the long answer`);
  const ref = await ui.send(7, lines.join('\n'), { actions: actions().add('Yes', 'y') });
  const sent = did.filter((d) => d[0] === 'send');
  assert.ok(sent.length > 1);
  assert.ok(sent.every((d) => d[2].length <= 100));
  assert.equal(sent.map((d) => d[2]).join('\n'), lines.join('\n'), 'nothing lost, nothing cut inside a line');
  assert.deepEqual(
    sent.map((d) => d[4]),
    [...sent.slice(1).map(() => null), [['Yes']]],
  );
  assert.equal(ref, sent.length, 'what comes back is the last one: the one with the buttons');
  // formatted text that is too long goes plain: half a tag would be refused
  did.length = 0;
  await ui.send(7, `<b>${'word '.repeat(60)}</b>`, { html: true });
  assert.ok(did.length > 1);
  assert.ok(did.every((d) => d[3] === false && !/[<>]/.test(d[2])));
  // one that fits is sent as it is
  did.length = 0;
  await ui.send(7, '<b>short</b>', { html: true });
  assert.deepEqual(did, [['send', 7, '<b>short</b>', true, null, did[0][5]]]);
});

test('/help fits the channel with every plugin that comes with blackcat switched on', async () => {
  const { available, loadPlugins } = await import('../src/plugins/registry.js');
  const { update } = await import('../src/config.js');
  update((c) => {
    c.plugins = { ...c.plugins, enabled: available().map((p) => p.name), disabled: [] };
  });
  await loadPlugins();
  const { helpText } = await import('../src/channels/commands.js');
  const text = helpText();
  assert.ok(text.length > 4096, `it is long (${text.length}): this is the case that was refused`);
  const did = fresh({ buttons: true, edit: true, html: true, maxChars: 4000 });
  await ui.send(7, text);
  assert.ok(did.length >= 2);
  assert.ok(did.every((d) => d[2].length <= 4000));
  assert.equal(did.map((d) => d[2]).join('\n'), text);
});
