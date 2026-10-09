// Playing a file from Home Assistant's media folder on a speaker: finding the file by a few
// words of its name, the volume, and what the agent may do. Against a stand-in for Home
// Assistant that notes what it is asked to do: no real speaker is involved.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { after, test } from 'node:test';
import { home } from './helpers.js';
import { haServer } from './support/ha-server.js';

const dir = home();
process.env.HOME = dir;
const root = new URL('..', import.meta.url).pathname;
const ha = await haServer();
after(() => ha.close());
const { save } = await import('../src/config.js');
save({ plugins: { enabled: ['ha'], settings: { ha: { url: ha.url, free: true } } } });
const reg = await import('../src/plugins/registry.js');
await reg.loadPlugins();
const plugin = reg.findLoaded('ha');
const owner = reg.makeCtx(plugin, { caller: 'owner' });
owner.secrets.set('token', ha.token);
// The home, as the nightly sync would have left it. Two things are called "Master Bedroom
// speaker" (as in a real home with the same speaker added twice); one of them is gone.
const E = (id, name, area, extra = {}) => ({ id, name, area, domain: id.split('.')[0], available: true, ...extra });
owner.store.set('catalogue', {
  location: 'Home',
  areas: [
    { id: 'bed', name: 'Master Bedroom' },
    { id: 'living', name: 'Living Room' },
  ],
  entities: [
    E('media_player.master_bedroom_speaker_3', 'Master Bedroom speaker', 'bed', { available: false }),
    E('media_player.master_bedroom_speaker', 'Master Bedroom speaker', 'bed'),
    E('media_player.living_room_tv', 'Living Room TV', 'living'),
    E('light.bedroom_lamp', 'Bedroom lamp', 'bed'),
    E('lock.front_door', 'Front door', null),
  ],
});
const mod = await import('../plugins/ha/plugin.js');
mod.wait.settle = 0;
mod.wait.volume = 0;
const cmd = (name, input, ctx = owner) => plugin.manifest.commands[name].run(ctx, input);
const fails = (p, re) => assert.rejects(p, (e) => (assert.match(e.message, re), true));
const reset = () => {
  ha.calls.length = 0;
  Object.assign(ha.state, { volume: 0.6, playing: null, refuseVolumeWhenOff: false, cannotBrowse: [] });
};
const RAIN =
  'media-source://media_source/local/10 Hours Rain & Thunder ｜ Rainstorm Sounds for Sleep, Studying or Relaxation ｜ Nature White Noise.mp3';

