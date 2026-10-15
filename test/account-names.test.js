// Mail accounts, calendars and ssh machines each have a name. A name already in use is asked
// about (replace that one, or another name), and any of them can be renamed. Renaming moves
// nothing: each is kept under a key that never changes, and only the name beside it changes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { home, setUp } from './helpers.js';

const dir = home();
const root = new URL('..', import.meta.url).pathname;
const plain = () => {
  const { FORCE_COLOR: _f, CLAUDECODE: _c, ...env } = process.env;
  return { ...env, NO_COLOR: '1' };
};
const bc = (...args) => {
  const r = spawnSync(process.execPath, [`${root}bin/bc.js`, ...args], { encoding: 'utf8', env: plain() });
  return { ...r, said: r.stdout + r.stderr };
};

await setUp({
  plugins: {
    enabled: ['ssh', 'shortcut', 'mail', 'calendar'],
    settings: {
      mail: { accounts: { av: { address: 'me@example.com', host: 'imap.example.com', days: 30 } } },
      calendar: { calendars: { family: { title: 'Family', added: 1 } } },
    },
  },
});

const NAME = /^[a-z][a-z0-9_-]{0,24}$/;
const opts = { what: 'machine', rule: NAME, ruleText: 'Lowercase letters', fail: (m) => assert.fail(m) };

test('the helpers: a name in use is asked about, a key is never reused, a rename only changes the name', async () => {
  const { accountKey, accountName, accountNameQuestions, chosenAccountName, freeAccountKey, renameAccount } =
    await import('../src/plugins/accounts.js');
  const all = { av: { name: 'work', address: 'a@x' }, home: { address: 'h@x' } };
  assert.equal(accountName(all, 'av'), 'work');
  assert.equal(accountName(all, 'home'), 'home');
  assert.equal(accountKey(all, 'work'), 'av');
  assert.equal(accountKey(all, 'av'), null, 'a key is not a name once the account is renamed');
  // a new account called "av" does not take the key of the one renamed away from it
  assert.equal(freeAccountKey(all, 'av'), 'av-2');
  assert.deepEqual(chosenAccountName(all, { name: 'av' }, assert.fail), { name: 'av', key: 'av-2', replacing: false });

  const fail = (m) => {
    throw new Error(m);
  };
  // a name in use: replace it, or another name, said up front or asked
  assert.throws(() => chosenAccountName(all, { name: 'Work' }, fail), /already one called "work"/);
  assert.deepEqual(chosenAccountName(all, { name: 'work', taken: 'replace' }, fail), { name: 'work', key: 'av', replacing: true });
  assert.deepEqual(chosenAccountName(all, { name: 'work', taken: 'other', otherName: 'office' }, fail), {
    name: 'office',
    key: 'office',
    replacing: false,
  });
  assert.throws(() => chosenAccountName(all, { name: 'work', taken: 'other', otherName: 'home' }, fail), /"home" is used too/);
  assert.throws(() => chosenAccountName(all, { name: 'work', taken: 'other' }, fail), /--other-name/);

  const [, taken, other] = accountNameQuestions({ ...opts, message: 'Name', all: () => all, describe: (a) => a.address });
  assert.equal(taken.when({ name: 'home' }), true);
  assert.equal(taken.when({ name: 'new' }), false);
  assert.equal(
    taken.message({ name: 'work' }),
    'There is already a machine called "work" (a@x). Replace it, or give this one another name?',
  );
  assert.equal(other.when({ name: 'work', taken: 'replace' }), false);
  assert.equal(other.validate('home', {}), '"home" is used too');
  assert.equal(other.validate('fresh', {}), undefined);

  // renamed: the key stays, the name changes; back to its key, the name beside it goes
  const r = renameAccount(all, 'home', 'house', { ...opts, fail });
  assert.equal(r.key, 'home');
  assert.deepEqual(r.all.home, { name: 'house', address: 'h@x' });
  assert.deepEqual(renameAccount(all, 'work', 'av', { ...opts, fail }).all.av, { address: 'a@x' });
  assert.throws(() => renameAccount(all, 'nope', 'x', { ...opts, fail }), /no machine called "nope"/);
  assert.throws(() => renameAccount(all, 'home', 'work', { ...opts, fail }), /already a machine called "work"/);
  assert.throws(() => renameAccount(all, 'home', 'Bad Name', { ...opts, fail }), /Lowercase/);
});

