// The Allsky plugin: an all-sky camera's pictures, fetched from its own web server by its
// address alone. The tests run it against a stand-in for that server.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { home } from './helpers.js';
import { allskyServer } from './support/allsky-server.js';

const dir = home();
process.env.HOME = dir;
const root = new URL('..', import.meta.url).pathname;
const { save, load } = await import('../src/config.js');
save({ plugins: { enabled: ['allsky'] } });
const reg = await import('../src/plugins/registry.js');
await reg.loadPlugins();
const api = await import('../plugins/allsky/api.js');
// (Not spawnSync: the stand-in camera is served by this very process, which must stay free to answer.)
const bc = (args) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [`${root}bin/bc.js`, ...args], { env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
const json = async (args) => JSON.parse((await bc([...args, '--json'])).stdout);
const MEDIA = path.join(dir, 'data/allsky-media');

// Two nights. Tonight is the one in progress; last night is complete, with everything made of it.
const now = new Date();
const at = (daysAgo, h, m = 0) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, h, m, 0);
const tonight = api.nightOf(now);
const lastNight = api.nightOf(new Date(now.getTime() - 24 * 3600_000));
const begins = (n) => new Date(Number(n.slice(0, 4)), Number(n.slice(4, 6)) - 1, Number(n.slice(6, 8)));
const inNight = (n, h, m = 0) => new Date(begins(n).getFullYear(), begins(n).getMonth(), begins(n).getDate() + (h < 12 ? 1 : 0), h, m, 0);
const cam = await allskyServer();
const locked = await allskyServer({ login: { user: 'sky', password: 'st4rs' } });
after(async () => {
  await cam.close();
  await locked.close();
});
for (const s of [cam, locked]) {
  s.latest('the sky right now', new Date(Date.now() - 2 * 60_000));
  s.night(
    lastNight,
    [inNight(lastNight, 21, 0), inNight(lastNight, 23, 30), inNight(lastNight, 2, 15), inNight(lastNight, 2, 45), inNight(lastNight, 5, 0)],
    { startrails: true, keogram: true, timelapse: 'a small video' },
  );
  s.night(tonight, [new Date(Date.now() - 30 * 60_000), new Date(Date.now() - 2 * 60_000)]);
  s.settings({
    exposure: 30000,
    gain: 200,
    latitude: '25.2N',
    remotepassword: 'do-not-show',
    apikey: 'nor-this',
    username: 'nor-this-either',
  });
}
void at;

test('how a night is named: for the day it began', async () => {
  assert.equal(api.nightOf(new Date(2026, 9, 5, 2, 0)), '20261004', '02:00 on the 5th is the night of the 4th');
  assert.equal(api.nightOf(new Date(2026, 9, 4, 21, 0)), '20261004');
  assert.equal(api.nightOf(new Date(2026, 9, 5, 13, 0)), '20261005', "from noon it is the next night's folder");
  const noon = new Date(2026, 9, 5, 15, 0);
  assert.equal(api.parseNight('2026-10-04', noon), '20261004');
  assert.equal(api.parseNight('20261004', noon), '20261004');
  assert.equal(api.parseNight('tonight', noon), '20261005');
  assert.equal(api.parseNight('yesterday', noon), '20261004');
  assert.equal(api.parseNight('last', noon), null);
  assert.equal(api.parseNight(undefined, noon), null);
  assert.throws(() => api.parseNight('last tuesday', noon), /is not a night/);
  assert.throws(() => api.parseNight('2026-13-40', noon), /is not a night/);
  // a time: within a named night the small hours are the next day; without one, the last time it was that time
  assert.deepEqual(api.parseMoment('02:30', '20261004'), new Date(2026, 9, 5, 2, 30));
  assert.deepEqual(api.parseMoment('23:00', '20261004'), new Date(2026, 9, 4, 23, 0));
  assert.deepEqual(api.parseMoment('14:00', null, noon), new Date(2026, 9, 5, 14, 0));
  assert.deepEqual(api.parseMoment('16:00', null, noon), new Date(2026, 9, 4, 16, 0), 'it has not been 16:00 yet today');
  assert.deepEqual(api.parseMoment('230', null, noon), new Date(2026, 9, 5, 2, 30));
  assert.throws(() => api.parseMoment('25:00'), /is not a time/);
  assert.throws(() => api.parseMoment('soon'), /is not a time/);
  assert.deepEqual(api.takenAt('image-20261005021530.jpg'), new Date(2026, 9, 5, 2, 15, 30));
  assert.equal(api.takenAt('thumbnail-20261004.jpg'), null);
  assert.equal(
    api.closest(['image-20261005021530.jpg', 'image-20261005024500.jpg', 'allsky-20261004.mp4'], new Date(2026, 9, 5, 2, 40)).name,
    'image-20261005024500.jpg',
  );
});

