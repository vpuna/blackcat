import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import {
  agoShort as ago,
  ARCHIVE_DB as DB_PATH,
  archiveStats as stats,
  controlService,
  downloadedPath,
  duration,
  isInstalled,
  isoLocal as fmtTime,
  leaveWork,
  log,
  recordActivity,
  MEDIA_DIR,
  now,
  openArchive as open,
  openArchiveForWriting as openWrite,
  plural,
  prompts,
  QueryError,
  semantic,
  service,
  serviceCommands,
  show,
  sleep,
  sourceSql,
  withDb,
  asJson,
} from '../../src/api.js';

const { orExit } = await prompts();

const SERVICES = { wa: service('wa') };
import { AUTH_DIR, isPaired } from './paired.js';
import { openRequestsDb } from './requests.js';
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
// `ask: false`: the owner has already said to go ahead.
async function pauseService({ ask = true } = {}) {
  if (!(await serviceActive())) return false;
  const ok = !ask || orExit(await p.confirm({ message: 'The WhatsApp service is running. Stop it for now?' }));
  if (!ok) {
    p.cancel('It has to be stopped first.');
    process.exit(1);
  }
  await controlService('stop', 'wa');
  return true;
}

// Unlink this device from WhatsApp, so that it goes from the phone's linked devices too (with
// the service stopped). → whether WhatsApp could be reached to say so
async function unlinkHere() {
  let opened;
  const openedP = new Promise((r) => (opened = r));
  const { startService } = await import('./service.js');
  const c = startService({ logLevel: 'silent', onOpen: () => opened() });
  const connected = await Promise.race([openedP.then(() => true), sleep(30_000).then(() => false)]);
  if (connected) await c.logout();
  else await c.stop();
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  return connected;
}

// ---------- pair ----------

