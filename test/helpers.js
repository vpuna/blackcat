// Every test file runs in a process of its own (node --test does that), with blackcat
// pointed at an empty folder, so no test reads or changes the real installation.
//
// Service commands are the exception to "pointing elsewhere is enough": systemd units are
// per user, not per folder. So PATH is put in front with stand-ins for systemctl, loginctl
// and claude that do nothing (claude answers a reader's question with "nothing found"), and a test can never start, stop or rewrite a live service.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A stand-in for `claude` is signed in, unless a test is about one that is not.
export const SIGNED_IN = `[ "$1" = auth ] && { echo '{"loggedIn":true,"authMethod":"test"}'; exit 0; }\n`;

const FAKES = {
  systemctl: '#!/bin/sh\necho "fake systemctl $*" >&2\nexit 0\n',
  loginctl: '#!/bin/sh\necho Linger=yes\nexit 0\n',
  sudo: '#!/bin/sh\necho "a test may not use sudo" >&2\nexit 1\n',
  claude: `#!/bin/sh\n${SIGNED_IN}exec ${process.execPath} ${new URL('./support/fake-reader.mjs', import.meta.url).pathname} "$@"\n`,
  journalctl: '#!/bin/sh\nexit 0\n',
};

// Call before importing anything from src/: config.js reads BLACKCAT_HOME when it is first loaded.
export function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackcat-test-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true, mode: 0o700 });
  const bin = path.join(dir, 'fake-bin');
  fs.mkdirSync(bin);
  for (const [name, body] of Object.entries(FAKES)) fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  process.env.BLACKCAT_HOME = dir;
  // (Where the unit that starts blackcat at boot would be written: never the real place.)
  process.env.BLACKCAT_UNIT_DIR = path.join(dir, 'units');
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Save an installation's settings, as a test wants them. `bot` is shorthand for a Telegram
// bot that is set up: { token, allow: [{ id, name }] } puts the token with the plugin's
// secrets and the rest in its settings, with the first account as the owner.
export async function setUp({ bot, ...config } = {}) {
  const { save } = await import('../src/config.js');
  const allow = bot?.allow ?? [];
  if (bot?.token) {
    const dir = path.join(process.env.BLACKCAT_HOME, 'data/plugins/tg-bot');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify({ token: bot.token }), { mode: 0o600 });
  }
  const mine = bot ? { allow, ...(allow[0] ? { owner: { chat: allow[0].id, name: allow[0].name } } : {}) } : null;
  save({
    ...config,
    ...(bot?.token && allow.length && !config.channel ? { channel: 'tg-bot' } : {}),
    plugins: {
      ...config.plugins,
      settings: { ...config.plugins?.settings, ...(mine ? { 'tg-bot': { ...mine, ...config.plugins?.settings?.['tg-bot'] } } : {}) },
    },
  });
}