test('the media folder is listed, folders and all, and found by words of a name', async () => {
  const all = await cmd('media', {});
  assert.deepEqual(
    all.data.media.map((m) => m.name),
    [
      '10 Hours Rain & Thunder ｜ Rainstorm Sounds for Sleep, Studying or Relaxation ｜ Nature White Noise',
      'Ocean Waves Relaxation 10 Hours ｜ Soothing Waves Crashing on Beach ｜ White Noise for Sleep',
      'Cozy Cabin Ambience - Rain and Fireplace Sounds at Night 8 Hours',
      'Creep (cover)',
    ],
  );
  assert.equal(all.data.media.at(-1).folder, 'Music');
  assert.match(all.text, /^4 in Home Assistant's media folder:\n {2}10 Hours Rain & Thunder/);
  assert.match(all.text, /Play one: bc ha play <speaker> --media/);
  // words in any order, whatever the case and the punctuation
  assert.deepEqual(
    (await cmd('media', { words: ['thunder', 'RAIN'] })).data.media.map((m) => m.name.slice(0, 23)),
    ['10 Hours Rain & Thunder'],
  );
  assert.equal((await cmd('media', { words: ['rain'] })).data.media.length, 2, 'the rainstorm and the cabin');
  assert.equal((await cmd('media', { words: ['music', 'creep'] })).data.media.length, 1, "a folder's name counts");
  assert.match(
    (await cmd('media', { words: ['whale', 'song'] })).text,
    /Nothing in the media folder has "whale song" in its name\. There are 4/,
  );
  // listing asks nothing of a speaker but the list
  assert.deepEqual(ha.calls, []);
});

test("only what is in Home Assistant's own media folder is offered: never an address of somewhere else", async () => {
  const all = await cmd('media', {});
  assert.ok(!JSON.stringify(all).includes('elsewhere'));
  await fails(
    cmd('play', { name: ['master', 'bedroom', 'speaker'], media: 'stream elsewhere' }),
    /Nothing in Home Assistant's media folder has "stream elsewhere"/,
  );
  assert.deepEqual(ha.calls, []);
});

test('play a file on a speaker at a volume: the volume is set first, then that file is played, on the speaker that is there', async () => {
  reset();
  const r = await cmd('play', { name: ['master', 'bedroom', 'speaker'], media: 'rain thunder', volume: '30' });
  assert.deepEqual(
    ha.calls,
    [
      ['media_player.volume_set', { entity_id: 'media_player.master_bedroom_speaker', volume_level: 0.3 }],
      [
        'media_player.play_media',
        { entity_id: 'media_player.master_bedroom_speaker', media_content_id: RAIN, media_content_type: 'audio/mpeg' },
      ],
    ],
    'of the two with that name, the one that is reachable',
  );
  assert.match(
    r.text,
    /^Playing "10 Hours Rain & Thunder ｜ .* White Noise" on Master Bedroom speaker \(Master Bedroom\): playing · .* · volume 30%$/,
  );
  assert.deepEqual(
    [r.data.entity, r.data.action, r.data.volume, r.data.state],
    ['media_player.master_bedroom_speaker', 'play', 30, 'playing'],
  );
});

test('a speaker that will not take a volume while it is off is given it straight after it starts', async () => {
  reset();
  ha.state.refuseVolumeWhenOff = true;
  await cmd('play', { name: ['master', 'bedroom', 'speaker'], media: 'ocean', volume: '20' });
  assert.deepEqual(
    ha.calls.map((c) => c[0]),
    ['media_player.volume_set', 'media_player.play_media', 'media_player.volume_set'],
  );
  assert.equal(ha.state.volume, 0.2);
});

test('which file is meant is settled before anything is done to the speaker', async () => {
  reset();
  await fails(
    cmd('play', { name: ['master', 'bedroom', 'speaker'], media: 'rain', volume: '30' }),
    /"rain" could be 2 files: "10 Hours Rain & Thunder .*", "Cozy Cabin Ambience .*"\. Give more of the name\./,
  );
  await fails(
    cmd('play', { name: ['master', 'bedroom', 'speaker'], media: 'whale song', volume: '30' }),
    /Nothing in Home Assistant's media folder has "whale song"/,
  );
  await fails(cmd('play', { name: ['master', 'bedroom', 'speaker'], media: 'ocean', volume: '300' }), /--volume is a number from 0 to 100/);
  // (asked by the agent, a name that is not there is not looked for again in Home Assistant)
  const agent = reg.makeCtx(plugin, { caller: 'agent' });
  await fails(cmd('play', { name: ['kitchen', 'speaker'], media: 'ocean' }, agent), /Nothing here is called "kitchen speaker"/);
  await fails(
    cmd('play', { name: ['bedroom', 'lamp'], media: 'ocean' }, agent),
    /Nothing here is called "bedroom lamp" that this can be done to/,
  );
  assert.deepEqual(ha.calls, [], 'not the volume, not a pause: nothing');
  // a file's whole name means that file, even when its words are in another's too
  await cmd('play', { name: ['living', 'room', 'tv'], media: 'Creep (cover)' });
  assert.equal(ha.calls.at(-1)[1].media_content_id, 'media-source://media_source/local/Music/Creep (cover).mp3');
});

test('without a file, play carries on with what was playing; pause and stop do as they say', async () => {
  reset();
  await cmd('play', { name: ['master', 'bedroom', 'speaker'] });
  await cmd('pause', { name: ['master', 'bedroom', 'speaker'] });
  await cmd('stop', { name: ['master', 'bedroom', 'speaker'] });
  assert.deepEqual(ha.calls, [
    ['media_player.media_play', { entity_id: 'media_player.master_bedroom_speaker' }],
    ['media_player.media_pause', { entity_id: 'media_player.master_bedroom_speaker' }],
    ['media_player.media_stop', { entity_id: 'media_player.master_bedroom_speaker' }],
  ]);
});

test('a speaker that cannot list media is not a dead end: the list is asked of another', async () => {
  reset();
  ha.state.cannotBrowse = ['media_player.master_bedroom_speaker'];
  await cmd('play', { name: ['master', 'bedroom', 'speaker'], media: 'ocean waves' });
  assert.deepEqual(
    ha.calls.map((c) => [c[0], c[1].entity_id]),
    [['media_player.play_media', 'media_player.master_bedroom_speaker']],
    'listed through the TV, played on the speaker',
  );
  assert.equal((await cmd('media', { words: ['ocean'] })).data.media.length, 1);
});

test('typed as a command: the words of the speaker, then the options', async () => {
  reset();
  const out = await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [`${root}bin/bc.js`, 'ha', 'play', 'master', 'bedroom', 'speaker', '--media', 'rain thunder', '--volume', '30', '--json'],
      { env: process.env },
    );
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('close', () => resolve(stdout));
  });
  const d = JSON.parse(out);
  assert.deepEqual([d.entity, d.volume, d.media.slice(0, 23)], ['media_player.master_bedroom_speaker', 30, '10 Hours Rain & Thunder']);
  assert.deepEqual(
    ha.calls.map((c) => c[0]),
    ['media_player.volume_set', 'media_player.play_media'],
  );
});

test('what the agent may do: list freely; play on a speaker as it may switch one; and read help without asking', async () => {
  const { decide } = await import('../src/agent/policy.js');
  const act = (command) => decide('Bash', { command }).action;
  assert.equal(act('blackcat ha media rain --json'), 'allow');
  // a speaker is one of the things the owner let it switch by itself (`free`), and playing is no more than that
  assert.equal(act('blackcat ha play master bedroom speaker --media "rain thunder" --volume 30 --json'), 'allow');
  assert.equal(act('blackcat ha pause master bedroom speaker --json'), 'allow');
  // when the owner chose to be asked for everything, it asks
  owner.config.set({ free: false });
  assert.equal(act('blackcat ha play master bedroom speaker --media "rain thunder" --volume 30 --json'), 'ask');
  owner.config.set({ free: true });
  // a name it cannot place is put to the owner, not guessed
  assert.equal(act('blackcat ha play kitchen speaker --media rain --json'), 'ask');
  // help: free to read, for the plugin and for one command, and only when it is nothing but help
  assert.equal(act('blackcat ha --help'), 'allow');
  assert.equal(act('blackcat ha play --help'), 'allow');
  assert.equal(act('blackcat ha setup --help'), 'allow', 'how a command is used, not the command');
  assert.equal(act('blackcat ha setup --url http://evil.example --help'), 'deny');
  assert.equal(act('blackcat ha lock front door --help extra'), 'ask');
  assert.equal(act('blackcat ha unlock front door'), 'ask');
});

test('the agent is told how to play a file, and that only the media folder can be played from', async () => {
  const { runtimePrompt } = await import('../src/channels/commands.js');
  const told = runtimePrompt({ surface: 'chat' });
  assert.match(told, /blackcat ha media \[words\] · play <speaker or TV> \[--media/);
  assert.match(told, /Only that folder can be played from: not a web address/);
});