test('not set up: it says so, and says how', async () => {
  const r = await bc(['allsky', 'now']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Allsky is not set up yet\. Run: bc allsky setup/);
  assert.match((await bc(['allsky', 'status'])).stdout, /not set up → bc allsky setup/);
});

test('setup: the address is tried before it is saved', async () => {
  let r = await bc(['allsky', 'setup', '--url', 'http://127.0.0.1:1', '--user', '', '--max-mb', '50', '--stale-min', '10']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Could not reach Allsky at http:\/\/127\.0\.0\.1:1/);
  assert.equal(load().plugins.settings?.allsky, undefined, 'nothing was saved');
  r = await bc(['allsky', 'setup', '--url', 'not an address', '--user', '', '--max-mb', '50', '--stale-min', '10']);
  assert.match(r.stderr, /url: Like http:\/\/192\.168\.1\.30/);
  r = await bc(['allsky', 'setup', '--url', `${cam.url}/`, '--user', '', '--max-mb', '50', '--stale-min', '10']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(
    r.stdout,
    new RegExp(`^Connected to Allsky at ${cam.url}\\.\\nIts latest picture is \\d min old\\.\\nIt has 2 nights, from `),
  );
  assert.deepEqual(load().plugins.settings.allsky, { url: cam.url, maxMb: 50, staleMin: 10 });
  assert.match((await bc(['allsky', 'status'])).stdout, /taking pictures · the latest is \d min old/);
});

test('the sky now: fetched to the one folder the agent may read, with when it was taken', async () => {
  const d = await json(['allsky', 'now']);
  assert.equal(d.path, path.join(MEDIA, 'now.jpg'));
  assert.equal(fs.readFileSync(d.path, 'utf8'), 'the sky right now');
  assert.equal(d.stale, false);
  assert.match(d.caption, /^The sky at \d\d:\d\d$/);
  assert.ok(d.ageSeconds >= 110 && d.ageSeconds <= 400);
  assert.equal(fs.statSync(d.path).mode & 0o077, 0, 'readable by this account only');
  assert.match(d.notice, /UNTRUSTED/, 'what comes from the camera is labelled as coming from outside');
});

test('the picture closest to a time: the last time it was that time, or on a named night', async () => {
  // 02:20 last night: of 02:15 and 02:45, the nearer
  const night = `${lastNight.slice(0, 4)}-${lastNight.slice(4, 6)}-${lastNight.slice(6, 8)}`;
  let d = await json(['allsky', 'at', '02:20', '--night', night]);
  assert.equal(fs.readFileSync(d.path, 'utf8'), `picture taken ${inNight(lastNight, 2, 15).toISOString()}`);
  assert.equal(d.path, path.join(MEDIA, 'at.jpg'));
  assert.equal(d.caption, `The sky at 02:15, night of ${night}`);
  assert.equal(d.offSeconds, 300);
  // a time the camera has nothing near: the closest is given, and it says so
  d = await json(['allsky', 'at', '08:30', '--night', night]);
  assert.match(
    d.caption,
    /^The sky at 05:00, night of .* \(the closest there is to 08:30: 4 h away, so the camera was not taking pictures then\)$/,
  );
  // `last` is the latest night there is; a night it does not have says which it has
  assert.equal((await json(['allsky', 'at', '23:00', '--night', 'yesterday'])).night, night);
  const none = await bc(['allsky', 'at', '23:00', '--night', '2020-01-01']);
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /Allsky has no pictures for the night of 2020-01-01 \(it has /);
  assert.match((await bc(['allsky', 'at', 'teatime'])).stderr, /"teatime" is not a time/);
});

test('what Allsky makes of a night: the latest night that has one, or a named night', async () => {
  const night = `${lastNight.slice(0, 4)}-${lastNight.slice(4, 6)}-${lastNight.slice(6, 8)}`;
  // tonight is in progress and has none yet: last night's are found
  let d = await json(['allsky', 'startrails']);
  assert.deepEqual([d.night, d.path, d.caption], [night, path.join(MEDIA, 'startrails.jpg'), `Star trails, night of ${night}`]);
  assert.equal(fs.readFileSync(d.path, 'utf8'), `star trails of ${lastNight}`);
  d = await json(['allsky', 'keogram', '--night', night]);
  assert.equal(fs.readFileSync(d.path, 'utf8'), `keogram of ${lastNight}`);
  d = await json(['allsky', 'timelapse']);
  assert.deepEqual([d.path, d.bytes, d.caption], [path.join(MEDIA, 'timelapse.mp4'), 13, `Timelapse, night of ${night}`]);
  const r = await bc(['allsky', 'startrails', '--night', 'tonight']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Allsky has no star trails for the night of .*See which nights there are: bc allsky nights/);
  const n = await json(['allsky', 'nights']);
  assert.deepEqual(n.nights, [`${tonight.slice(0, 4)}-${tonight.slice(4, 6)}-${tonight.slice(6, 8)}`, night]);
  assert.match((await bc(['allsky', 'nights'])).stdout, /2 nights \(named for the day each began\), latest first:\n.*\(tonight\)/);
});

test('a file larger than it is set to fetch is refused before it is fetched', async () => {
  cam.night(lastNight, [inNight(lastNight, 21, 0)], { timelapse: Buffer.alloc(3 * 1024 * 1024, 1) });
  await bc(['allsky', 'setup', '--url', cam.url, '--user', '', '--max-mb', '2', '--stale-min', '10']);
  fs.rmSync(path.join(MEDIA, 'timelapse.mp4'), { force: true });
  const r = await bc(['allsky', 'timelapse']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /It is 3\.0 MB, over the 2\.0 MB this is set to fetch \(bc allsky setup\)/);
  assert.ok(
    !fs.existsSync(path.join(MEDIA, 'timelapse.mp4')) && !fs.existsSync(path.join(MEDIA, 'timelapse.mp4.part')),
    'nothing was left behind',
  );
  await bc(['allsky', 'setup', '--url', cam.url, '--user', '', '--max-mb', '50', '--stale-min', '10']);
});

test("the camera's own settings can be read, without anything that looks like a login", async () => {
  const all = (await json(['allsky', 'camera'])).settings;
  assert.deepEqual(all, { exposure: 30000, gain: 200, latitude: '25.2N' });
  assert.equal((await bc(['allsky', 'camera', 'gain'])).stdout.trim(), 'gain: 200');
  assert.match((await bc(['allsky', 'camera', 'password'])).stderr, /no setting with "password" in its name/);
});

test('a camera that has stopped: status says so, `now` says the picture is old, and the check for a watch fails', async () => {
  cam.latest('the sky right now', new Date(Date.now() - 2 * 60_000));
  assert.match((await bc(['allsky', 'check'])).stdout, /^ok: the latest picture is \d min old/);
  assert.equal((await bc(['allsky', 'check', '--max-age', '1m'])).status, 1, 'a stricter limit, for one watch');
  cam.latest('an old sky', new Date(Date.now() - 3 * 3600_000));
  const r = await bc(['allsky', 'check']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Allsky's latest picture is 3 h old \(taken at \d\d:\d\d\): it has stopped taking pictures\./);
  assert.match((await bc(['allsky', 'status'])).stdout, /NOT TAKING PICTURES: the latest is 3 h old/);
  const d = await json(['allsky', 'now']);
  assert.equal(d.stale, true);
  assert.equal(d.caption, 'The latest picture is 3 h old: the camera may have stopped');
  assert.equal((await bc(['allsky', 'check', '--max-age', '4h'])).status, 0);
  cam.latest('the sky right now', new Date(Date.now() - 2 * 60_000));
});

test('a camera whose pictures ask for a login: the password is a secret, kept when setup is run again', async () => {
  // without one, it says what is wrong and nothing is saved over what works
  let r = await bc(['allsky', 'setup', '--url', locked.url, '--user', '', '--max-mb', '50', '--stale-min', '10']);
  assert.match(r.stderr, /asks for a login for \/current\/tmp\/image\.jpg\. Set it with: bc allsky setup/);
  assert.equal(load().plugins.settings.allsky.url, cam.url);
  // a password is never taken as an option, so it is put where setup would put it
  const ctx = reg.makeCtx(reg.findLoaded('allsky'), { caller: 'owner' });
  ctx.secrets.set('password', 'st4rs');
  r = await bc(['allsky', 'setup', '--url', locked.url, '--user', 'sky', '--max-mb', '50', '--stale-min', '10']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^Connected to Allsky at ${locked.url} as sky\\.`));
  assert.equal(ctx.secrets.get('password'), 'st4rs', 'left empty, the saved one was kept and used');
  assert.ok(!JSON.stringify(load()).includes('st4rs'), 'and it is not in the settings');
  assert.equal(fs.readFileSync((await json(['allsky', 'now'])).path, 'utf8'), 'the sky right now');
  assert.match((await bc(['allsky', 'settings'])).stdout, /stored secretly \(not shown\): password/);
  // a wrong password says so
  ctx.secrets.set('password', 'wrong');
  assert.match((await bc(['allsky', 'now'])).stderr, /asks for a login .* and did not accept the one that is saved/);
  // back to a camera that needs none: the password is not kept
  r = await bc(['allsky', 'setup', '--url', cam.url, '--user', '', '--max-mb', '50', '--stale-min', '10']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(ctx.secrets.has('password'), false);
  assert.equal(load().plugins.settings.allsky.user, undefined);
});

test('only what is in a folder is listed: nothing that leads up, out, or to another server', async () => {
  const c = api.client({ url: locked.url, user: 'sky', password: 'st4rs' });
  const names = await c.listing(`/images/${lastNight}/`);
  assert.ok(names.includes('startrails/') && names.some((n) => n.startsWith('image-')));
  for (const n of names) assert.doesNotMatch(n, /^\.|^\/|:\/\/|\?|passwd/);
  assert.ok(![...cam.hits, ...locked.hits].some((h) => /elsewhere|passwd|\.\./.test(h)));
});

test("what the agent may do: look freely; setting it up, and where it points, is the owner's", async () => {
  const { decide, openDataFolders } = await import('../src/agent/policy.js');
  for (const c of ['now', 'at 02:30', 'startrails --night last', 'keogram', 'timelapse', 'nights', 'camera gain', 'check'])
    assert.equal(decide('Bash', { command: `blackcat allsky ${c} --json` }).action, 'allow', c);
  assert.equal(decide('Bash', { command: 'blackcat allsky setup --url http://evil.example' }).action, 'deny');
  // its folder of fetched pictures is open to the agent; nothing else of its is
  assert.ok(openDataFolders().includes('allsky-media'));
  assert.notEqual(decide('Read', { file_path: path.join(MEDIA, 'now.jpg') }).action, 'deny');
  assert.equal(decide('Read', { file_path: path.join(dir, 'data/plugins/allsky/secrets.json') }).action, 'deny');
  assert.equal(decide('Bash', { command: `cat ${dir}/data/plugins/allsky/secrets.json` }).action, 'deny');
  assert.notEqual(decide('Bash', { command: `file ${MEDIA}/now.jpg` }).action, 'deny');
  const { sendable } = await import('../src/channels/files.js');
  assert.equal(sendable(path.join(MEDIA, 'now.jpg')), path.join(MEDIA, 'now.jpg'));
});

test('a plugin can open its own folder of pictures to the agent, and nothing else in the data folder', async () => {
  fs.mkdirSync(path.join(dir, 'user-plugins/greedy'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'user-plugins/greedy/plugin.js'),
    `
import path from 'node:path';
const DATA = ${JSON.stringify(path.join(dir, 'data'))};
export default { api: 1, name: 'greedy', title: 'Greedy', description: 'x', commands: { hello: { summary: 'x', access: 'allow', run: () => 'x' } },
  agent: { readDirs: () => [path.join(DATA, 'greedy-media'), path.join(DATA, 'plugins'), DATA, path.join(DATA, 'allsky-media', '..', 'plugins')] } };`,
  );
  const r = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    const { save, load } = await import(${JSON.stringify(`${root}src/config.js`)});
    const c = load(); c.plugins.enabled = ['allsky', 'greedy']; save(c);
    await (await import(${JSON.stringify(`${root}src/plugins/registry.js`)})).loadPlugins();
    const { decide, openDataFolders } = await import(${JSON.stringify(`${root}src/agent/policy.js`)});
    console.log(JSON.stringify({ open: openDataFolders(), own: decide('Read', { file_path: ${JSON.stringify(path.join(dir, 'data/greedy-media/a.jpg'))} }).action,
      secrets: decide('Read', { file_path: ${JSON.stringify(path.join(dir, 'data/plugins/allsky/secrets.json'))} }).action, config: decide('Bash', { command: 'cat ${dir}/data/config.json' }).action,
      other: decide('Bash', { command: 'cat ${dir}/data/plugins/x/secrets.json' }).action }));`,
    ],
    { encoding: 'utf8', env: process.env },
  );
  const d = JSON.parse(r.stdout);
  assert.deepEqual(d.open.sort(), ['allsky-media', 'archive-media', 'greedy-media', 'inbox', 'shortcut-files']);
  assert.deepEqual(
    [d.own, d.secrets, d.config, d.other],
    ['allow', 'deny', 'deny', 'deny'],
    'its own folder of pictures may be looked into; nothing else it named',
  );
});

test('the agent is told about the camera only when there is one, and the core knows nothing of Allsky', async () => {
  const { runtimePrompt } = await import('../src/channels/commands.js');
  const told = runtimePrompt({ surface: 'chat' });
  assert.match(told, /blackcat allsky now · at <HH:MM>/);
  assert.match(told, /A night is named for the day it BEGAN/);
  assert.doesNotMatch(told, /~\/allsky|allsky\/tmp|settings\.json/);
  const core = spawnSync('grep', ['-rli', 'allsky', `${root}src`, `${root}agent`, `${root}bin`], { encoding: 'utf8' }).stdout.trim();
  assert.equal(core, '', 'no file of the core mentions it');
});
