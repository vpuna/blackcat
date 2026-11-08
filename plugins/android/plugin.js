// Android devices (phones, tablets, TVs), on USB or the network, driven over adb: what is on a
// screen, and routines that go through an app the way a person would and stop before anything
// is booked, paid or sent, to ask the owner. Nothing here knows any app; what is particular to
// one is in its routines. Each device is paired under a name ("phone", "tv").

import { devices } from './device.js';
import { listDevices, loadRoutine, stateOf } from './routines.js';

import { MAX_PICTURES } from './pictures.js';

import { reach, MEDIA, kindOf, how } from './shared.js';
import { pair, unpair, listPaired, screen, test, adbAccess, adbRun, mode } from './pairing.js';
import { routines, show, add, remove, approve, run, check, tidy, MAX_WAIT_S } from './running.js';
import { learnCmd, editCmd } from './learning.js';

const ON = ['--on <device>', 'the paired device, by its name (when there are several)'];
const PICTURE = [
  '--picture <file>',
  `a picture of the app, such as its screen after the booking is made (up to ${MAX_PICTURES}): it says what to expect; taps are found on the device`,
  undefined,
  { many: true },
];

export default {
  api: 1,
  name: 'android',
  title: 'Android',
  description:
    'apps on Android phones and TVs, on USB or the network, gone through by routines that ask before anything is booked, paid or sent',
  commands: {
    pair: {
      summary: 'connect an Android device on USB or the network, name it, and put the screen reader on it',
      access: 'owner',
      interactive: true,
      options: [
        ['--name <name>', 'what to call it: phone, tv, …'],
        ['--address <host:port>', 'a device on the network, at this address'],
      ],
      run: pair,
    },
    unpair: { summary: 'forget a device, and take the screen reader off it', access: 'owner', usage: '[name]', run: unpair },
    devices: { summary: 'the paired devices, and whether each is connected', access: 'allow', untrusted: false, run: listPaired },
    screen: {
      summary: 'what a device shows now: its elements, and a picture',
      access: 'allow',
      options: [ON, ['--no-picture', 'only the list of elements']],
      sends: true,
      run: screen,
    },
    adb: {
      summary: "run an adb command on a device: bc android adb <device> shell '<command>'",
      raw: true,
      access: adbAccess,
      run: adbRun,
    },
    mode: {
      summary: 'what the agent may run with adb on a device: read, ask or full',
      access: 'owner',
      usage: '<name> <mode>',
      run: mode,
    },
    check: {
      summary: 'succeed only if an app is in front on a device, or its screen is on or off; --wait gives it time (made for checks)',
      access: 'allow',
      options: [
        ON,
        ['--app <app>', 'this app in front: a word of its package, or the package'],
        ['--screen <on|off>', 'its screen on or off'],
        ['--wait <seconds>', `look again each second for up to this long (up to ${MAX_WAIT_S})`],
      ],
      run: check,
    },
    test: {
      summary: 'whether each device is connected, allowed and charging',
      access: 'allow',
      untrusted: false,
      options: [ON],
      run: test,
    },
    list: { summary: 'the routines, whether each is approved, and how its last run went', access: 'allow', run: routines },
    show: {
      summary: 'one routine whole, or what is kept for an app (by its package); --json gives what add takes back',
      access: 'allow',
      usage: '<name>',
      run: show,
    },
    add: {
      summary: 'add or replace a routine, or what is kept for an app, from a file: a routine starts as a draft',
      access: 'owner',
      usage: '<file>',
      run: add,
    },
    learn: {
      summary:
        'make a routine from words: a model goes through the app step by step, stops before what books, pays or sends, then it is tried again and you approve it',
      access: 'owner',
      usage: '<name>',
      options: [
        ['--app <app>', 'the app: a word of its name, or its package'],
        [
          '--stop-at <button>',
          'the label of the button that books, buys, pays or sends: it stops at its screen, and it is pressed only on your word',
        ],
        ['--goal <words>', 'what to do, and where to stop, in plain words'],
        [
          '--set <name=value>',
          'a value it may type or choose, such as --set item="AA batteries"; each becomes a value of the routine',
          undefined,
          { many: true },
        ],
        PICTURE,
        ON,
        ['--step', 'ask before each step, with a picture of the screen, so you can watch it'],
      ],
      long: true,
      run: learnCmd,
    },
    edit: {
      summary:
        'change a routine in words (and pictures): in its steps, or by learning new steps in the app from where they go; then it is tried again and you approve it',
      // (The agent may, with the owner's word: what it changes is a draft until they approve it.)
      access: (ctx, tokens) => ({
        level: 'ask',
        once: true,
        describe: `change the routine "${tokens.find((t) => !t.startsWith('-')) ?? '?'}" on the device, and try it again`,
      }),
      usage: '<name>',
      options: [
        ['--change <words>', 'what to change, in plain words'],
        ['--set <name=value>', 'the values to go through it with, as for run', undefined, { many: true }],
        PICTURE,
        ON,
      ],
      long: true,
      run: editCmd,
    },
    remove: { summary: 'delete a routine', access: 'owner', usage: '<name>', run: remove },
    approve: {
      summary: 'let the agent run a routine that was run to its confirmation screen as it is now',
      access: 'owner',
      usage: '<name>',
      run: approve,
    },
    run: {
      summary: 'go through a routine on a device; it stops at its confirmation screen and asks you',
      usage: '<name>',
      options: [
        ON,
        ['--set <name=value>', 'a value the routine asks for, such as --set to="the airport"', undefined, { many: true }],
        ['--dry', 'stop at the confirmation screen and decline, by itself (to test a routine)'],
      ],
      long: true,
      changes: true,
      sends: true,
      access: (ctx, tokens) => {
        const name = tokens.find((t, k) => !t.startsWith('-') && !['--on', '--set'].includes(tokens[k - 1]));
        let r = null;
        try {
          r = loadRoutine(ctx, name);
        } catch {
          return { level: 'never', reason: `there is no usable routine called "${name}"` };
        }
        const where = r.device ? `the ${r.device}` : 'the device';
        const confirms = r.steps.at(-1).do === 'confirm';
        // A draft, tried (--dry): it acts on the device too, by steps nobody has looked over yet,
        // so the owner says yes first. Not tried, it is not run at all.
        if (stateOf(ctx, name, r) !== 'approved')
          return tokens.includes('--dry')
            ? {
                level: 'ask',
                once: true,
                describe: `try the draft routine "${name}" on ${where} (${confirms ? 'it stops at its confirmation screen and presses nothing' : 'it goes through all its steps'})`,
              }
            : { level: 'never', reason: `"${name}" is not approved: the owner approves it after trying it` };
        // Nothing is booked, paid or sent until the owner presses it on the facts read at that
        // moment; a routine without that step changes things on the device, so it asks.
        // (The same with --dry: one that stops there presses nothing either way, and one with no
        // such step changes things whether it is a try or not.)
        return confirms ? { level: 'allow' } : { level: 'ask', once: true, describe: `go through "${name}" on ${where}` };
      },
      run,
    },
  },
  status: async (ctx) => {
    const all = listDevices(ctx);
    if (!all.length) return 'nothing paired → bc android pair';
    const seen = await devices(ctx).catch(() => []);
    return all
      .map(
        (d) =>
          `${d.name} (${d.label}) ${seen.find((x) => x.serial === (d.address ?? d.serial))?.state === 'device' ? 'connected' : 'not connected'}`,
      )
      .join(' · ');
  },
  settings: (ctx) => ({
    devices:
      listDevices(ctx)
        .map((d) => `${d.name}: ${d.label}, ${how(d)}`)
        .join('; ') || 'none',
  }),
  jobs: [
    {
      id: 'tidy',
      every: '10m',
      summary: 'put back what a run cut off before its end left on a device: its screen kept on while charging',
      when: (ctx) => listDevices(ctx).length > 0,
      run: tidy,
    },
  ],

  selftest: (ctx) =>
    listDevices(ctx).map((d) => ({
      name: `${d.name} (${d.label})`,
      run: async () => {
        const dev = await reach(ctx, d);
        const bat = await dev.battery();
        const server = (await dev.serverAnswers()) ? 'its screen reader answers' : 'its screen reader starts with the next command';
        return `connected · ${server}${bat.battery ? ` · battery ${bat.level}%${bat.charging ? ', charging' : ', not charging'}` : ''}`;
      },
    })),
  agent: {
    fill: (ctx) => {
      const all = listDevices(ctx);
      return {
        ready: all.length > 0,
        devices: all.map((d) => `"${d.name}" (${d.label}, a ${kindOf(d)}, ${how(d)}; adb: ${d.mode})`).join(', '),
        several: all.length > 1,
      };
    },
    readDirs: () => [MEDIA],
  },
};
