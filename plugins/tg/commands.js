import fs from 'node:fs';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import {
  agoShort as ago,
  ARCHIVE_DB as DB_PATH,
  archiveMeta as getMeta,
  archiveStats as stats,
  duration,
  isInstalled,
  isoLocal as fmtTime,
  log,
  openArchive as open,
  openArchiveForWriting as openWrite,
  prompts,
  service,
  serviceCommands,
  show,
  controlService,
  withDb,
} from '../../src/api.js';

const { orExit, askDays } = await prompts();

const SERVICES = { tg: service('tg') };
import { chatRef, displayName, kindOf } from './map.js';
import { BIG_GROUP, clearSession, describeTga, isLinked, isOwn, saveTgaSettings, tgaSettings, wanted, writeSession } from './paired.js';

const PAGE = 50;
const KIND_LABEL = { user: 'person', bot: 'bot', group: 'group', supergroup: 'group', channel: 'channel' };

async function serviceActive() {
  return isInstalled(SERVICES.tg) && (await show(SERVICES.tg)).ActiveState === 'active';
}

// Only one process may use the login at a time: the service pauses while we pair or unpair.
async function pauseService() {
  if (!(await serviceActive())) return false;
  await controlService('stop', 'tg');
  return true;
}

// Page through chats (most recent first), 50 at a time, keeping picks across pages.
async function pickChats(rows, preselected) {
  const chosen = new Set(preselected);
  let offset = 0;
  for (;;) {
    const page = rows.slice(offset, offset + PAGE);
    const picked = orExit(
      await p.multiselect({
        message: `Pick chats to keep · ${offset + 1}–${offset + page.length} of ${rows.length}, most recent first`,
        options: page.map((r) => ({
          value: r.ref,
          label: r.name ?? r.ref,
          hint: [KIND_LABEL[r.kind], r.members ? `${r.members} members` : null, ago(r.last)].filter(Boolean).join(' · '),
        })),
        initialValues: page.filter((r) => chosen.has(r.ref)).map((r) => r.ref),
        required: false,
        maxItems: 15,
      }),
    );
    for (const r of page) chosen.delete(r.ref);
    for (const j of picked) chosen.add(j);
    const nav = [{ value: 'done', label: `Done · ${chosen.size} chat${chosen.size === 1 ? '' : 's'} picked` }];
    if (offset + PAGE < rows.length) nav.push({ value: 'next', label: `Next ${Math.min(PAGE, rows.length - offset - PAGE)} chats` });
    if (offset > 0) nav.push({ value: 'prev', label: 'Previous page' });
    const go = nav.length === 1 ? 'done' : orExit(await p.select({ message: 'Next?', options: nav }));
    if (go === 'done') return [...chosen];
    offset += go === 'next' ? PAGE : -PAGE;
  }
}

// Ask what to collect. `rows` are the account's chats: { ref, name, kind, members, last }.
async function chooseWhat(rows, cur) {
  rows = rows.filter((r) => !isOwn(r.ref)); // blackcat's own bot is never offered
  const count = (k) => rows.filter((r) => (Array.isArray(k) ? k.includes(r.kind) : r.kind === k)).length;
  const big = rows.filter((r) => r.kind === 'supergroup' && (r.members ?? 0) > BIG_GROUP).length;

  const mode = orExit(
    await p.select({
      message: 'Which chats?',
      initialValue: cur.mode ?? 'all',
      options: [
        {
          value: 'all',
          label: `Private chats and groups (${count('user')} people, ${count(['group', 'supergroup']) - big} groups)`,
          hint: 'new ones are included automatically',
        },
        { value: 'selected', label: 'Only chats I pick', hint: 'most recent first, 50 per page' },
      ],
    }),
  );
  if (mode === 'selected') return { mode, chats: await pickChats(rows, cur.mode === 'selected' ? (cur.chats ?? []) : []), include: {} };

  // Plain yes/no questions: a tick-list is too easy to confirm without ticking anything.
  p.log.info('Three kinds of chat are normally left out because they are noisy. Include any?');
  const inc = cur.include ?? {};
  const include = {};
  const ask = async (key, label) => {
    if (orExit(await p.confirm({ message: label, initialValue: !!inc[key] }))) include[key] = true;
  };
  await ask('bots', `Other bots (${count('bot')})? blackcat's own bot is never collected`);
  await ask('channels', `Broadcast channels (${count('channel')})?`);
  await ask('big', `Large groups with over ${BIG_GROUP} members (${big})?`);
  return { mode, chats: [], include };
}

