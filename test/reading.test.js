// How the files that come with messages are read is one setting for each kind of file: not
// at all, on this machine, by the model, or this machine first and the model when unsure.
// What can read on this machine is a plugin that says so; what the model can be given, its
// engine says.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { home } from './helpers.js';

const dir = home();
fs.mkdirSync(path.join(dir, 'user-plugins/ears'), { recursive: true });
fs.writeFileSync(
  path.join(dir, 'user-plugins/ears/plugin.js'),
  `export default { api: 1, name: 'ears', title: 'Ears', description: 'listens, for the tests',
  commands: { hello: { summary: 'says hello', access: 'allow', run: () => 'hello' } },
  fileReaders: [{ kind: 'voice', read: async () => ({ text: 'hello', seconds: 1 }) }] };`,
);
// One that says it cannot listen just now (what it needs is not installed): it is passed over.
fs.mkdirSync(path.join(dir, 'user-plugins/mute'), { recursive: true });
fs.writeFileSync(
  path.join(dir, 'user-plugins/mute/plugin.js'),
  `export default { api: 1, name: 'mute', title: 'Mute', description: 'cannot listen, for the tests',
  commands: { hello: { summary: 'says hello', access: 'allow', run: () => 'hello' } },
  fileReaders: [{ kind: 'voice', ready: () => false, read: async () => ({ text: 'never' }), stop: async () => { globalThis.muteStopped = true; } }] };`,
);
const { save, load } = await import('../src/config.js');
save({ plugins: { enabled: ['mute', 'ears'], disabled: ['voice', 'ocr', 'docs'] } });
const { loadPlugins, problems } = await import('../src/plugins/registry.js');
await loadPlugins();
const R = await import('../src/archive/reading.js');

test('each kind is read by this machine first and the model when unsure, until chosen otherwise', () => {
  assert.deepEqual(R.reading('voice'), { mode: 'both', level: null });
  assert.deepEqual(R.reading('pictures'), { mode: 'both', level: 60 });
  assert.deepEqual(R.reading('documents'), { mode: 'both', level: 90 });
  R.setReading('pictures', { mode: 'local' });
  R.setReading('pictures', { level: 75 });
  assert.deepEqual(R.reading('pictures'), { mode: 'local', level: 75 }, 'one is changed without the other');
  assert.deepEqual(R.reading('documents'), { mode: 'both', level: 90 }, 'and the other kinds are left');
  assert.throws(() => R.setReading('pictures', { mode: 'sometimes' }), /a mode is one of: off, local, model, both/);
  assert.throws(() => R.setReading('pictures', { level: 140 }), /a whole number from 0 to 100/);
  assert.throws(() => R.setReading('videos', { mode: 'off' }), /not a kind of file that is read/);
});

test('by what a kind is read follows the mode and what is there to read it', () => {
  // here: a plugin that listens, and a model that takes pictures and documents but not audio
  assert.equal(R.localReader('voice').plugin.name, 'ears', 'one that cannot listen just now is passed over');
  assert.equal(R.localReader('pictures'), null);
  assert.equal(R.modelTakes('voice'), false);
  assert.equal(R.modelTakes('pictures'), true);
  assert.deepEqual(R.ways('voice'), { local: true, model: false });
  R.setReading('voice', { mode: 'model' });
  assert.deepEqual(R.ways('voice'), { local: false, model: false }, 'the model cannot take audio: nothing listens');
  assert.equal(R.reads('voice'), false);
  R.setReading('voice', { mode: 'local' });
  assert.deepEqual(R.ways('voice'), { local: true, model: false });
  R.setReading('voice', { mode: 'off' });
  assert.equal(R.reads('voice'), false);
  R.setReading('pictures', { mode: 'both' });
  assert.deepEqual(
    R.ways('pictures'),
    { local: false, model: false },
    'nothing here reads pictures: they are not handed to the model unasked',
  );
  R.setReading('pictures', { mode: 'model' });
  assert.deepEqual(R.ways('pictures'), { local: false, model: true }, 'by the model, when that is what was chosen');
  R.setReading('pictures', { mode: 'local' });
  assert.equal(R.reads('pictures'), false);
});

test('an installation that had voice notes switched off, from before there were modes, still has', () => {
  save({ ...load(), archive: { voiceNotes: false } });
  assert.equal(R.reading('voice').mode, 'off');
  assert.equal(R.reading('pictures').mode, 'both');
  R.setReading('voice', { mode: 'local' });
  assert.deepEqual(load().archive, { reading: { voice: { mode: 'local' } } }, 'and the old switch is gone once it is set anew');
});

test('a reader in a manifest names a kind there is and has something that reads', () => {
  const base = {
    api: 1,
    name: 'eyes',
    title: 'Eyes',
    description: 'reads',
    commands: { hello: { summary: 'says hello', access: 'allow', run: () => 'hello' } },
  };
  const validate = (m) => problems(m, 'eyes');
  assert.deepEqual(validate({ ...base, fileReaders: [{ kind: 'pictures', read: async () => ({}) }] }), []);
  assert.match(
    validate({ ...base, fileReaders: [{ kind: 'smells', read: async () => ({}) }] }).join('\n'),
    /fileReaders\[\]\.kind is one of: voice, pictures, documents/,
  );
  assert.match(validate({ ...base, fileReaders: [{ kind: 'pictures' }] }).join('\n'), /fileReaders\.pictures\.read must be a function/);
  assert.match(validate({ ...base, fileReaders: [{ kind: 'pictures', read: async () => ({}), reed: 1 }] }).join('\n'), /reed/);
});

test('what listens to voice notes as they are read is the same one: one that cannot is not asked, nor told to let go', async () => {
  const { doneHearing } = await import('../src/archive/attachments.js');
  await doneHearing();
  assert.equal(globalThis.muteStopped, undefined);
});