// `again`: the days of history, when linking again to fetch more of it (from bc wa select):
// the chats chosen stay as they are.
export async function pair({ again = null } = {}) {
  p.intro(pc.bgGreen(pc.black(again ? ' blackcat · WhatsApp, linking again ' : ' blackcat · WhatsApp pairing ')));
  // Asked at each link, No unless said otherwise. (Linking again from `select` was asked already.)
  if (again == null) {
    p.note(
      [
        'blackcat links as a WhatsApp Web-style device and only reads: it never sends',
        'a message, never marks one as read and never shows you as online.',
        '',
        'WhatsApp does not allow other apps to connect this way, and may restrict or',
        'ban an account linked like this. Bans usually follow bulk or automated',
        'sending, which blackcat does not do, but the risk is not zero.',
      ].join('\n'),
      'Before you link',
    );
    if (!orExit(await p.confirm({ message: 'You use this at your own risk. Link anyway?', initialValue: false }))) {
      p.outro('Nothing linked.');
      return;
    }
  }
  const wasRunning = await pauseService({ ask: !again });
  // If the wizard is abandoned part-way (Ctrl+C, an error), don't leave the service stopped.
  let resume = wasRunning;
  process.on('exit', () => {
    if (resume && isPaired()) spawnSync('blackcat', ['start', 'wa'], { stdio: 'ignore' });
  });

  if (isPaired()) {
    const ok =
      again != null ||
      orExit(await p.confirm({ message: 'Already linked. Unlink and link again? (Stored messages are kept.)', initialValue: false }));
    if (!ok) {
      if (wasRunning) await controlService('start', 'wa');
      p.outro(`Nothing changed. To change which chats are collected: ${pc.cyan('bc wa select')}`);
      return;
    }
    const s = p.spinner();
    s.start('Unlinking the old link');
    const reached = await unlinkHere();
    s.stop(
      reached
        ? 'Old link removed'
        : 'Old link removed here. Also remove the old blackcat (Mac OS) entry under Linked devices on your phone.',
    );
  }
  // Start clean: a half-finished attempt (e.g. an unused pairing code) would make WhatsApp
  // try to log in instead of offering a new link.
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });

  const w = waSettings();
  let days = again;
  if (days == null) {
    p.note(
      ['First choose how far back to fetch history. After linking you pick', 'all chats, or only the ones you want.'].join('\n'),
      'How this works',
    );
    days = await askDays(w.days ?? 30);
    // Until chats are picked, keep everything in range so there's something to pick from.
    saveWaSettings({ days, mode: null, lastMode: w.mode ?? w.lastMode ?? null });
  }

  const phone = orExit(
    await p.text({
      message: 'Your WhatsApp number with country code, for a link code (Enter to skip and just use the QR code)',
      placeholder: 'e.g. +351 912 345 678',
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
        `Receiving history · ${received} messages seen · ${kept} new${filled ? ` · ${filled} older messages completed` : ''} (${days} days back)${h.progress != null ? ` · ${Math.round(h.progress)}%` : ''}`,
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

  if (again == null) await selectChats({ standalone: false, days });
  // What the phone sent may not reach back far enough in every chat: each is topped up by the
  // service, which asks the phone for what is older, and sends the owner how it went.
  withDb(openRequestsDb, (db) => leaveWork(db, 'wa_requests', { days, chats: null }));

  const start = again != null || orExit(await p.confirm({ message: 'Run the service in the background now, and at every boot?' }));
  resume = false; // from here, the answer below decides
  if (start) {
    const { installServices } = await serviceCommands();
    await installServices(['wa'], { quiet: true });
  }
  p.log.info(
    pc.dim(`Chats that do not reach ${days} days back are topped up from your phone in the background; you are sent how it went.`),
  );
  recordActivity({
    kind: 'event',
    category: 'messages: wa',
    summary: `WhatsApp ${again != null ? 'linked again, to fetch history' : 'linked'}: ${kept} messages from the phone's history, ${days} days back; the chats short of that are topped up from the phone`,
    data: { again: again != null, days, kept },
  });
  p.outro(`Done. Try ${pc.cyan('bc wa status')} and ${pc.cyan('bc wa search <words>')}`);
  // Baileys leaves timers and caches behind after the socket closes, which would keep
  // the process alive after "Done". Everything is saved, so exit explicitly.
  process.exit(0);
}

export async function select() {
  await selectChats({ relink: (days) => pair({ again: days }) });
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
    const connected = await unlinkHere();
    s.stop(connected ? 'Unlinked' : 'Could not reach WhatsApp. Remove "Mac OS" under Linked devices on your phone.');
  }
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });

  if (isInstalled(SERVICES.wa)) {
    const { removeServices } = await serviceCommands();
    await removeServices(['wa']);
  }
  const wipe = orExit(await p.confirm({ message: 'Also delete the stored WhatsApp messages?', initialValue: false }));
  // Only WhatsApp's: the archive holds every source's messages.
  let deleted = 0;
  if (wipe && fs.existsSync(DB_PATH))
    withDb(openWrite, (db) => {
      for (const [t, col] of [
        ['messages', 'chat_ref'],
        ['chats', 'ref'],
        ['contacts', 'ref'],
      ]) {
        const r = db.prepare(`DELETE FROM ${t} WHERE ${sourceSql(col, 'wa')}`).run();
        if (t === 'messages') deleted = r.changes;
      }
      db.prepare('DELETE FROM lid_map').run();
    });
  recordActivity({
    kind: 'event',
    category: 'messages: wa',
    summary: `WhatsApp unlinked; ${wipe ? `${plural(deleted, 'stored message')} deleted, as the owner chose` : 'its stored messages kept'}`,
    data: { deleted },
  });
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
      asJson({ paired, service: svc?.ActiveState ?? 'not installed', selection: { ...w, summary: describeSelection(w) }, archive: st }),
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
  row('collecting', pc.green('●'), `${describeSelection(w)} · everything stored is kept`);
  if (st) {
    const mb = (st.bytes / 1024 ** 2).toFixed(1);
    row('archive', pc.green('●'), `${st.messages} messages in ${plural(st.chats, 'chat')} · ${mb} MB`);
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