// ---------- pair ----------

export async function pair() {
  p.intro(pc.bgBlue(pc.black(' blackcat · Telegram account ')));
  const wasRunning = await pauseService();
  if (isLinked()) {
    const again = orExit(
      await p.confirm({ message: 'Your Telegram account is already linked. Log in again from scratch?', initialValue: false }),
    );
    if (!again) {
      if (wasRunning) await controlService('start', 'tg');
      p.outro(`Nothing changed. To change which chats are kept: ${pc.cyan('bc tg account select')}`);
      return;
    }
  }

  p.note(
    [
      'This logs blackcat in to YOUR Telegram account, like a second device, so it can',
      'read your chats. It only reads: it never sends, never marks anything read.',
      "Your chat with blackcat's own bot is never collected.",
      '',
      'You need API credentials first (once, 2 minutes):',
      `  1. Open ${pc.cyan('https://my.telegram.org')} and log in with your phone number`,
      '  2. "API development tools" → create an application (any name)',
      '  3. Copy the api_id (a number) and api_hash (a long string)',
    ].join('\n'),
    'How this works',
  );

  const cur = tgaSettings();
  const apiId = Number(
    orExit(
      await p.text({
        message: 'api_id',
        initialValue: cur.apiId ? String(cur.apiId) : '',
        validate: (v) => (/^\d{4,12}$/.test(v?.trim() ?? '') ? undefined : 'A number, from my.telegram.org'),
      }),
    ),
  );
  const apiHash =
    cur.apiHash && orExit(await p.confirm({ message: `Use the saved api_hash (…${cur.apiHash.slice(-4)})?` }))
      ? cur.apiHash
      : orExit(
          await p.password({
            message: 'api_hash',
            validate: (v) => (/^[a-f0-9]{32}$/i.test(v?.trim() ?? '') ? undefined : '32 letters and digits, from my.telegram.org'),
          }),
        ).trim();
  const phone = orExit(
    await p.text({
      message: 'Your Telegram phone number, with country code',
      placeholder: '+971 50 123 4567',
      initialValue: cur.phone ?? '',
      validate: (v) => (/^\+?[\d\s()-]{8,20}$/.test(v ?? '') ? undefined : 'Digits, starting with the country code'),
    }),
  ).replace(/[\s()-]/g, '');
  saveTgaSettings({ apiId, apiHash, phone });

  const { TelegramClient, utils } = await import('telegram');
  const { StringSession } = await import('telegram/sessions/index.js');
  const { Logger } = await import('telegram/extensions/index.js');
  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 5,
    deviceModel: 'blackcat (read-only)',
    appVersion: '0.1',
    baseLogger: new Logger('none'),
  });

  let errors = 0;
  try {
    await client.start({
      phoneNumber: async () => phone,
      phoneCode: async () =>
        orExit(
          await p.text({
            message: 'Telegram just sent you a login code (in the Telegram app, or by SMS). Enter it',
            validate: (v) => (/^\d{4,8}$/.test(v?.trim() ?? '') ? undefined : 'The digits of the code'),
          }),
        ).trim(),
      password: async (hint) =>
        orExit(await p.password({ message: `Your two-step verification password${hint ? ` (hint: ${hint})` : ''}` })),
      // Returning true gives up; a wrong code or password gets a few more tries first.
      onError: async (e) => {
        p.log.warn(e.errorMessage ?? e.message);
        return ++errors >= 4;
      },
    });
  } catch (e) {
    await client.disconnect().catch(() => {});
    p.cancel(`Could not log in: ${e.errorMessage ?? e.message}`);
    process.exit(1);
  }
  writeSession(client.session.save());
  const me = await client.getMe();
  p.log.success(`Logged in as ${pc.bold(displayName(me))}. It appears in Telegram under Settings → Devices as "blackcat (read-only)".`);

  // The chats on the account, to choose from. Names and kinds only; no messages yet.
  const s = p.spinner();
  s.start('Reading your chat list');
  const rows = [];
  for await (const d of client.iterDialogs({})) {
    if (!d.entity) continue;
    const ref = chatRef(String(utils.getPeerId(d.entity)));
    const kind = kindOf(d.entity);
    rows.push({
      ref,
      kind,
      name: d.entity.self ? 'Saved Messages' : displayName(d.entity),
      members: d.entity.participantsCount ?? null,
      last: d.date ?? 0,
    });
  }
  s.stop(`${rows.length} chats on the account`);
  await client.disconnect().catch(() => {});

  const days = await askDays(cur.days ?? 30);
  const what = await chooseWhat(rows, cur);
  const settings = saveTgaSettings({ days, ...what, exclude: cur.exclude ?? [] });
  const n = rows.filter((r) => wanted(r.ref, r.kind, r.members, settings)).length;
  p.log.success(`Collecting ${n} chats: ${describeTga(settings)}`);

  const start = orExit(await p.confirm({ message: 'Start collecting in the background now, and at every boot?' }));
  if (start) {
    const { installServices } = await serviceCommands();
    await installServices(['tg'], { quiet: true });
    p.log.info(pc.dim('History is fetched gently in the background. It can take several minutes.'));
  }
  p.outro(`Done. Watch progress with ${pc.cyan('bc tg account status')}, then try ${pc.cyan('bc msg search <words> --source tg')}`);
  process.exit(0);
}

