import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import {
  agoShort as ago,
  ARCHIVE_DB as DB_PATH,
  archiveStats as stats,
  downloadedPath,
  duration,
  isInstalled,
  isoLocal as fmtTime,
  log,
  MEDIA_DIR,
  now,
  openArchive as open,
  prompts,
  QueryError,
  semantic,
  service,
  serviceCommands,
  show,
  sleep,
  controlService,
} from '../../src/api.js';

const { orExit } = await prompts();

const SERVICES = { wa: service('wa') };
import { AUTH_DIR, isPaired } from './paired.js';
import { askDays, select as selectChats } from './select.js';
import { describeSelection, saveWaSettings, waSettings } from './settings.js';

// Commands print errors plainly (and as JSON with --json) instead of stack traces.
function query(fn) {
  return async (...args) => {
    const opts = args.at(-2) ?? {};
    try {
      await fn(...args);
    } catch (e) {
      if (!(e instanceof QueryError)) throw e;
      if (opts.json) console.log(JSON.stringify({ error: e.message }));
      else console.error(e.message);
      process.exit(1);
    }
  };
}

async function serviceActive() {
  return isInstalled(SERVICES.wa) && (await show(SERVICES.wa)).ActiveState === 'active';
}

// Only one connection per linked device: the service has to pause while we pair or unpair.
async function pauseService() {
  if (!(await serviceActive())) return false;
  const ok = orExit(await p.confirm({ message: 'The WhatsApp service is running. Stop it for now?' }));
  if (!ok) {
    p.cancel('It has to be stopped first.');
    process.exit(1);
  }
  await controlService('stop', 'wa');
  return true;
}

// ---------- pair ----------