test('ssh: a name in use is asked about; a rename keeps the key and names what still says the old name', async () => {
  const add = (...more) => bc('ssh', 'add', '--host', '10.0.0.9', '--user', 'root', '--port', '22', '--mode', 'ask', ...more);
  assert.match(add('--name', 'box').said, /Added "box"/);
  const keys = path.join(dir, 'data/plugins/ssh/keys');
  const first = fs.readFileSync(path.join(keys, 'box.pub'), 'utf8');
  // the same name again, away from a terminal: the question is named
  const again = add('--name', 'box');
  assert.notEqual(again.status, 0);
  assert.match(again.said, /Missing: --taken/);
  assert.match(add('--name', 'box', '--taken', 'other', '--other-name', 'box2').said, /Added "box2"/);
  // replaced by another machine: a key of its own
  assert.match(
    bc('ssh', 'add', '--name', 'box', '--taken', 'replace', '--host', '10.0.0.10', '--user', 'root', '--port', '22', '--mode', 'read').said,
    /Replaced "box" \(was root@10\.0\.0\.9\) with root@10\.0\.0\.10/,
  );
  assert.notEqual(fs.readFileSync(path.join(keys, 'box.pub'), 'utf8'), first);

  // a shortcut that names it
  bc('shortcut', 'add', 'disk', '--run', "blackcat ssh run box 'df -h'");
  // and a check that runs something there
  const { withDb } = await import('../src/db.js');
  const { addCheck, openChecksDb } = await import('../src/checks/db.js');
  withDb(openChecksDb, (db) => addCheck(db, { chatId: 42, name: 'Box is up', command: 'blackcat ssh run box uptime' }));
  const renamed = bc('ssh', 'rename', 'box', 'nas');
  assert.match(renamed.said, /"box" is now called "nas"/);
  assert.match(renamed.said, /These still say "box"[^\n]*\n {2}shortcut \/disk/);
  assert.match(renamed.said, /\n {2}check \d+ "Box is up"/);
  assert.ok(fs.existsSync(path.join(keys, 'box')), 'the key file is where it was');
  const list = bc('ssh', 'list', '--json');
  assert.deepEqual(
    JSON.parse(list.stdout).hosts.map((h) => h.name),
    ['nas', 'box2'],
  );
  assert.match(bc('ssh', 'key', 'nas').stdout, /^ssh-ed25519 /);
  assert.match(bc('ssh', 'key', 'box').said, /No host called "box"/);
  assert.match(bc('ssh', 'rename', 'box2', 'nas').said, /already a machine called "nas"/);
  // a new machine called "box" gets a key of its own, not the renamed one's
  assert.match(add('--name', 'box').said, /Added "box"/);
  assert.ok(fs.existsSync(path.join(keys, 'box-2')));
  // removed by its name: its key file goes, and the line to delete is the one it was made with
  const gone = bc('ssh', 'remove', 'nas', '--sure');
  assert.match(gone.said, /Removed "nas"\. Also delete the blackcat-box line/);
  assert.ok(!fs.existsSync(path.join(keys, 'box')));
  assert.ok(fs.existsSync(path.join(keys, 'box-2')));
});