// ---------- select ----------

export async function select() {
  p.intro(pc.bgBlue(pc.black(' blackcat · Telegram chats ')));
  if (!isLinked()) {
    p.cancel('Telegram is not linked. Run `bc tg account pair` first.');
    process.exit(1);
  }
  const cur = tgaSettings();
  const rows = withDb(open, (db) =>
    db
      .prepare(
        `SELECT ch.ref, COALESCE(ch.name, (SELECT name FROM contacts c WHERE c.ref = ch.ref)) AS name, i.kind, i.members, COALESCE(ch.last_ts, 0) AS last
    FROM chats ch JOIN chat_info i ON i.ref = ch.ref WHERE ch.ref >= 'tg:' AND ch.ref < 'tg;' ORDER BY last DESC`,
      )
      .all(),
  );
  if (!rows.length) {
    p.cancel('The service has not read your chat list yet. Start it (`bc start tg`) and try again in a minute.');
    process.exit(1);
  }
  const days = await askDays(cur.days ?? 30);
  const what = await chooseWhat(rows, cur);
  const next = { ...cur, days, ...what };
  const keep = new Set(rows.filter((r) => wanted(r.ref, r.kind, r.members, next)).map((r) => r.ref));
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;

  const list = [...keep].map((_, i) => `@c${i}`).join(', ') || "''";
  const params = Object.fromEntries([...keep].map((j, i) => [`c${i}`, j]));
  // Only ever Telegram rows.
  const where = `chat_ref >= 'tg:' AND chat_ref < 'tg;' AND (ts < @cutoff OR chat_ref NOT IN (${list}))`;
  const doomed = withDb(openWrite, (wdb) => wdb.prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${where}`).get({ ...params, cutoff }).n);
  const ok = orExit(
    await p.confirm({
      message: `Keep ${keep.size} chats, ${describeTga(next)}?${doomed ? ` ${doomed} stored Telegram messages outside this will be deleted.` : ''}`,
    }),
  );
  if (!ok) {
    p.cancel('Nothing changed');
    return;
  }
  saveTgaSettings({ days, ...what });
  withDb(openWrite, (wdb) => {
    wdb.prepare(`DELETE FROM messages WHERE ${where}`).run({ ...params, cutoff });
    // Chats that are newly included, or need older history, get fetched again.
    wdb.prepare(`UPDATE chat_info SET backfill_cutoff = NULL WHERE ref >= 'tg:' AND ref < 'tg;'`).run();
  });
  p.outro('Saved. The service applies it within a few seconds and fetches any missing history.');
}

// ---------- run (the service) ----------

export async function run() {
  if (!isLinked()) {
    console.error('Telegram is not linked. Run `bc tg account pair` first.');
    process.exit(3); // the unit won't restart on 3
  }
  const { connect, startTgService } = await import('./service.js');
  const client = await connect();
  await client.connect();
  if (!(await client.checkAuthorization())) {
    console.error('Telegram no longer accepts this login (it was ended from another device?). Run `bc tg account pair` again.');
    const { openArchiveForWriting: openWrite, setArchiveMeta: setMeta } = await import('../../src/api.js');
    withDb(openWrite, (mdb) => setMeta(mdb, { tg_state: 'logged_out' })); // so the agent service can tell the owner
    process.exit(3);
  }
  log(`collecting: ${describeTga()}`);
  const c = await startTgService({ client, log });
  const stop = async () => {
    await c.stop();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

// ---------- unpair ----------

export async function unpair() {
  p.intro(pc.bgBlue(pc.black(' blackcat · Telegram unlink ')));
  if (!isLinked() && !tgaSettings().apiId) {
    p.outro('Nothing to remove.');
    return;
  }
  const ok = orExit(await p.confirm({ message: 'Log blackcat out of your Telegram account?', initialValue: false }));
  if (!ok) return p.cancel('Nothing changed');
  await pauseService();
  if (isLinked()) {
    const s = p.spinner();
    s.start('Logging out');
    try {
      const { connect } = await import('./service.js');
      const { Api } = await import('telegram');
      const client = await connect();
      await client.connect();
      await client.invoke(new Api.auth.LogOut());
      await client.disconnect().catch(() => {});
      s.stop('Logged out');
    } catch (e) {
      s.error(`Could not reach Telegram (${e.message}). Remove "blackcat (read-only)" under Settings → Devices in Telegram.`);
    }
  }
  clearSession();
  if (isInstalled(SERVICES.tg)) {
    const { removeServices } = await serviceCommands();
    await removeServices(['tg']);
  }
  const wipe = orExit(await p.confirm({ message: 'Also delete the stored Telegram messages?', initialValue: false }));
  if (wipe && fs.existsSync(DB_PATH)) {
    withDb(openWrite, (db) => {
      for (const [t, col] of [
        ['messages', 'chat_ref'],
        ['chats', 'ref'],
        ['contacts', 'ref'],
        ['chat_info', 'ref'],
      ])
        db.prepare(`DELETE FROM ${t} WHERE ${col} >= 'tg:' AND ${col} < 'tg;'`).run();
      db.prepare("DELETE FROM meta WHERE key LIKE 'tg\\_%' ESCAPE '\\'").run();
    });
  }
  p.outro(wipe ? 'Logged out and deleted.' : 'Logged out. Stored messages are kept and still searchable.');
  process.exit(0);
}

// ---------- status ----------

export async function status(opts) {
  const linked = isLinked();
  const svc = isInstalled(SERVICES.tg) ? await show(SERVICES.tg) : null;
  const db = fs.existsSync(DB_PATH) ? open() : null;
  const st = db ? stats(db, 'tg') : null;
  const meta = db ? getMeta(db) : {};
  const s = tgaSettings();
  const pendingChats = db?.prepare("SELECT 1 FROM sqlite_master WHERE name = 'chat_info'").get()
    ? db.prepare("SELECT COUNT(*) AS n FROM chat_info WHERE ref >= 'tg:' AND ref < 'tg;'").get().n
    : 0;

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          linked,
          service: svc?.ActiveState ?? 'not installed',
          selection: { ...s, apiHash: undefined, summary: describeTga(s) },
          archive: st,
          backfill: meta.tg_backfill ?? null,
        },
        null,
        2,
      ),
    );
    return;
  }
  const row = (label, dot, text) => console.log(`  ${label.padEnd(11)}${dot} ${text}`);
  const nowS = Math.floor(Date.now() / 1000);
  console.log(`\n${pc.bgBlue(pc.black(' blackcat · Telegram account '))}\n`);
  row(
    'link',
    linked ? pc.green('●') : pc.dim('○'),
    linked ? `logged in${meta.tg_name ? ` as ${meta.tg_name}` : ''}` : pc.dim('not linked → bc tg account pair'),
  );
  if (svc) {
    const conn = meta.tg_state;
    row(
      'service',
      svc.ActiveState === 'active' ? pc.green('●') : pc.red('●'),
      `${svc.ActiveState}${conn ? ` · Telegram ${conn}` : ''}${conn === 'connected' && meta.tg_connected_at ? ` for ${duration(nowS - Number(meta.tg_connected_at))}` : ''}`,
    );
  } else row('service', pc.dim('○'), pc.dim('not installed → bc service install tg'));
  row('keeping', pc.green('●'), `${describeTga(s)} · never blackcat's own bot`);
  if (st) {
    row('archive', pc.green('●'), `${st.messages} messages in ${st.chats} chat${st.chats === 1 ? '' : 's'} · ${pendingChats} chats known`);
    if (st.messages) row('range', ' ', `${fmtTime(st.oldest)} → ${fmtTime(st.newest)}`);
    if (st.media.files) row('media', ' ', `${st.media.files} files known, downloadable on demand`);
    if (meta.tg_backfill)
      row(
        'history',
        ' ',
        /^done/.test(meta.tg_backfill)
          ? `fetched${meta.tg_backfill_at ? ` ${ago(Number(meta.tg_backfill_at))}` : ''}`
          : pc.yellow(`fetching, ${meta.tg_backfill} chats done`),
      );
    if (meta.tg_last_message_at) row('latest', ' ', `new message stored ${ago(Number(meta.tg_last_message_at))}`);
  }
  console.log();
}
