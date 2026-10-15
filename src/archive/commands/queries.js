// The search and read commands: `bc msg …` covers every source, and `--source wa|tg|mail` pins it to one.
const handlers = () => import('./commands.js');
const call = (fn, source, pick) => async (_ctx, i) => {
  if (source) i.source = source;
  const h = await handlers();
  return h[fn](...pick(i), i, {});
};

const SOURCE = ['--source <which>', 'only one source, by its short name: wa (WhatsApp), tg (Telegram), or one a plugin adds (mail)'];
const JSON_NOTE = 'add --json for machine-readable output';

// Saving a copy somewhere else (-o) writes a file wherever asked, so that needs the owner.
const fileAccess = (_ctx, tokens) =>
  tokens.some((t) => t === '-o' || t.startsWith('--out'))
    ? { level: 'ask', describe: 'save a copy of a file from your messages to a path of its choosing' }
    : 'allow';

export function queryCommands(source) {
  const src = source ? [] : [SOURCE];
  return {
    chats: {
      summary: 'list chats, most recent activity first (50 per page)',
      access: 'allow',
      options: [
        ...src,
        ['-p, --page <n>', 'page number', '1'],
        ['-n, --limit <n>', 'chats per page', '50'],
        ['--since <time>', 'only chats active since, e.g. 7d'],
        ['--match <text>', 'only chats whose name contains this'],
        ['--all', 'also chats that are known but have no stored messages'],
      ],
      run: call('chats', source, () => []),
    },
    find: {
      summary: 'search by meaning as well as keywords; returns the matching bits of conversation',
      access: 'allow',
      usage: '<question...>',
      options: [
        ...src,
        ['--also <phrasing>', 'another way of saying it: synonyms, abbreviations, likely wording (repeatable)', [], { many: true }],
        ['--chat <name>', 'only in chats whose name contains this (or an id)'],
        ['--since <time>', 'only after, e.g. 7d or 2026-09-01'],
        ['--until <time>', 'only before'],
        ['-n, --limit <n>', 'max results', '8'],
      ],
      run: call('find', source, (i) => [i.question]),
    },
    search: {
      summary: 'keyword search across stored messages',
      access: 'allow',
      usage: '<words...>',
      options: [
        ...src,
        ['--chat <name>', 'only in chats whose name contains this (or an id)'],
        ['--from <name>', 'only from this sender ("me" for your own messages)'],
        ['--since <time>', 'only after, e.g. 7d or 2026-09-01'],
        ['--until <time>', 'only before'],
        ['--any', 'match any word instead of all words'],
        ['--sort <order>', 'relevance or time', 'relevance'],
        ['-n, --limit <n>', 'max results', '20'],
      ],
      run: call('search', source, (i) => [i.words]),
    },
    thread: {
      summary: 'read messages from one chat',
      access: 'allow',
      usage: '<chat>',
      options: [
        ...src,
        ['--around <id>', 'show the conversation around this message id'],
        ['-c, --context <n>', 'messages either side with --around', '10'],
        ['--last <n>', 'latest N messages', '30'],
        ['--since <time>', 'only after'],
        ['--until <time>', 'only before'],
      ],
      run: call('thread', source, (i) => [i.chat]),
    },
  };
}

export const fileCommands = {
  media: {
    summary: 'fetch a photo, video, voice note or document on demand (falls back to its thumbnail)',
    access: fileAccess,
    usage: '<messageId>',
    options: [
      ['--thumb', 'only the small thumbnail stored with the message (no download)'],
      ['-o, --out <file>', 'also copy the file here'],
    ],
    run: call('media', null, (i) => [i.messageId]),
  },
  preview: {
    summary: "a message's link preview: title, description, URL, thumbnail",
    access: fileAccess,
    usage: '<messageId>',
    options: [['-o, --out <file>', 'save the thumbnail JPEG here']],
    run: call('preview', null, (i) => [i.messageId]),
  },
};

export const HELP = `Times: 12h, 7d, 2w, 3m, or a date like 2026-09-01. ${JSON_NOTE[0].toUpperCase()}${JSON_NOTE.slice(1)}.`;
