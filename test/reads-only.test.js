// The WhatsApp and Telegram-account plugins only read: the README and the question before
// linking say they never send a message, never mark one as read and never show the owner
// online. The libraries underneath can do all of that; this holds that blackcat never asks
// them to. (It reads the source for the libraries' own names, so a name put together at run
// time would get past it; none of these plugins does that, and a review should not let it in.)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const root = new URL('..', import.meta.url).pathname;
const sources = (plugin) =>
  fs
    .readdirSync(path.join(root, 'plugins', plugin))
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({ file: `plugins/${plugin}/${f}`, code: fs.readFileSync(path.join(root, 'plugins', plugin, f), 'utf8') }));

// What sends, marks as read or sets presence: Baileys (WhatsApp) and GramJS (Telegram).
const ACTS = {
  wa: [
    'sendMessage',
    'relayMessage',
    'sendReceipt',
    'sendReceipts',
    'readMessages',
    'sendPresenceUpdate',
    'presenceSubscribe',
    'chatModify',
    'updateProfileStatus',
    'updateProfileName',
    'updateProfilePicture',
    'groupCreate',
    'groupParticipantsUpdate',
    'rejectCall',
  ],
  tg: [
    'sendMessage',
    'sendFile',
    'forwardMessages',
    'editMessage',
    'deleteMessages',
    'markAsRead',
    'pinMessage',
    'SendMessage',
    'SendMedia',
    'SendMultiMedia',
    'ForwardMessages',
    'ReadHistory',
    'ReadMessageContents',
    'SetTyping',
    'UpdateStatus',
    'UpdateProfile',
  ],
};

for (const [plugin, names] of Object.entries(ACTS))
  test(`the ${plugin} plugin never calls what would send, mark as read or show you online`, () => {
    const found = sources(plugin).flatMap(({ file, code }) =>
      names.filter((n) => new RegExp(`\\b${n}\\b`).test(code)).map((n) => `${file}: ${n}`),
    );
    assert.deepEqual(found, []);
  });

test('WhatsApp is told never to show you online when it connects', () => {
  const code = fs.readFileSync(path.join(root, 'plugins/wa/service.js'), 'utf8');
  assert.match(code, /markOnlineOnConnect: false/);
  assert.doesNotMatch(code, /markOnlineOnConnect: true/);
});