test('mail: a rename renames its chat and the watches that read it; it is reached by the new name only', async () => {
  const { openWrite, openRead } = await import('../src/archive/db.js');
  const wa = openWrite();
  wa.prepare("INSERT INTO chats (ref, name, is_group) VALUES ('mail:av', 'Mail: av', 1)").run();
  wa.close();
  const { addWatch, getWatch, openWatchDb } = await import('../src/watch/db.js');
  const db = openWatchDb();
  const w = addWatch(db, {
    chatId: 42,
    name: 'School',
    lookFor: 'school',
    sources: { chats: [{ ref: 'mail:av', name: 'Mail: av' }] },
    mode: 'digest',
  });

  const add = bc('mail', 'add', '--name', 'av', '--address', 'x@example.com', '--host', 'imap.example.com', '--days', '30');
  assert.match(add.said, /Missing: --taken/);

  const r = bc('mail', 'rename', 'av', 'work');
  assert.match(r.said, /"av" is now called "work"\. Its mail is the chat "Mail: work", in 1 watch too\./);
  const rd = openRead();
  assert.equal(rd.prepare("SELECT name FROM chats WHERE ref = 'mail:av'").pluck().get(), 'Mail: work');
  rd.close();
  assert.deepEqual(getWatch(db, w.id).sources.chats, [{ ref: 'mail:av', name: 'Mail: work' }]);
  db.close();
  assert.match(bc('mail', 'list').stdout, /^work: me@example\.com/);
  assert.equal(bc('mail', 'recent', '--account', 'work').status, 0);
  assert.match(bc('mail', 'recent', '--account', 'av').said, /no mail account called "av"/);

  // calendar too
  assert.match(bc('calendar', 'rename', 'family', 'kids').said, /"family" is now called "kids"/);
  assert.match(bc('calendar', 'list').stdout, /^kids: Family/);
  assert.match(bc('calendar', 'agenda', '--calendar', 'family').said, /no calendar called "family"/);
  assert.match(bc('calendar', 'add', '--name', 'kids').said, /Missing: --taken/);
  // removed by its new name: its saved address goes with it
  assert.match(bc('calendar', 'remove', 'kids').said, /Disconnected kids/);
  assert.match(bc('mail', 'remove', 'work').said, /Disconnected work/);
  assert.match(bc('mail', 'list').stdout, /No mail account/);
});

test('in the bot: /setup asks about a name in use, with buttons, and takes another name', async () => {
  const { desk, resetDesk, setCarrier, ui } = await import('../src/channels/desk.js');
  const { handleSetupText, installSetup } = await import('../src/channels/setup.js');
  const { loadPlugins } = await import('../src/plugins/registry.js');
  await loadPlugins();
  resetDesk();
  const said = [];
  setCarrier({
    can: { buttons: true, edit: true },
    label: 'a test',
    send: async (_chat, m) => (said.push({ text: m.text, buttons: m.actions?.flat().map((a) => a.label) ?? [] }), said.length),
    edit: async () => {},
    setActions: async () => {},
    remove: async () => {},
    toast: async () => {},
  });
  installSetup();
  ui.text(async (c, next) => ((await handleSetupText(c)) ? undefined : next()));
  const type = (text) => desk.text({ chat: 42, who: 'me', text });
  const tap = (id) => desk.action({ chat: 42, who: 'me', id, ref: said.length });
  const last = () => said.at(-1);

  await tap('ps:ssh:add');
  await type('box2');
  assert.match(last().text, /There is already a machine called "box2" \(root@10\.0\.0\.9\)\. Replace it, or give this one another name\?/);
  assert.deepEqual(last().buttons, ['give this one another name', 'replace the machine called by that name']);
  await tap('pf:0');
  assert.match(last().text, /Another name for this machine/);
  await type('box');
  assert.match(last().text, /"box" is used too/);
  await type('lab');
  await type('10.0.0.20');
  await type('root');
  await type('22');
  await tap('pf:1'); // ask
  assert.match(said.map((s) => s.text).join('\n'), /Added "lab" \(root@10\.0\.0\.20, mode: ask\)/);
});