export async function pair() {
  p.intro(pc.bgGreen(pc.black(' blackcat · WhatsApp pairing ')));
  const wasRunning = await pauseService();
  // If the wizard is abandoned part-way (Ctrl+C, an error), don't leave the service stopped.
  let resume = wasRunning;
  process.on('exit', () => {
    if (resume && isPaired()) spawnSync('blackcat', ['start', 'wa'], { stdio: 'ignore' });
  });

  if (isPaired()) {
    const again = orExit(await p.confirm({ message: 'Already linked. Unlink and link again from scratch?', initialValue: false }));
    if (!again) {
      if (wasRunning) await controlService('start', 'wa');
      p.outro(`Nothing changed. To change which chats are kept: ${pc.cyan('bc wa select')}`);
      return;
    }
    p.log.info('Old link removed. Also remove the old blackcat (Mac OS) entry under Linked devices on your phone.');
  }
  // Start clean: a half-finished attempt (e.g. an unused pairing code) would make WhatsApp
  // try to log in instead of offering a new link.
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });

  p.note(
    [
      'blackcat links as a WhatsApp Web-style device and only ever reads.',
      'It never sends messages or read receipts and never shows you as online.',
      '',
      'First choose how much history to keep. After linking you pick',
      'all chats, or only the ones you want.',
    ].join('\n'),
    'How this works',
  );

  const w = waSettings();
  const days = await askDays(w.days ?? 30);
  // Until chats are picked, keep everything in range so there's something to pick from.
  saveWaSettings({ days, mode: null, lastMode: w.mode ?? w.lastMode ?? null });

  const phone = orExit(
    await p.text({
      message: 'Your WhatsApp number with country code, for a link code (Enter to skip and just use the QR code)',
      placeholder: 'e.g. +971 50 123 4567',
      initialValue: w.phone ?? '',
      validate: (v) => {
        const d = (v ?? '').replace(/[\s()+-]/g, '');
        if (!d) return undefined;
        return /^[1-9]\d{7,14}$/.test(d) ? undefined : 'Digits only, starting with the country code (no leading 0)';
      },
    }),
  ).replace(/[\s()+-]/g, '');
  if (phone) saveWaSettings({ phone });

  let opened;
  const openedP = new Promise((r) => (opened = r));
  let batches = 0;
  let lastBatch = 0;
  let received = 0;
  let kept = 0;
  let filled = 0;
  let qrShown = 0;
  let failures = 0;
  let failed;
  const failedP = new Promise((r) => (failed = r));
  const s = p.spinner();
  s.start('Connecting to WhatsApp');

  const { startService } = await import('./service.js');

  const c = startService({
    logLevel: 'silent',
    // Before a QR code appears, repeated failures mean something is wrong: say so instead of retrying quietly.
    onClose: (code, message) => {
      if (qrShown) return;
      failures++;
      s.message(`Connecting to WhatsApp (attempt ${failures + 1}; last error ${code ?? '?'} ${message ?? ''})`);
      if (failures >= 3) failed(`${code ?? ''} ${message ?? 'connection failed'}`.trim());
    },
    // The socket is ready to link once the first QR arrives. Show it, and ask for a
    // link code too if we have a number: either one works.
    onQr: async (qr) => {
      if (!qrShown) s.stop('Connected');
      p.log.step(qrShown ? 'New QR code (the previous one expired):' : 'Option 1 · Scan this QR code');
      const { renderQr } = await import('./qr.js');
      console.log(`\n${renderQr(qr)}\n`);
      p.log.message('WhatsApp → Settings → Linked devices → Link a device, then point the camera at the code.');
      if (!qrShown && phone) {
        try {
          const code = await c.requestPairingCode(phone);
          const pretty = `${code.slice(0, 4)}-${code.slice(4)}`;
          p.note(
            [
              `     ${pc.bold(pc.green(pretty))}`,
              '',
              'WhatsApp → Settings → Linked devices → Link a device',
              '→ "Link with phone number instead" → type this code.',
            ].join('\n'),
            'Option 2 · Link code',
          );
        } catch (e) {
          p.log.warn(`Couldn't get a link code (${e.message}). Use the QR code.`);
        }
      }
      if (!qrShown) p.log.info(pc.dim('Waiting for you to link… (Ctrl+C to cancel)'));
      qrShown++;
    },
    onOpen: () => opened(),
    onHistory: (h) => {
      batches++;
      lastBatch = Date.now();
      received += h.messages;
      kept += h.stored;
      filled += h.filled;
      s.message(
        `Receiving history · ${received} messages seen · ${kept} new${filled ? ` · ${filled} older messages completed` : ''} (last ${days} days)${h.progress != null ? ` · ${Math.round(h.progress)}%` : ''}`,
      );
    },
  });

  const linked = await Promise.race([openedP.then(() => true), failedP.then((err) => err), sleep(5 * 60_000).then(() => false)]);
  if (linked !== true) {
    await c.stop();
    if (typeof linked === 'string') {
      s.error('Could not connect');
      p.cancel(
        `WhatsApp refused the connection (${linked}). Check this machine's internet, then run \`bc wa pair\` again. If it keeps happening, the WhatsApp library may need an update (npm update baileys).`,
      );
    } else {
      p.cancel('Not linked within 5 minutes. Run `bc wa pair` to try again.');
    }
    process.exit(1);
  }
  p.log.success('Linked!');

  // WhatsApp sends history in batches. Wait until it goes quiet.
  s.start('Waiting for your phone to send history');
  const openedAt = Date.now();
  for (;;) {
    await sleep(2000);
    const quietFor = Date.now() - (lastBatch || openedAt);
    if (batches && quietFor > 45_000) break;
    if (!batches && quietFor > 120_000) break;
    if (Date.now() - openedAt > 20 * 60_000) break;
  }
  // On a re-link most messages are already stored, so "new" can be 0 while previews still get filled in.
  s.stop(
    batches
      ? `History received · ${kept} new messages${filled ? ` · ${filled} older messages completed (senders, link previews)` : ''}`
      : 'No history arrived (new messages will still be collected)',
  );
  await c.stop();

  await selectChats({ standalone: false, days });

  const start = orExit(await p.confirm({ message: 'Run the service in the background now, and at every boot?' }));
  resume = false; // from here, the answer below decides
  if (start) {
    const { installServices } = await serviceCommands();
    await installServices(['wa'], { quiet: true });
  }
  p.outro(`Done. Try ${pc.cyan('bc wa status')} and ${pc.cyan('bc wa search <words>')}`);
  // Baileys leaves timers and caches behind after the socket closes, which would keep
  // the process alive after "Done". Everything is saved, so exit explicitly.
  process.exit(0);
}

export async function select() {
  await selectChats();
}

// ---------- run (the service) ----------

