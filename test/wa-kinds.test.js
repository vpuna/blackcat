// What a business sends on WhatsApp is often not a plain message but one with parts and
// buttons (an appointment to confirm, a list to choose from). These are kept as text like
// any other, and what was chosen in answer is kept too.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describe, unkept } from '../plugins/wa/message.js';

test('a message with buttons under it is kept: its heading, text and small print, and what the buttons offer', () => {
  const d = describe({
    templateMessage: {
      hydratedTemplate: {
        hydratedTitleText: 'City Clinic, Floor 1',
        hydratedContentText:
          'Dear Sam,\nYour appointment with Doctor Lee is confirmed for:\n2030-01-05 at 08:00 in https://example.com/map',
        hydratedFooterText: 'Please arrive early',
        hydratedButtons: [
          { quickReplyButton: { displayText: 'Confirm', id: '1' } },
          { quickReplyButton: { displayText: 'Cancel', id: '2' } },
          { urlButton: { displayText: 'Open the app', url: 'https://example.com/app' } },
          { callButton: { displayText: 'Call us', phoneNumber: '+15550000000' } },
        ],
      },
    },
    messageContextInfo: {},
  });
  assert.equal(d.type, 'text');
  assert.equal(
    d.text,
    'City Clinic, Floor 1\nDear Sam,\nYour appointment with Doctor Lee is confirmed for:\n2030-01-05 at 08:00 in https://example.com/map\nPlease arrive early\n[Confirm · Cancel · Open the app: https://example.com/app · Call us: +15550000000]',
  );
  assert.equal(d.link.url, 'https://example.com/map');
  // The older shape of the same thing, and one inside a message that disappears.
  assert.match(
    describe({ templateMessage: { hydratedFourRowTemplate: { hydratedContentText: 'Your parcel is on its way' } } }).text,
    /parcel/,
  );
  assert.match(
    describe({ ephemeralMessage: { message: { templateMessage: { hydratedTemplate: { hydratedContentText: 'Your code is ready' } } } } })
      .text,
    /code is ready/,
  );
  assert.equal(describe({ templateMessage: {} }), null, 'one that says nothing is nothing');
});

test('the other shapes of it: plain buttons, the newer kind, and a list to choose from', () => {
  assert.equal(
    describe({
      buttonsMessage: {
        text: 'Delivery',
        contentText: 'Will you be home tomorrow?',
        footerText: 'Reply here',
        buttons: [{ buttonText: { displayText: 'Yes' } }, { buttonText: { displayText: 'No' } }],
      },
    }).text,
    'Delivery\nWill you be home tomorrow?\nReply here\n[Yes · No]',
  );
  const i = { header: { title: 'Order 12' }, body: { text: 'Your order is ready to collect.' }, footer: { text: 'Thank you' } };
  i.nativeFlowMessage = {
    buttons: [
      { name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: 'Track it', url: 'https://example.com/t/12' }) },
      { name: 'quick_reply', buttonParamsJson: '{not json' },
    ],
  };
  assert.equal(
    describe({ interactiveMessage: i }).text,
    'Order 12\nYour order is ready to collect.\nThank you\n[Track it: https://example.com/t/12]',
  );
  assert.match(describe({ templateMessage: { interactiveMessageTemplate: i } }).text, /ready to collect/, 'and wrapped as a template');
  assert.equal(
    describe({
      listMessage: {
        title: 'Departments',
        description: 'Which one?',
        buttonText: 'Choose',
        sections: [{ title: 'A', rows: [{ title: 'Skin', description: 'Mon to Fri' }, { title: 'Eyes' }] }],
      },
    }).text,
    'Departments\nWhich one?\n[Skin: Mon to Fri · Eyes]',
  );
});

test('a picture or a file at the head of such a message is kept with it', () => {
  const d = describe({
    templateMessage: {
      hydratedTemplate: {
        documentMessage: { mimetype: 'application/pdf', fileName: 'invoice.pdf', directPath: '/v/x', mediaKey: Buffer.from('k') },
        hydratedContentText: 'Your invoice is attached.',
      },
    },
  });
  assert.equal(d.type, 'document');
  assert.equal(d.text, 'Your invoice is attached.');
  assert.equal(d.media.fileName, 'invoice.pdf');
  assert.equal(d.media.dlType, 'document');
  assert.equal(
    describe({ interactiveMessage: { header: { imageMessage: { mimetype: 'image/jpeg' } }, body: { text: 'New menu' } } }).type,
    'image',
  );
});

test('what was chosen in answer is kept as the words on the button, with what it answers', () => {
  const ctx = { contextInfo: { stanzaId: 'Q1' } };
  assert.deepEqual(describe({ templateButtonReplyMessage: { selectedDisplayText: 'Confirm', selectedId: '1', ...ctx } }), {
    type: 'text',
    text: 'Confirm',
    quoted: 'Q1',
  });
  assert.equal(describe({ buttonsResponseMessage: { selectedDisplayText: 'Yes', selectedButtonId: 'y' } }).text, 'Yes');
  assert.equal(describe({ listResponseMessage: { title: 'Skin', singleSelectReply: { selectedRowId: 'r1' } } }).text, 'Skin');
  assert.equal(describe({ interactiveResponseMessage: { body: { text: 'Track it' } } }).text, 'Track it');
  assert.equal(describe({ buttonsResponseMessage: { selectedButtonId: 'y' } }), null, 'only an id: nothing to read');
});

test('an invitation, a product and an order are kept as what they say', () => {
  assert.equal(
    describe({ groupInviteMessage: { groupName: 'Book club', caption: 'Join us' } }).text,
    'Invitation to the group "Book club"\nJoin us',
  );
  assert.equal(
    describe({ productMessage: { product: { title: 'Blue chair', description: 'Oak' }, body: 'As asked' } }).text,
    'Blue chair\nOak\nAs asked',
  );
  assert.equal(describe({ orderMessage: { orderTitle: 'Order 7', message: '2 items' } }).text, 'Order 7\n2 items');
});

test('a kind that is not kept is named, unless it is known to say nothing', () => {
  assert.equal(unkept({ requestPaymentMessage: { noteMessage: {} } }), 'requestPaymentMessage');
  assert.equal(unkept({ reactionMessage: { text: '👍' } }), null);
  assert.equal(unkept({ protocolMessage: { type: 0 } }), null);
  assert.equal(unkept({ conversation: 'hello' }), null, 'one that is kept');
  assert.equal(unkept({ templateMessage: {} }), 'templateMessage', 'one of a kept kind that could not be read');
  assert.equal(unkept(null), null);
});

test('a session the encryption library prints is not printed: what it says is, its keys are not', async () => {
  const { hushSessions } = await import('../plugins/wa/hush.js');
  const out = [];
  const con = { info: (...a) => out.push(['info', ...a]), warn: (...a) => out.push(['warn', ...a]) };
  hushSessions(con);
  const session = { currentRatchet: { ephemeralKeyPair: { privKey: Buffer.from('secret') }, rootKey: Buffer.from('root') } };
  con.info('Closing session:', session);
  con.warn('Session already closed', session);
  con.warn('Closing open session in favor of incoming prekey bundle');
  const failed = new Error('could not decrypt');
  con.warn('odd:', failed, 3);
  assert.deepEqual(out, [
    ['info', 'Closing session:'],
    ['warn', 'Session already closed'],
    ['warn', 'Closing open session in favor of incoming prekey bundle'],
    ['warn', 'odd:', failed, 3],
  ]);
});