export async function run() {
  if (!isPaired()) {
    console.error('WhatsApp is not linked. Run `bc wa pair` first.');
    process.exit(3); // the unit won't restart on 3
  }
  log(`collecting: ${describeSelection()}`);
  const { startService } = await import('./service.js');
  const c = startService({
    log,
    // BLACKCAT_WA_LOG=trace logs every frame sent to WhatsApp (for audits).
    logLevel: process.env.BLACKCAT_WA_LOG || 'warn',
    onHistory: (h) => log(`history batch: ${h.messages} messages, ${h.stored} kept`),
    onLoggedOut: async () => {
      log('WhatsApp unlinked this device. Run `bc wa pair` to link again.');
      await c.stop();
      process.exit(3);
    },
  });
  const stop = async () => {
    await c.stop();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await c.ready;
}

// ---------- unpair ----------

export async function unpair() {
  p.intro(pc.bgGreen(pc.black(' blackcat · WhatsApp unlink ')));
  if (!isPaired() && !fs.existsSync(DB_PATH)) {
    p.outro('Nothing to remove.');
    return;
  }
  const ok = orExit(await p.confirm({ message: 'Unlink blackcat from WhatsApp?', initialValue: false }));
  if (!ok) return p.cancel('Nothing changed');

  await pauseService();
  if (isPaired()) {
    const s = p.spinner();
    s.start('Unlinking');
    let opened;
    const openedP = new Promise((r) => (opened = r));
    const { startService } = await import('./service.js');
    const c = startService({ logLevel: 'silent', onOpen: () => opened() });
    const connected = await Promise.race([openedP.then(() => true), sleep(30_000).then(() => false)]);
    if (connected) await c.logout();
    else await c.stop();
    s.stop(connected ? 'Unlinked' : 'Could not reach WhatsApp. Remove "Mac OS" under Linked devices on your phone.');
  }
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });

  if (isInstalled(SERVICES.wa)) {
    const { removeServices } = await serviceCommands();
    await removeServices(['wa']);
  }
  const wipe = orExit(await p.confirm({ message: 'Also delete the stored messages?', initialValue: false }));
  if (wipe) for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(f, { force: true });
  p.outro(wipe ? 'Unlinked and deleted.' : 'Unlinked. Stored messages are kept and still searchable.');
  process.exit(0); // see pair()
}

// ---------- status ----------

export const status = query(async (opts) => {
  const paired = isPaired();
  const svc = isInstalled(SERVICES.wa) ? await show(SERVICES.wa) : null;
  const st = fs.existsSync(DB_PATH) ? stats(open(), 'wa') : null;
  const w = waSettings();

  if (opts.json) {
    console.log(
      JSON.stringify(
        { paired, service: svc?.ActiveState ?? 'not installed', selection: { ...w, summary: describeSelection(w) }, archive: st },
        null,
        2,
      ),
    );
    return;
  }

  const row = (label, dot, text) => console.log(`  ${label.padEnd(11)}${dot} ${text}`);
  console.log(`\n${pc.bgGreen(pc.black(' blackcat · WhatsApp '))}\n`);
  row(
    'link',
    paired ? pc.green('●') : pc.dim('○'),
    paired ? `linked as +${(st?.meta.me ?? '').split(/[:@]/)[0]}` : pc.dim('not linked → bc wa pair'),
  );
  const conn = st?.meta.state;
  const connDot = conn === 'connected' ? pc.green('●') : conn === 'logged_out' ? pc.red('●') : pc.yellow('●');
  if (svc) {
    row(
      'service',
      svc.ActiveState === 'active' ? pc.green('●') : pc.red('●'),
      `${svc.ActiveState}${conn ? ` · WhatsApp ${conn}` : ''}${conn === 'connected' && st.meta.connected_at ? ` for ${duration(now() - Number(st.meta.connected_at))}` : ''}`,
    );
  } else {
    row('service', pc.dim('○'), pc.dim('not installed → bc service install wa'));
  }
  if (st?.meta.last_error && conn !== 'connected') row('last error', connDot, st.meta.last_error);
  row('keeping', pc.green('●'), describeSelection(w));
  if (st) {
    const mb = (st.bytes / 1024 ** 2).toFixed(1);
    row('archive', pc.green('●'), `${st.messages} messages in ${st.chats} chat${st.chats === 1 ? '' : 's'} · ${mb} MB`);
    if (st.messages) row('range', ' ', `${fmtTime(st.oldest)} → ${fmtTime(st.newest)}`);
    if (st.media.files) {
      const have = fs.existsSync(MEDIA_DIR) ? fs.readdirSync(MEDIA_DIR).filter((id) => downloadedPath(id)).length : 0;
      row(
        'media',
        ' ',
        `${st.media.files} files known · ${st.media.fetchable} downloadable on demand · ${st.media.thumbs} thumbnails stored · ${have} downloaded`,
      );
    }
    if (st.meta.last_message_at) row('latest', ' ', `new message stored ${ago(Number(st.meta.last_message_at))}`);
    const { indexStats } = await semantic();
    const ixs = indexStats();
    if (ixs?.model)
      row(
        'search',
        ' ',
        `meaning-based index: ${ixs.embedded}/${ixs.windows} conversation windows · ${ixs.model.split('/').pop()}${ixs.indexedAt ? ` · updated ${ago(ixs.indexedAt)}` : ''}`,
      );
    else row('search', ' ', pc.dim('meaning-based index not built yet → bc msg index'));
  }
  console.log();
});
